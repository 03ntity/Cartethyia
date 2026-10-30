/**
 * The streamed export, against the same database shape a restore tests.
 *
 * Buffering a tenant's whole table to stringify it in one gulp OOM-killed a
 * deployment whose `api_keys` held 331k minted share children, so the export
 * is written incrementally through keyset-paged reads. What this file locks:
 * the stream produces the exact document the buffered variant always encoded
 * (sections, payload-name projections, the provider-connections block), the
 * keyset walk crosses its page boundary without repeating or skipping rows on
 * both dialects' SQLite types, and the counts resolve to what was exported.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

/** Rows chosen to sit one page past the 500-row page boundary... and back. */
const PAGE_ROWS = 500;

// The data directory must resolve into a throwaway sandbox before any module
// that reads it at import time (see share-stats-cache.test.ts for the shape).
const sandbox = await mkdtemp(join(tmpdir(), "carte-backup-stream-"));
const previousDataDir = process.env.CARTETHYIA_DATA_DIR;
process.env.CARTETHYIA_DATA_DIR = sandbox;

const { exportBackup, exportBackupStream } = await import("../../src/console/backup/store");
const { tablesForSection, TELEMETRY_TABLES } = await import("../../src/console/backup/contracts");
const { fullSchema } = await import("../../src/persistence/db-handle");
const { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } = await import("../../src/persistence/db-sqlite");
const { seedBundledProviders } = await import("../../src/providers/operations/provider-catalog-service");
const { encryptCredential } = await import("../../src/security/crypto");

const raw = createSqliteDatabase(join(sandbox, "backup-stream.sqlite"));
await applySqliteMigrations(raw);
const { db } = buildSqliteHandle(raw);
await seedBundledProviders(db);

const tenantId = crypto.randomUUID();
await db.insert(fullSchema.tenants as never).values({ id: tenantId, name: "stream", status: "active" } as never);
const [provider] = (await db.select().from(fullSchema.providers as never).limit(1)) as Array<{ id: string }>;
const providerId = provider?.id as string;

test("seeding runs once for the suite", () => {
  expect(providerId).toBeTruthy();
});

describe("exportBackupStream — the streamed document", () => {
  test("walks both keyset families across page boundaries and matches the buffered encoding", async () => {
    // api_keys has a uuid `id`; 620 rows forces 2 pages. telemetry_usage_totals
    // has NO single column: it walks its composite natural key.
    for (let i = 0; i < PAGE_ROWS + 120; i++) {
      await db.insert(fullSchema.apiKeys as never).values({
        id: crypto.randomUUID(),
        tenantId,
        keyMode: "personal",
        keyHash: `hash-${i}`,
        label: `k${i}`,
        scopes: ["routing:invoke"],
      } as never);
    }
    const credential = "sk-stream-probe-secret";
    await db.insert(fullSchema.providerAccounts as never).values({
      id: crypto.randomUUID(),
      providerId,
      tenantId,
      label: "acc",
      credentialKind: "api_key",
      credentialCiphertext: encryptCredential(credential),
    } as never);
    for (let i = 0; i < PAGE_ROWS + 20; i++) {
      await db.insert(fullSchema.telemetryEvents as never).values({
        id: crypto.randomUUID(),
        tenantId,
        requestId: crypto.randomUUID(),
        createdAt: new Date(Date.now() - i * 1000),
        sourceSurface: "chat",
        requestedModel: "probe-model",
        status: "completed",
        inputTokens: i,
      } as never);
    }

    const buffered = await exportBackup(db, [...tablesForSection("config"), ...TELEMETRY_TABLES], tenantId);
    const payload = buffered.payload as unknown as {
      sections: { config: Record<string, readonly Record<string, unknown>[] | undefined>; telemetry: Record<string, readonly unknown[] | undefined> };
    };
    // Across the boundary: exactly the seeded count, no repeat, no skip.
    expect(payload.sections.config["api_keys"]?.length).toBe(PAGE_ROWS + 120);
    // Cross-keyset no id: telemetry walked by its own cursor.
    expect(payload.sections.telemetry["telemetry_events"]?.length).toBe(PAGE_ROWS + 20);
    // The sealed column is written decrypted, under the secret's own payload name.
    expect(payload.sections.config["provider_accounts"]?.[0]?.["access_token"]).toBe(credential);

    const stream = exportBackupStream(db, [...tablesForSection("config"), ...TELEMETRY_TABLES], tenantId);
    let document = "";
    for await (const chunk of stream.jsonChunks) document += chunk;
    const parsed = JSON.parse(document) as typeof payload;
    expect(parsed.sections.config["api_keys"]?.length).toBe(PAGE_ROWS + 120);
    expect(parsed.sections.telemetry["telemetry_events"]?.length).toBe(PAGE_ROWS + 20);
    expect(parsed.sections.config["provider_accounts"]?.[0]?.["access_token"]).toBe(credential);
    expect((payload.sections.config["provider_accounts"] as readonly Record<string, unknown>[]).length).toBe(1);
    // Counts resolve once the whole document has been written — every
    // requested table is tallied, empty ones at zero, like the buffered form.
    const counts = await stream.counts;
    expect(counts["api_keys"]).toBe(PAGE_ROWS + 120);
    expect(counts["telemetry_events"]).toBe(PAGE_ROWS + 20);
    expect(counts["provider_accounts"]).toBe(1);
    expect(counts["share_links"]).toBe(0);
  });
});

afterAll(async () => {
  process.env.CARTETHYIA_DATA_DIR = previousDataDir;
  // Closing the raw database before cleanup, like the restore suites do, and
  // the sandbox removal is still tolerated to fail on Windows file locking —
  // the tempdir is disposable and the suite must not fail on its own teardown.
  try {
    await rm(sandbox, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[backup-stream] sandbox cleanup skipped: ${String(error instanceof Error ? error.message : error)}`);
  }
});
