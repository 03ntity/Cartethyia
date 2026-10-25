/**
 * The transactional telemetry writer: `DrizzleTelemetryStore.insertEvents`.
 *
 * The previous shape charged usage aggregates FIRST, appended raw second, and
 * compensated with a negative transaction on append failure. Under retries and
 * cross-process races that could double-charge (aggregate committed, insert
 * retried) and the compensation itself was a second failure surface.
 *
 * The new contract: raw append first (the at-least-once mirror), then ONE
 * transaction — `ON CONFLICT (tenant_id, request_id) DO NOTHING` insert,
 * usage deltas computed from the rows actually inserted. These tests pin:
 *
 * - same batch twice → one event, one charge;
 * - two stores racing → one charge (the unique boundary arbitrates);
 * - DB failure after raw append commits nothing (recovered by reconcile);
 * - raw append failure commits nothing;
 * - duplicate ids within one batch dedupe;
 * - usage totals unchanged by re-inserts (backfill never double-charges).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { DrizzleTelemetryStore } from "../../src/persistence/stores/telemetry-store";
import { RawTelemetryEventWriter } from "../../src/observability/raw-event-writer";
import {
  telemetryEvents,
  telemetryUsageTotals,
  tenants,
  providerAccounts,
  apiKeys,
  providers,
} from "../../src/persistence/schema";
import { eq } from "drizzle-orm";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-telemetry-store-"));
  const sqlite = createSqliteDatabase(join(dir, "t.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "telemetry-store", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  await db.insert(providers).values({ id: "p" });
  const [account] = await db
    .insert(providerAccounts)
    .values({ providerId: "p", tenantId: tenant.id, label: "a", credentialKind: "api_key" })
    .returning({ id: providerAccounts.id });
  if (account === undefined) throw new Error("account insert returned no row");
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ tenantId: tenant.id, keyMode: "personal", keyHash: "hash-1", label: "k", scopes: ["routing:invoke"] })
    .returning({ id: apiKeys.id });
  if (apiKey === undefined) throw new Error("api key insert returned no row");

  const writer = new RawTelemetryEventWriter(join(dir, "raw"));
  const store = new DrizzleTelemetryStore(db, writer);
  return {
    dir,
    db,
    store,
    writer,
    tenantId: tenant.id,
    accountId: account.id,
    apiKeyId: apiKey.id,
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
      }
    },
  };
}

function eventRow(fx: {
  tenantId: string;
  accountId: string;
  apiKeyId: string;
}, overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    tenantId: fx.tenantId,
    requestId: crypto.randomUUID(),
    createdAt: new Date(),
    sourceSurface: "chat" as const,
    requestedModel: "p/m",
    clientName: "bun",
    status: "completed" as const,
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    accountId: fx.accountId,
    apiKeyId: fx.apiKeyId,
    ...overrides,
  };
}

async function accountTotal(fx: Awaited<ReturnType<typeof fixture>>): Promise<{ requests: number; inputTokens: number } | undefined> {
  const rows = await fx.db
    .select({ requests: telemetryUsageTotals.requests, inputTokens: telemetryUsageTotals.inputTokens })
    .from(telemetryUsageTotals)
    .where(eq(telemetryUsageTotals.entityId, fx.accountId));
  return rows[0];
}

describe("DrizzleTelemetryStore.insertEvents — transactional writer", () => {
  test("the same batch twice inserts one event and charges once", async () => {
    const fx = await fixture();
    try {
      const row = eventRow(fx);
      await fx.store.insertEvents([row]);
      await fx.store.insertEvents([row]);
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(1);
      const total = await accountTotal(fx);
      expect(total?.requests).toBe(1);
      expect(total?.inputTokens).toBe(10);
    } finally {
      fx.cleanup();
    }
  });

  test("two stores racing the same rows converge to one charge", async () => {
    const fx = await fixture();
    try {
      const row = eventRow(fx);
      const second = new DrizzleTelemetryStore(fx.db, fx.writer);
      // Both write concurrently; the unique boundary arbitrates.
      await Promise.all([fx.store.insertEvents([row]), second.insertEvents([row])]);
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(1);
      const total = await accountTotal(fx);
      expect(total?.requests).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("a raw append failure commits nothing and rejects the call", async () => {
    const fx = await fixture();
    try {
      const failing = new DrizzleTelemetryStore(fx.db, {
        append: async () => { throw new Error("raw append failed"); },
      } as unknown as RawTelemetryEventWriter);
      const row = eventRow(fx);
      await expect(failing.insertEvents([row])).rejects.toThrow("raw append failed");
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(0);
      const total = await accountTotal(fx);
      expect(total).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("a database failure after the raw append commits nothing", async () => {
    const fx = await fixture();
    try {
      const row = eventRow(fx);
      // Sabotage the events insert: drop the table so the transaction fails
      // after the raw append has already succeeded.
      const eventsTable = (fx.db as unknown as { $client: { run: (q: string) => void } }).$client;
      eventsTable.run('DROP TABLE "telemetry_events"');
      await expect(fx.store.insertEvents([row])).rejects.toThrow();
      // The raw file holds the line (at-least-once mirror); reconcile recovers.
      // Usage totals were never charged:
      const total = await accountTotal(fx);
      expect(total).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("duplicate ids within one batch dedupe to one row and one charge", async () => {
    const fx = await fixture();
    try {
      const id = crypto.randomUUID();
      const row = eventRow(fx, { id });
      const duplicate = eventRow(fx, { id });
      await fx.store.insertEvents([row, duplicate]);
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(1);
      const total = await accountTotal(fx);
      expect(total?.requests).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  test("usage totals are only charged for rows actually inserted", async () => {
    const fx = await fixture();
    try {
      const first = eventRow(fx);
      await fx.store.insertEvents([first]);
      // A second batch: one new row plus the already-inserted row.
      const second = eventRow(fx);
      await fx.store.insertEvents([second, first]);
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(2);
      const total = await accountTotal(fx);
      // Both new-row charges; the replayed row contributed nothing.
      expect(total?.requests).toBe(2);
      expect(total?.inputTokens).toBe(20);
    } finally {
      fx.cleanup();
    }
  });

  test("the raw file is written even when the SQL insert conflicts entirely", async () => {
    const fx = await fixture();
    try {
      const row = eventRow(fx);
      await fx.store.insertEvents([row]);
      // Re-insert through a fresh store: raw file gets a second copy (mirror),
      // SQL keeps one row.
      const second = new DrizzleTelemetryStore(fx.db, fx.writer);
      await second.insertEvents([row]);
      const { readdir, readFile } = await import("node:fs/promises");
      const rawDir = join(fx.dir, "raw");
      const files = await readdir(rawDir);
      expect(files).toHaveLength(1);
      const text = await readFile(join(rawDir, files[0]!), "utf8");
      expect(text.trim().split("\n")).toHaveLength(2);
      const events = await fx.db.select({ id: telemetryEvents.id }).from(telemetryEvents);
      expect(events).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });
});
