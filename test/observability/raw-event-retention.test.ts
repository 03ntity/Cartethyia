import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import { apiKeys, providerAccounts, providers, telemetryEvents, telemetryUsageTotals, tenants } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import { RawTelemetryEventWriter } from "../../src/observability/raw-event-writer";

const sandbox = await mkdtemp(join(tmpdir(), "carte-raw-events-"));
const previousDataDir = process.env.CARTETHYIA_DATA_DIR;
process.env.CARTETHYIA_DATA_DIR = sandbox;

const { TELEMETRY_EVENT_DIR, queryTelemetryEvents } = await import("../../src/observability/event-log");
const { DrizzleTelemetryStore } = await import("../../src/persistence/stores/telemetry-store");

const sqlite = createSqliteDatabase(join(sandbox, "test.sqlite"));
await applySqliteMigrations(sqlite);
const { db } = buildSqliteHandle(sqlite);
const [tenant] = await db.insert(tenants).values({ name: "raw event test", status: "active" }).returning({ id: tenants.id });
if (!tenant) throw new Error("raw event tenant insert returned no id");
const tenantId = tenant.id;
const store = new DrizzleTelemetryStore(db);

beforeEach(async () => {
  for (const name of await readdir(TELEMETRY_EVENT_DIR).catch(() => [])) {
    await rm(join(TELEMETRY_EVENT_DIR, name), { force: true });
  }
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
});

afterAll(async () => {
  sqlite.close();
  if (previousDataDir === undefined) delete process.env.CARTETHYIA_DATA_DIR;
  else process.env.CARTETHYIA_DATA_DIR = previousDataDir;
  await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

function event(overrides: Partial<typeof telemetryEvents.$inferInsert> = {}): typeof telemetryEvents.$inferInsert {
  return {
    id: crypto.randomUUID(),
    tenantId,
    requestId: crypto.randomUUID(),
    createdAt: new Date(),
    sourceSurface: "chat" as const,
    requestedModel: "test/model",
    reportedModel: null,
    requestedEffort: null,
    providerId: "test",
    accountId: null,
    networkPoolId: null,
    endpoint: "/v1/chat/completions",
    apiKeyId: null,
    userAgent: null,
    clientIp: null,
    latencyMs: 1,
    ttfbMs: null,
    stream: false,
    status: "completed",
    httpStatus: 200,
    errorOrigin: null,
    errorCategory: null,
    inputTokens: 1,
    cachedInputTokens: null,
    outputTokens: 1,
    reasoningTokens: null,
    estimatedCostUsd: null,
    creditUsed: null,
    resolveMs: null,
    tokensPerSec: null,
    firstContentDeltaAtMs: null,
    lastEventAtMs: null,
    ...overrides,
  };
}

test("the writer appends raw hourly JSONL and never writes a summary index", async () => {
  await store.insertEvents([event()]);
  const files = await readdir(TELEMETRY_EVENT_DIR);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-[0-9a-f-]{36}\.jsonl$/);
  expect(files.some((file) => file.includes("index") || file.includes("compacted"))).toBe(false);
  const rows = await queryTelemetryEvents({ tenantId });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.requestedModel).toBe("test/model");
  const raw = await readFile(join(TELEMETRY_EVENT_DIR, files[0]!), "utf8");
  expect(raw.trim().split("\n")).toHaveLength(1);
});

test("legacy daily raw logs remain readable but summaries are not events", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(join(TELEMETRY_EVENT_DIR, `${day}.events.jsonl`), `${JSON.stringify(event())}\n`);
  await writeFile(join(TELEMETRY_EVENT_DIR, `${day}.index.json`), JSON.stringify({ requests: 900 }));
  await writeFile(join(TELEMETRY_EVENT_DIR, `${day}.compacted.jsonl`), `${JSON.stringify({ requests: 900 })}\n`);
  const rows = await queryTelemetryEvents({ tenantId });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.requestedModel).toBe("test/model");
});

test("a retry after an append failure does not charge its aggregate twice", async () => {
  const providerId = `raw-writer-${crypto.randomUUID()}`;
  await db.insert(providers).values({ id: providerId, tenantId });
  const [account] = await db.insert(providerAccounts).values({
    providerId,
    tenantId,
    label: "raw-writer-test",
    credentialKind: "none",
  }).returning({ id: providerAccounts.id });
  if (!account) throw new Error("raw writer account insert returned no id");
  const [apiKey] = await db.insert(apiKeys).values({
    tenantId,
    label: "raw-writer-test",
    keyHash: crypto.randomUUID(),
    scopes: ["*"],
  }).returning({ id: apiKeys.id });
  if (!apiKey) throw new Error("raw writer api key insert returned no id");
  const directory = await mkdtemp(join(tmpdir(), "carte-raw-retry-"));
  let fail = true;
  const writer = new RawTelemetryEventWriter(directory, {
    open: async (path) => {
      if (fail) throw new Error("simulated append outage");
      return open(path, "r+").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return open(path, "w+");
      });
    },
  });
  const retrying = new DrizzleTelemetryStore(db, writer);
  const row = event({
    accountId: account.id,
    apiKeyId: apiKey.id,
    inputTokens: 11,
    outputTokens: 7,
    status: "failed",
    httpStatus: 500,
  });
  try {
    await expect(retrying.insertEvents([row])).rejects.toThrow("simulated append outage");
    fail = false;
    await retrying.insertEvents([row]);
    for (const [identityType, entityId] of [["account", account.id], ["api_key", apiKey.id]] as const) {
      const totals = await db.select().from(telemetryUsageTotals).where(and(
        eq(telemetryUsageTotals.identityType, identityType),
        eq(telemetryUsageTotals.entityId, entityId),
      ));
      expect(totals).toHaveLength(1);
      expect(totals[0]?.requests).toBe(1);
      expect(totals[0]?.errors).toBe(1);
      expect(totals[0]?.inputTokens).toBe(11);
      expect(totals[0]?.outputTokens).toBe(7);
    }
  } finally {
    await db.delete(apiKeys).where(eq(apiKeys.id, apiKey.id));
    await db.delete(providerAccounts).where(eq(providerAccounts.id, account.id));
    await db.delete(providers).where(eq(providers.id, providerId));
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Retention must delete only files whose hour is CLOSED.
 *
 * The current hour is still being appended to, and so is the previous one: a
 * batch flushed just after an hour boundary carries events stamped in the hour
 * that just ended, and the writer files them under that hour. With per-writer
 * files (`<hour>-<uuid>.jsonl`) a process can also still hold the previous
 * hour's file open. Deleting either would fail outright on Windows or unlink a
 * file another writer is mid-write on.
 */
test("prune deletes expired files but never the current or previous hour", async () => {
  const hourStamp = (offsetHours: number): string =>
    new Date(Date.now() - offsetHours * 3_600_000)
      .toISOString()
      .slice(0, 13)
      .replaceAll(":", "-");

  await writeFile(join(TELEMETRY_EVENT_DIR, `${hourStamp(0)}-a.jsonl`), "");
  await writeFile(join(TELEMETRY_EVENT_DIR, `${hourStamp(1)}-b.jsonl`), "");
  await writeFile(join(TELEMETRY_EVENT_DIR, `${hourStamp(5)}-c.jsonl`), "");
  await writeFile(join(TELEMETRY_EVENT_DIR, `${hourStamp(48)}-d.jsonl`), "");

  // A cutoff already in the past: the two open hours must survive it.
  await store.pruneTelemetry(new Date(Date.now() - 24 * 3_600_000));

  const files = await readdir(TELEMETRY_EVENT_DIR);
  expect(files.some((file) => file.endsWith("-a.jsonl"))).toBe(true);
  expect(files.some((file) => file.endsWith("-b.jsonl"))).toBe(true);
  expect(files.some((file) => file.endsWith("-c.jsonl"))).toBe(true);
  expect(files.some((file) => file.endsWith("-d.jsonl"))).toBe(false);
});
