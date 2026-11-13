/**
 * `NetworkPoolSelector.tryAcquireAvailablePool` cooldown pre-check.
 *
 * Admission used to issue one Redis `GET` per eligible pool before scoring —
 * N round trips on the per-request hot path. It now reads every cooldown key
 * in a single `MGET` and resolves each row through the same batched-state path
 * the failure report uses. These tests pin the two properties that matter:
 *
 * - one `MGET` per admission, never a per-pool `GET` for cooldowns;
 * - a failed batch read falls back to per-pool `isProviderCooldown`, keeping
 *   the "cooldown store unavailable" fail-closed semantics.
 *
 * The fake Redis is minimal on purpose: `mget`, `get`, and `eval` (the admit /
 * release / cooldown scripts). A method the selector must not call — like a
 * blocking `KEYS` — is simply absent, so reaching for it throws.
 */
import { describe, expect, test } from "bun:test";
import type { RedisClient } from "../../src/persistence/redis";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import { COOLDOWN_CLEAR_SCRIPT, COOLDOWN_FLAG_SCRIPT, proxyCooldownKey } from "../../src/network/pool/scripts";

const POOL_A = "pool-a";
const POOL_B = "pool-b";
const POOL_C = "pool-c";
const PROVIDER = "opencode";

interface FakeRedis {
  readonly redis: RedisClient;
  readonly store: Map<string, string>;
  readonly mgetKeys: () => readonly (readonly string[])[];
  readonly getKeys: () => readonly string[];
  readonly setMgetError: (error: Error | undefined) => void;
}

/**
 * Minimal Redis double: string `GET`/`MGET`, plus `eval` covering the three
 * scripts admission can reach — pool admit (1 or 2 keys), pool release, and
 * cooldown flag/clear. `mget` can be armed to fail once to exercise the
 * per-pool fallback.
 */
function fakeRedis(initial: Record<string, string> = {}): FakeRedis {
  const store = new Map<string, string>(Object.entries(initial));
  const mgetCalls: string[][] = [];
  const getCalls: string[] = [];
  let mgetError: Error | undefined;

  const client = {
    mget: async (...keys: string[]) => {
      mgetCalls.push([...keys]);
      if (mgetError !== undefined) {
        const error = mgetError;
        mgetError = undefined;
        throw error;
      }
      return keys.map((key) => store.get(key) ?? null);
    },
    get: async (key: string) => {
      getCalls.push(key);
      return store.get(key) ?? null;
    },
    eval: async (script: string, numKeys: number, ...keysAndArgs: (string | number)[]) => {
      const keys = keysAndArgs.slice(0, numKeys).map(String);
      const args = keysAndArgs.slice(numKeys).map(String);
      if (script === COOLDOWN_CLEAR_SCRIPT) {
        store.delete(keys[0] ?? "");
        return 1;
      }
      if (script === COOLDOWN_FLAG_SCRIPT) {
        const [markerKey, , payload] = keysAndArgs;
        store.set(String(markerKey), String(payload));
        return 1;
      }
      // POOL_ADMIT_SCRIPT / POOL_PROVIDER_ADMIT_SCRIPT:
      // KEYS[1] pool counter, optional KEYS[2] provider counter;
      // ARGV[1] pool capacity, ARGV[2] provider capacity (provider script),
      // ARGV[last] TTL.
      const poolKey = keys[0] ?? "";
      const providerKey = numKeys === 2 ? keys[1] : undefined;
      const poolCapacity = Number(args[0]);
      const providerCapacity = numKeys === 2 ? Number(args[1]) : undefined;
      const current = Number(store.get(poolKey) ?? "0");
      if (current >= poolCapacity) return 0;
      if (providerKey !== undefined && Number(store.get(providerKey) ?? "0") >= (providerCapacity ?? 0)) {
        return 2;
      }
      store.set(poolKey, String(current + 1));
      if (providerKey !== undefined) {
        store.set(providerKey, String(Number(store.get(providerKey) ?? "0") + 1));
      }
      return 1;
    },
  };
  return {
    redis: client as unknown as RedisClient,
    store,
    mgetKeys: () => mgetCalls,
    getKeys: () => getCalls,
    setMgetError: (error) => {
      mgetError = error;
    },
  };
}

function cooldownJson(poolId: string, until: number, blocked = false): string {
  return JSON.stringify({
    poolId,
    providerId: PROVIDER,
    until,
    reason: "Provider opencode rate limit",
    ...(blocked ? { blocked: true } : {}),
  });
}

describe("tryAcquireAvailablePool — cooldown pre-check batching", () => {
  test("reads every eligible pool's cooldown in ONE mget, never a per-pool get", async () => {
    const { redis, mgetKeys, getKeys } = fakeRedis();
    const selector = new NetworkPoolSelector(redis);

    const slot = await selector.tryAcquireAvailablePool([POOL_A, POOL_B, POOL_C], PROVIDER);
    expect(slot?.poolId).toBeDefined();
    slot?.release();

    // First MGET = cooldown keys only; the inflight pre-read is a second MGET.
    // Cooldown keys must never be fetched with GET.
    const cooldownReads = mgetKeys()[0] ?? [];
    expect(cooldownReads).toEqual([
      proxyCooldownKey(POOL_A, PROVIDER),
      proxyCooldownKey(POOL_B, PROVIDER),
      proxyCooldownKey(POOL_C, PROVIDER),
    ]);
    expect(getKeys().filter((key) => key.startsWith("proxy:cooldown:"))).toEqual([]);
  });

  test("a live Redis cooldown excludes that pool and admits a sibling", async () => {
    const until = Date.now() + 60_000;
    const { redis } = fakeRedis({
      [proxyCooldownKey(POOL_A, PROVIDER)]: cooldownJson(POOL_A, until),
    });
    const selector = new NetworkPoolSelector(redis);

    // pool-a is cooling, so only pool-b is eligible — no tie to break.
    const slot = await selector.tryAcquireAvailablePool([POOL_A, POOL_B], PROVIDER);
    expect(slot?.poolId).toBe(POOL_B);
    slot?.release();

    // The admitted row is cached locally, so a second admission for the same
    // provider reads it from the local map — still no per-pool GET.
    const second = await selector.tryAcquireAvailablePool([POOL_A, POOL_B], PROVIDER);
    expect(second?.poolId).toBe(POOL_B);
    second?.release();
  });

  test("a failed cooldown mget falls back to per-pool isProviderCooldown reads", async () => {
    const armed = fakeRedis();
    // Fail only the FIRST mget (the cooldown read); later mgets (inflight)
    // and the admit eval still work.
    armed.setMgetError(new Error("mget exploded"));
    const selector = new NetworkPoolSelector(armed.redis);

    const slot = await selector.tryAcquireAvailablePool([POOL_A, POOL_B], PROVIDER);
    expect(slot?.poolId).toBeDefined();
    slot?.release();

    // Fallback path: one GET per pool for the cooldown key.
    expect(armed.getKeys().filter((key) => key.startsWith("proxy:cooldown:"))).toEqual([
      proxyCooldownKey(POOL_A, PROVIDER),
      proxyCooldownKey(POOL_B, PROVIDER),
    ]);
    // And the inflight mget still ran afterwards (the one-shot error is spent).
    expect(armed.mgetKeys().length).toBeGreaterThanOrEqual(2);
  });

  test("an expired Redis cooldown row is cleared and the pool admitted", async () => {
    const stale = Date.now() - 1_000;
    const { redis, store } = fakeRedis({
      [proxyCooldownKey(POOL_A, PROVIDER)]: cooldownJson(POOL_A, stale),
    });
    const selector = new NetworkPoolSelector(redis);

    const slot = await selector.tryAcquireAvailablePool([POOL_A], PROVIDER);
    expect(slot?.poolId).toBe(POOL_A);
    slot?.release();

    // The expired marker is removed fire-and-forget via COOLDOWN_CLEAR_SCRIPT
    // (eval), not left to linger.
    expect(store.has(proxyCooldownKey(POOL_A, PROVIDER))).toBe(false);
  });
});
