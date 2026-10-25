/**
 * `BoundedLruMap`: the shared bound behind the routing-layer caches.
 *
 * Both the round-robin state map and the capability-profile memo used to
 * hand-roll LRU behavior; the two implementations could drift (one refreshed
 * on read, one did not). This file pins the one contract both now share so
 * neither caller can regress it independently:
 *
 * - the map never exceeds its capacity;
 * - `get` refreshes recency (a hot entry survives later insertions);
 * - `set` evicts exactly one LRU entry on overflow;
 * - a non-positive capacity is rejected at construction.
 */
import { describe, expect, test } from "bun:test";
import { BoundedLruMap } from "../../src/transport/routing/bounded-lru";

describe("BoundedLruMap", () => {
  test("inserting past capacity evicts the least-recently-used entry", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4);
    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(false);
    expect([...map.keys()]).toEqual(["b", "c", "d"]);
  });

  test("get refreshes recency, so a read entry survives the next eviction", () => {
    const map = new BoundedLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.get("a")).toBe(1); // refresh "a" to the tail
    map.set("d", 4); // evicts "b", not "a"
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect([...map.keys()]).toEqual(["c", "a", "d"]);
  });

  test("re-setting an existing key updates the value and refreshes recency", () => {
    const map = new BoundedLruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10); // refresh + update, no eviction needed
    expect(map.size).toBe(2);
    map.set("c", 3); // evicts "b"
    expect(map.get("a")).toBe(10);
    expect(map.has("b")).toBe(false);
  });

  test("capacity is a hard bound regardless of insertion volume", () => {
    const map = new BoundedLruMap<number, number>(8);
    for (let i = 0; i < 1_000; i += 1) map.set(i, i);
    expect(map.size).toBe(8);
    // The survivors are the last 8 inserted: the working set stays hot.
    expect([...map.keys()]).toEqual([992, 993, 994, 995, 996, 997, 998, 999]);
  });

  test("a mixed read/write workload keeps the hot set", () => {
    const map = new BoundedLruMap<string, number>(4);
    map.set("hot", 1); // seed the entry the workload keeps reading
    for (let round = 0; round < 50; round += 1) {
      map.get("hot");
      map.set(`cold-${round}`, round);
    }
    expect(map.has("hot")).toBe(true);
    expect(map.size).toBe(4);
  });

  test("non-positive or fractional capacity is rejected", () => {
    expect(() => new BoundedLruMap(0)).toThrow();
    expect(() => new BoundedLruMap(-1)).toThrow();
    expect(() => new BoundedLruMap(1.5)).toThrow();
    expect(() => new BoundedLruMap(Number.NaN)).toThrow();
  });

  test("missing keys read as undefined without disturbing order", () => {
    const map = new BoundedLruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("nope")).toBeUndefined();
    expect([...map.keys()]).toEqual(["a", "b"]);
  });
});
