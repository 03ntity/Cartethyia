/**
 * The canonical memory policy.
 *
 * How many requests may run at once is admission's job — the tenant ceiling
 * and each key's own limit, both set in Settings — so this module no longer
 * derives a concurrency number at all. What remains is how much room the
 * process must keep free beneath its memory limit.
 */
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_MEMORY_LIMIT_BYTES,
  MEMORY_HEADROOM_FRACTION,
  deriveMemoryHeadroomBytes,
} from "../../src/config/resources";
import { resolveProcessTopology, type ProcessTopology } from "../../src/config/runtime";

const MiB = 1024 * 1024;


describe("deriveMemoryHeadroomBytes", () => {
  test("is a fraction of the real limit, not a flat constant", () => {
    expect(deriveMemoryHeadroomBytes(512 * MiB)).toBe(Math.ceil(512 * MiB * MEMORY_HEADROOM_FRACTION));
    // A flat 64 MiB would keep the same headroom on a box a quarter the size,
    // leaving a 512 MiB container almost no room to react.
    expect(deriveMemoryHeadroomBytes(2 * 1024 * MiB)).toBeGreaterThan(deriveMemoryHeadroomBytes(256 * MiB));
  });

  test("the fallback limit is the documented 512 MiB", () => {
    expect(FALLBACK_MEMORY_LIMIT_BYTES).toBe(512 * MiB);
  });
});



describe("resolveProcessTopology", () => {
  const savedCount = process.env.CARTETHYIA_PROCESS_COUNT;
  const savedIndex = process.env.CARTETHYIA_PROCESS_INDEX;

  function withTopology(count: string | undefined, index: string | undefined): ProcessTopology {
    if (count === undefined) delete process.env.CARTETHYIA_PROCESS_COUNT;
    else process.env.CARTETHYIA_PROCESS_COUNT = count;
    if (index === undefined) delete process.env.CARTETHYIA_PROCESS_INDEX;
    else process.env.CARTETHYIA_PROCESS_INDEX = index;
    return resolveProcessTopology();
  }

  test("unset means one process", () => {
    const topology = withTopology(undefined, undefined);
    expect(topology).toEqual({ count: 1, index: 0, multiProcess: false });
  });

  test("an explicit single process needs no index", () => {
    expect(withTopology("1", undefined)).toEqual({ count: 1, index: 0, multiProcess: false });
  });

  test("several processes report index and multiProcess", () => {
    expect(withTopology("4", "2")).toEqual({ count: 4, index: 2, multiProcess: true });
  });

  test("a count above one with no index fails rather than defaulting to 0", () => {
    // Defaulting would give two processes the same index, and neither could
    // own a distinct shard of anything.
    expect(() => withTopology("4", undefined)).toThrow(/CARTETHYIA_PROCESS_INDEX is required/);
  });

  test("an index outside the range fails", () => {
    expect(() => withTopology("4", "4")).toThrow(/must be an integer between 0 and 3/);
    expect(() => withTopology("4", "-1")).toThrow(/must be an integer/);
  });

  test("a malformed or out-of-range count fails", () => {
    expect(() => withTopology("0", "0")).toThrow(/must be an integer between 1 and 16/);
    expect(() => withTopology("99", "0")).toThrow(/must be an integer between 1 and 16/);
    expect(() => withTopology("many", "0")).toThrow(/must be an integer/);
  });

  test("the environment is restored", () => {
    if (savedCount === undefined) delete process.env.CARTETHYIA_PROCESS_COUNT;
    else process.env.CARTETHYIA_PROCESS_COUNT = savedCount;
    if (savedIndex === undefined) delete process.env.CARTETHYIA_PROCESS_INDEX;
    else process.env.CARTETHYIA_PROCESS_INDEX = savedIndex;
    expect(resolveProcessTopology().multiProcess).toBe(false);
  });
});
