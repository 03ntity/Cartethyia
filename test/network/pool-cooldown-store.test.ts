/**
 * The durable provider-cooldown mirror (`network_pools.provider_cooldowns`).
 *
 * The selector's cooldown map is process-local, so a restart dropped every
 * flag while the upstream kept refusing the egress — the operator saw no
 * cooldown badge anywhere and still received 429s, because dispatch re-picked
 * a pool it no longer remembered. The mirror is what makes the flag outlive
 * the flagging process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildSqliteHandle, applySqliteMigrations } from "../../src/persistence/db-sqlite";
import { networkPools, tenants } from "../../src/persistence/schema";
import { NetworkPoolSelector, PROVIDER_BLOCK_MS } from "../../src/network/pool/selector";
import {
  dropAllProviderCooldownMarkers,
  dropProviderCooldownMarker,
  restoreProviderCooldownMarkers,
  upsertProviderCooldownMarker,
} from "../../src/network/pool-cooldown-store";
import { flagPoolCooldown } from "../../src/network/pool-health";
import { GatewayError } from "../../src/protocol/gateway-error";
import { resetCooldownCacheForTests } from "../../src/config/cooldowns";

resetCooldownCacheForTests();
afterAll(resetCooldownCacheForTests);

const dirs: string[] = [];

async function bootedSqlite(): Promise<{ db: ReturnType<typeof buildSqliteHandle>["db"]; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-poolcool-"));
  dirs.push(dir);
  const db = new Database(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const handle = buildSqliteHandle(db);
  await handle.db.insert(tenants).values({
    id: "00000000-0000-0000-0000-0000000000aa",
    name: "pools",
    status: "active",
    // `tenants` timestamps default to PG `now()`, which the SQLite driver has
    // no function for; supply them explicitly like every SQLite write does.
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    db: handle.db,
    close: () => {
      try {
        db.close();
      } catch {
        // Windows holds the WAL past close; cleanup below ignores that.
      }
    },
  };
}

async function insertPool(db: ReturnType<typeof buildSqliteHandle>["db"], poolId: string): Promise<void> {
  await db.insert(networkPools).values({
    id: poolId,
    kind: "https",
    endpointConfig: { endpoint: "http://pool.example:8080" },
    // `network_pools.created_at` defaults to PG's `now()`, which the SQLite
    // driver has no function for; supply it, as production writes do.
    createdAt: new Date(),
    tenantId: "00000000-0000-0000-0000-0000000000aa",
  });
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the WAL open for a beat; a leftover temp dir is not
      // a failed test.
    }
  }
});

describe("the provider cooldown mirror", () => {
  test("flags persist on the row and boot restores them into the selector", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);

      await upsertProviderCooldownMarker(db, poolId, "OpenCode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });
      // A second provider's marker must survive the first's write.
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "Provider opencode rate limit",
      });

      const selector = new NetworkPoolSelector();
      const restored = await restoreProviderCooldownMarkers(selector, db);
      expect(restored).toBe(1);
      expect((await selector.isProviderCooldown(poolId, "opencode")).inCooldown).toBe(true);
      // And the restored state keeps the pool out of rotation.
      expect(await selector.tryAcquireAvailablePool([poolId], "opencode")).toBeUndefined();

      // The console listing (the badge source) reads the same selector state.
      const listing = await selector.getPoolCooldowns(poolId);
      expect(listing).toHaveLength(1);
      expect(listing[0]?.providerId).toBe("opencode");
    } finally {
      close();
    }
  });

  test("expired markers and unrelated pools are not resurrected", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() - 1,
        reason: "spent before the restart",
      });

      const selector = new NetworkPoolSelector();
      expect(await restoreProviderCooldownMarkers(selector, db)).toBe(0);
      expect((await selector.isProviderCooldown(poolId, "opencode")).inCooldown).toBe(false);
    } finally {
      close();
    }
  });

  test("dropping an orphan marker is a no-op, and drops only resolve", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      // No rows written anywhere: the pool id does not exist.
      await upsertProviderCooldownMarker(db, randomUUID(), "opencode", {
        until: Date.now() + 1000,
        reason: "x",
      });

      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + 60 * 60 * 1000,
        reason: "cooldown",
      });
      // A 429 probe must not release a cooldown it merely re-measured.
      await dropProviderCooldownMarker(db, poolId, "opencode", true);
      const [kept] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(kept?.providerCooldowns?.opencode?.reason).toBe("cooldown");

      await dropAllProviderCooldownMarkers(db, poolId);
      const [cleared] = await db
        .select({ providerCooldowns: networkPools.providerCooldowns })
        .from(networkPools);
      expect(cleared?.providerCooldowns ?? {}).toEqual({});
    } finally {
      close();
    }
  });
});

describe("dispatch flagging writes the mirror", () => {
  test("a provider-scoped 429 lands on the row for the next boot", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);

      const error = new GatewayError(
        "quota_exceeded",
        429,
        "free tier usage limit",
        // No `retryAfterMs`: upstream named no window, so the configured
        // fallback applies.
        {},
        "upstream",
      );

      flagPoolCooldown(new NetworkPoolSelector(), db, poolId, "opencode", error);
      // Fire-and-forget by design; give the mirror write a moment.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const selector = new NetworkPoolSelector();
      expect(await restoreProviderCooldownMarkers(selector, db)).toBe(1);
      const state = await selector.isProviderCooldown(poolId, "opencode");
      expect(state.inCooldown).toBe(true);
      // The measured window outlives the old 15-minute guess: an egress that
      // exhausted its allowance stays refused long past that.
      expect(state.resetsAt?.getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    } finally {
      close();
    }
  });

  test("a block marker restored at boot retires the egress", async () => {
    const { db, close } = await bootedSqlite();
    try {
      const poolId = randomUUID();
      await insertPool(db, poolId);
      await upsertProviderCooldownMarker(db, poolId, "opencode", {
        until: Date.now() + PROVIDER_BLOCK_MS,
        reason: "Upstream refused this egress address",
        blocked: true,
      });

      const selector = new NetworkPoolSelector();
      await restoreProviderCooldownMarkers(selector, db);
      const state = await selector.isProviderCooldown(poolId, "opencode");
      expect(state.blocked).toBe(true);
      expect(state.inCooldown).toBe(true);
    } finally {
      close();
    }
  });
});
