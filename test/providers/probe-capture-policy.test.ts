/**
 * Probe capture policy: the discovery probe resolves the tenant's capture
 * mode/depth/retention through the same `resolvePayloadCapture` path a
 * dispatched request uses.
 *
 * The probe used to collapse the tenant's choice into one boolean —
 * "capture on" — and then tee bodies at a flat cap: a tenant whose live
 * requests stored nothing (`none`) or stage-presence-only (`metadata`) had
 * probe frames with full bodies. These tests pin the resolved policy per mode
 * against a real migrated SQLite database.
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
import { consoleSettings, tenants } from "../../src/persistence/schema";
import { eq } from "drizzle-orm";
import { loadProbePreferences } from "../../src/providers/discovery/probe-phases";
import { DEFAULT_PAYLOAD_RETENTION_MS } from "../../src/observability/payload-capture";

async function fixture(preferences: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), "carte-probe-prefs-"));
  const sqlite = createSqliteDatabase(join(dir, "probe.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "probe-prefs", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  if (preferences !== null) {
    await db
      .insert(consoleSettings)
      .values({ tenantId: tenant.id, preferences: preferences as object });
  }
  return { db, sqlite, tenantId: tenant.id, cleanup: () => {
    try { sqlite.close(); } catch { /* already closed */ }
    // Best-effort on Windows: bun:sqlite's WAL/journal files can be held
    // briefly after close. The directory is under tmpdir, so an occasional
    // survivor costs nothing; assertions never depend on its removal.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
    }
  } };
}

async function load(db: Parameters<typeof loadProbePreferences>[0]["db"], tenantId: string) {
  return loadProbePreferences({
    db,
    tenantId,
    wireFamily: "chat",
    request: { modelId: "m", prompt: "hi" },
  });
}

describe("loadProbePreferences — capture policy per tenant mode", () => {
  test("a tenant with capture off resolves disabled/none", async () => {
    const { db, tenantId, cleanup } = await fixture({ telemetryPayloads: "none" });
    try {
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.enabled).toBe(false);
      expect(payloadCapture.mode).toBe("none");
    } finally {
      cleanup();
    }
  });

  test("a tenant with no preferences row resolves disabled/none", async () => {
    const { db, tenantId, cleanup } = await fixture(null);
    try {
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.enabled).toBe(false);
      expect(payloadCapture.mode).toBe("none");
    } finally {
      cleanup();
    }
  });

  test("a metadata tenant resolves enabled/metadata with the tenant's depth and retention", async () => {
    const { db, tenantId, cleanup } = await fixture({
      telemetryPayloads: "metadata",
      telemetryPayloadDepth: "moderate",
      telemetryWindowMinutes: 30,
    });
    try {
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.enabled).toBe(true);
      expect(payloadCapture.mode).toBe("metadata");
      expect(payloadCapture.depth).toBe("moderate");
      expect(payloadCapture.retentionMs).toBe(30 * 60_000);
    } finally {
      cleanup();
    }
  });

  test("a full tenant resolves enabled/full with the tenant's depth and retention", async () => {
    const { db, tenantId, cleanup } = await fixture({
      telemetryPayloads: "full",
      telemetryPayloadDepth: "maximum",
      telemetryWindowMinutes: 45,
    });
    try {
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.enabled).toBe(true);
      expect(payloadCapture.mode).toBe("full");
      expect(payloadCapture.depth).toBe("maximum");
      expect(payloadCapture.retentionMs).toBe(45 * 60_000);
    } finally {
      cleanup();
    }
  });

  test("unset depth and window fall back to minimum and the deployment default", async () => {
    const { db, tenantId, cleanup } = await fixture({ telemetryPayloads: "full" });
    try {
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.depth).toBe("minimum");
      // The deployment default, not a probe-specific one. Asserted against the
      // exported fallback rather than a literal so raising the default is a
      // policy change and not a test edit.
      expect(payloadCapture.retentionMs).toBe(DEFAULT_PAYLOAD_RETENTION_MS);
    } finally {
      cleanup();
    }
  });

  test("a preference row that vanishes mid-read fails closed", async () => {
    // Tenant with capture on, but the preferences row is deleted after the
    // settings read — resolvePayloadCapture re-reads and fails closed.
    const { db, tenantId, cleanup } = await fixture({ telemetryPayloads: "full" });
    try {
      await db.delete(consoleSettings).where(eq(consoleSettings.tenantId, tenantId));
      const { payloadCapture } = await load(db, tenantId);
      expect(payloadCapture.enabled).toBe(false);
      expect(payloadCapture.mode).toBe("none");
    } finally {
      cleanup();
    }
  });
});
