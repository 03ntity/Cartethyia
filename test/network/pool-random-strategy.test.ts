/**
 * `random` pool-group strategy: scatter each selection across the eligible
 * pools instead of scanning a fixed order, while still honoring cooldown
 * markers and capacity.
 */
import { expect, test } from "bun:test";
import { NetworkPoolSelector } from "../../src/network/pool/selector";

const LIMITS = { "pool-a": 10, "pool-b": 10, "pool-c": 10 };
const WEIGHTS = { "pool-a": 100, "pool-b": 100, "pool-c": 100 };

test("random strategy scatters across eligible pools", async () => {
  const selector = new NetworkPoolSelector();
  const seen = new Set<string>();
  for (let i = 0; i < 60; i += 1) {
    const slot = await selector.tryAcquireAvailablePool(
      ["pool-a", "pool-b", "pool-c"],
      "opencode",
      LIMITS,
      WEIGHTS,
      { key: "tenant-random", rotateCount: 1, strategy: "random" },
    );
    expect(slot).toBeDefined();
    seen.add(slot!.poolId);
    slot!.release();
  }
  // With equal weights and 60 draws, seeing only one pool is effectively
  // impossible — the point of random scatter is that a burst does not clump
  // onto the same first pool every time.
  expect(seen.size).toBeGreaterThan(1);
});

test("random strategy still skips cooling pools", async () => {
  const selector = new NetworkPoolSelector();
  await selector.flagProviderCooldown("pool-a", "opencode", 60_000, "probe 429");
  const slot = await selector.tryAcquireAvailablePool(
    ["pool-a", "pool-b"],
    "opencode",
    { "pool-a": 10, "pool-b": 10 },
    { "pool-a": 100, "pool-b": 100 },
    { key: "tenant-random", rotateCount: 1, strategy: "random" },
  );
  expect(slot?.poolId).toBe("pool-b");
  slot?.release();
});

test("random strategy falls through when the first pick is full", async () => {
  const selector = new NetworkPoolSelector();
  // Fill pool-a to capacity directly (not via random selection, which could
  // fill pool-b instead).
  const slots: Array<{ release: () => void }> = [];
  for (let i = 0; i < 10; i += 1) {
    slots.push(selector.acquire("pool-a", 10));
  }
  const next = await selector.tryAcquireAvailablePool(
    ["pool-a", "pool-b"],
    "opencode",
    LIMITS,
    WEIGHTS,
    { key: "tenant-random-full", rotateCount: 1, strategy: "random" },
  );
  expect(next?.poolId).toBe("pool-b");
  for (const slot of slots) slot.release();
  next?.release();
});
