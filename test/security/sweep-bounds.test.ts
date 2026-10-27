import { describe, expect, test } from "bun:test";
import {
  MAX_LEASE_REAPS_PER_PASS,
  MAX_LEASE_SCAN_ITERATIONS,
  sweepLeases,
} from "../../src/security/admission/lease-sweep";
import type { RedisClient } from "../../src/persistence/redis";

/**
 * The lease sweep used to follow the SCAN cursor until it wrapped and reap
 * every expired lease it found. Both have to be bounded: a keyspace that has
 * grown for months must not turn one 30-second tick into an unbounded pass.
 */

/**
 * A cursor that never wraps, handing back a fixed page of expired leases each
 * call. Against the old loop this runs forever; against the bounded one it
 * stops at the cap.
 */
function neverEndingRedis(pageSize: number): RedisClient & {
  readonly scans: () => number;
  readonly releases: () => number;
} {
  let scans = 0;
  let releases = 0;
  const client = {
    scans: () => scans,
    releases: () => releases,
    scan: async () => {
      scans += 1;
      const keys = Array.from({ length: pageSize }, (_, index) => `admission:lease:${scans}-${index}`);
      return [String(scans), keys] as [string, string[]];
    },
    hget: async (_key: string, field: string) => {
      if (field === "state") return "active";
      // Expired long ago, and a present api_key_id so the release proceeds
      // instead of throwing before it can be counted.
      if (field === "expires_at") return "0";
      return "key-1";
    },
    // `releaseAdmissionLease` ends on an EVAL. Counting it counts releases.
    eval: async () => {
      releases += 1;
      return 1;
    },
  };
  return client as unknown as RedisClient & {
    readonly scans: () => number;
    readonly releases: () => number;
  };
}

describe("sweepLeases — one pass is bounded", () => {
  test("a cursor that never wraps stops at the scan cap", async () => {
    const redis = neverEndingRedis(1);
    await sweepLeases(redis);
    expect(redis.scans()).toBeLessThanOrEqual(MAX_LEASE_SCAN_ITERATIONS);
    expect(redis.scans()).toBeGreaterThan(0);
  });

  test("a page of expired leases stops at the reap cap", async () => {
    const redis = neverEndingRedis(100);
    await sweepLeases(redis);
    expect(redis.releases()).toBeLessThanOrEqual(MAX_LEASE_REAPS_PER_PASS);
    expect(redis.releases()).toBeGreaterThan(0);
  });
});

/**
 * `RedisAdmissionCounterStore.purge()` is bounded too (same class of bug as
 * the lease sweep above): a keyspace that never stops handing back pages must
 * not turn one revocation into an unbounded walk.
 */
import {
  MAX_PURGE_COUNTER_SCAN_PAGES,
  MAX_PURGE_LEASES_RELEASED,
  MAX_PURGE_LEASE_SCAN_PAGES,
  RedisAdmissionCounterStore,
} from "../../src/security/admission/redis-store";

/**
 * A Redis client whose SCAN never wraps, for the lease pattern, so a purge
 * that follows the cursor forever runs forever; the bounded one stops at the
 * page budget.
 */
function neverWrappingLeaseRedis(pageSize: number): RedisClient & {
  readonly scans: () => number;
  readonly releases: () => number;
} {
  let scans = 0;
  let releases = 0;
  const client = {
    scans: () => scans,
    releases: () => releases,
    scan: async () => {
      scans += 1;
      const keys = Array.from(
        { length: pageSize },
        (_, index) => `admission:lease:${scans}-${index}`,
      );
      return [String(scans + 1), keys] as [string, string[]];
    },
    hget: async () => "key-1",
    pipeline: () => {
      const ops: [string, string[]][] = [];
      return {
        hget: (_key: string, _field: string) => {
          ops.push(["hget", []]);
          return undefined as unknown as ReturnType<RedisClient["pipeline"]>;
        },
        exec: async () => ops.map(() => [null, "key-1"]),
      };
    },
    eval: async () => {
      releases += 1;
      return 1;
    },
  };
  return client as unknown as RedisClient & {
    readonly scans: () => number;
    readonly releases: () => number;
  };
}

describe("RedisAdmissionCounterStore.purge — one pass is bounded", () => {
  test("a lease cursor that never wraps stops at the page cap", async () => {
    const redis = neverWrappingLeaseRedis(5);
    const store = new RedisAdmissionCounterStore(redis);
    await store.purge("key-1");
    expect(redis.scans()).toBeLessThanOrEqual(MAX_PURGE_LEASE_SCAN_PAGES);
    expect(redis.scans()).toBeGreaterThan(0);
  });

  test("a flood of owned leases stops at the release cap", async () => {
    // Every page is full of leases owned by the purged key: without a release
    // budget the loop releases one EVAL per lease for as long as the cursor
    // keeps handing pages back.
    const redis = neverWrappingLeaseRedis(25);
    const store = new RedisAdmissionCounterStore(redis);
    await store.purge("key-1");
    expect(redis.releases()).toBeLessThanOrEqual(MAX_PURGE_LEASES_RELEASED);
    expect(redis.releases()).toBeGreaterThan(0);
  });

  test("a counter cursor that never wraps stops at the counter page cap", async () => {
    let scans = 0;
    const dels: string[][] = [];
    const client = {
      scan: async () => {
        scans += 1;
        // Matches the purge counter patterns, so every page is "owned" and DELs.
        const keys = Array.from({ length: 10 }, (_, index) => `admission:daily:key-1:${scans}-${index}`);
        return [String(scans + 1), keys] as [string, string[]];
      },
      hget: async () => "someone-else",
      del: async (...keys: string[]) => {
        dels.push(keys);
        return keys.length;
      },
    };
    const store = new RedisAdmissionCounterStore(client as unknown as RedisClient);
    await store.purge("key-1");
    // Two patterns share the budget: the cap bounds them together.
    expect(scans).toBeLessThanOrEqual(MAX_PURGE_COUNTER_SCAN_PAGES);
    expect(scans).toBeGreaterThan(0);
  });
});
