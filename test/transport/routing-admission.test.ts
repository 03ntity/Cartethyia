/**
 * Candidate-scoped inflight reads: the read `plan()` performs to order
 * candidates by remaining concurrency.
 *
 * The old contract was `snapshotAccountInflight()` — a fleet-wide read with no
 * way to implement it except `KEYS admission:inflight:*` plus one unbounded
 * `MGET`. That ran on **every** `RoutingEngine.plan()` whenever any bounded
 * candidate existed, so a deployment with Redis paid an O(keyspace) blocking
 * server scan per request just to decide which account to try first.
 *
 * The new contract is `readAccountInflight(candidates)`: exact reads of exactly
 * the buckets the caller is ordering. These tests pin the properties that make
 * the regression impossible to reintroduce silently:
 *
 * - `KEYS` and `SCAN` are never invoked (the fake client throws on both, so a
 *   reintroduction fails the test rather than the production box);
 * - only the deduped admission buckets of the given candidates are requested;
 * - reads are chunked (256 keys per MGET) rather than one unbounded command;
 * - empty input issues zero commands;
 * - the in-memory and Redis controllers produce the same projection
 *   (positive-finite counts, unprefixed bucket names).
 */
import { describe, expect, test } from "bun:test";
import {
  admissionKey,
  InMemoryAdmissionController,
  RedisAdmissionController,
} from "../../src/transport/routing/admission";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import type { RedisClient } from "../../src/persistence/redis";

function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    provider_account_id: "acct-1",
    max_inflight: 2,
    ...overrides,
  } as RouteCandidate;
}

/**
 * A Redis client that records every command and throws if anything resembling
 * a keyspace scan is attempted. The read under test must be implementable
 * without ever enumerating keys; if it cannot be, the test fails loudly.
 */
function fakeRedis(
  store: ReadonlyMap<string, string>,
): RedisClient & {
  readonly mgetCalls: () => readonly string[][];
  readonly commandCount: () => number;
} {
  const mgetCalls: string[][] = [];
  let commands = 0;
  const client = {
    mgetCalls: () => mgetCalls,
    commandCount: () => commands,
    mget: async (...keys: string[]) => {
      commands += 1;
      mgetCalls.push(keys);
      return keys.map((key) => store.get(key) ?? null);
    },
    // The two commands this test exists to ban. Throwing (not returning empty)
    // means a reintroduction cannot pass by accident.
    keys: async () => {
      throw new Error("KEYS must never be used on the request path");
    },
    scan: async () => {
      throw new Error("SCAN must never be used on the request path");
    },
  };
  return client as unknown as RedisClient & {
    readonly mgetCalls: () => readonly string[][];
    readonly commandCount: () => number;
  };
}

describe("readAccountInflight — in-memory controller", () => {
  test("returns only positive counts for the requested buckets", async () => {
    const controller = new InMemoryAdmissionController();
    await controller.admit(candidate({ provider_account_id: "a" }));
    await controller.admit(candidate({ provider_account_id: "a" }));
    await controller.admit(candidate({ provider_account_id: "b" }));

    const snapshot = controller.readAccountInflight([
      candidate({ provider_account_id: "a" }),
      candidate({ provider_account_id: "b" }),
      candidate({ provider_account_id: "c" }), // never admitted → zero → omitted
    ]);
    expect(snapshot.size).toBe(2);
    expect(snapshot.get("p:m:a")).toBe(2);
    expect(snapshot.get("p:m:b")).toBe(1);
    expect(snapshot.has("p:m:c")).toBe(false);
  });

  test("duplicate candidates are deduped to one bucket", async () => {
    const controller = new InMemoryAdmissionController();
    await controller.admit(candidate());
    const one = candidate();
    const snapshot = controller.readAccountInflight([one, one, one]);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get(admissionKey(one))).toBe(1);
  });

  test("empty input returns an empty map", () => {
    const controller = new InMemoryAdmissionController();
    expect(controller.readAccountInflight([]).size).toBe(0);
  });
});

describe("readAccountInflight — Redis controller", () => {
  test("requests exactly the deduped keys, prefixed, and strips the prefix back", async () => {
    const target = candidate({ provider_account_id: "acct-1" });
    const other = candidate({ provider_account_id: "acct-2" });
    const store = new Map<string, string>([
      ["admission:inflight:p:m:acct-1", "3"],
      ["admission:inflight:p:m:unrelated", "9"],
    ]);
    const redis = fakeRedis(store);
    const controller = new RedisAdmissionController(redis);

    const snapshot = await controller.readAccountInflight([target, other, target]);
    expect(redis.commandCount()).toBe(1);
    expect(redis.mgetCalls()).toEqual([["admission:inflight:p:m:acct-1", "admission:inflight:p:m:acct-2"]]);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get("p:m:acct-1")).toBe(3);
    // The zero bucket is omitted, and the unrelated live key was never requested.
    expect(snapshot.has("p:m:acct-2")).toBe(false);
  });

  test("more than 256 buckets are read in bounded sequential chunks", async () => {
    const total = 600; // 256 + 256 + 88
    const candidates = Array.from({ length: total }, (_, i) =>
      candidate({ provider_account_id: `acct-${i}` }),
    );
    const store = new Map<string, string>();
    for (let i = 0; i < total; i += 1) {
      store.set(`admission:inflight:p:m:acct-${i}`, "1");
    }
    const redis = fakeRedis(store);
    const controller = new RedisAdmissionController(redis);

    const snapshot = await controller.readAccountInflight(candidates);
    expect(redis.commandCount()).toBe(3);
    expect(redis.mgetCalls()[0]).toHaveLength(256);
    expect(redis.mgetCalls()[1]).toHaveLength(256);
    expect(redis.mgetCalls()[2]).toHaveLength(88);
    expect(snapshot.size).toBe(total);
  });

  test("empty input issues zero commands", async () => {
    const redis = fakeRedis(new Map());
    const controller = new RedisAdmissionController(redis);
    const snapshot = await controller.readAccountInflight([]);
    expect(snapshot.size).toBe(0);
    expect(redis.commandCount()).toBe(0);
  });

  test("non-finite replies are dropped from the projection", async () => {
    const target = candidate({ provider_account_id: "bad" });
    const store = new Map<string, string>([
      ["admission:inflight:p:m:bad", "not-a-number"],
    ]);
    const redis = fakeRedis(store);
    const controller = new RedisAdmissionController(redis);
    const snapshot = await controller.readAccountInflight([target]);
    expect(snapshot.size).toBe(0);
  });

  test("in-memory and Redis projections agree for identical counters", async () => {
    const memory = new InMemoryAdmissionController();
    const seed = [candidate({ provider_account_id: "a" }), candidate({ provider_account_id: "b" })];
    for (const c of seed) {
      await memory.admit(c);
      await memory.admit(c);
    }
    const store = new Map<string, string>([
      ["admission:inflight:p:m:a", "2"],
      ["admission:inflight:p:m:b", "2"],
    ]);
    const redisController = new RedisAdmissionController(fakeRedis(store));

    const inMemory = memory.readAccountInflight(seed);
    const fromRedis = await redisController.readAccountInflight(seed);
    expect([...fromRedis.entries()].sort()).toEqual([...inMemory.entries()].sort());
  });
});
