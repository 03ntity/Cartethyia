/**
 * `exponentialBackoff` — the single owner of retry-delay math.
 *
 * Two jitter policies share the bound `min(maxDelayMs, base * 2^attempt)`:
 *
 * - `"additive"` (network/util/retry.ts): bound + a random 0..+25% slice,
 *   rounded — the mean stays near the bound while a herd desynchronizes.
 * - `"full"` (protocol/failure-policy.ts `fallbackRetryDelayMs`): a uniform
 *   draw in [0, bound), unrounded — the first retry lands anywhere inside the
 *   window, and sub-millisecond configured caps are not rounded away.
 *
 * The properties pinned here are the ones a regression would break silently:
 * jitter never exceeds its documented envelope, never goes negative, and the
 * unjittered path is byte-for-byte the old formula.
 */
import { describe, expect, test } from "bun:test";
import { exponentialBackoff } from "../../src/network/util/backoff";

/** Runs `read` with `Math.random` pinned, so jittered delays are deterministic. */
function withRandom<T>(value: number, read: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return read();
  } finally {
    Math.random = original;
  }
}

function boundOf(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
}

describe("exponentialBackoff — the shared bound", () => {
  test("grows exponentially from the base and caps at maxDelayMs", () => {
    const options = { baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(exponentialBackoff(0, options)).toBe(100);
    expect(exponentialBackoff(1, options)).toBe(200);
    expect(exponentialBackoff(2, options)).toBe(400);
    expect(exponentialBackoff(3, options)).toBe(800);
    expect(exponentialBackoff(4, options)).toBe(1_000);
    expect(exponentialBackoff(30, options)).toBe(1_000);
  });

  test("a negative attempt clamps to the base instead of shrinking the bound", () => {
    // `2 ** -1` would halve the base; the clamp keeps the formula monotone so a
    // stray negative index cannot produce a sub-base delay.
    const options = { baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(exponentialBackoff(-1, options)).toBe(100);
    expect(exponentialBackoff(-5, options)).toBe(100);
  });

  test("a cap below the base wins outright", () => {
    expect(exponentialBackoff(3, { baseDelayMs: 100, maxDelayMs: 40 })).toBe(40);
  });

  test("no jitter policy is the default and consumes no randomness", () => {
    let draws = 0;
    const original = Math.random;
    Math.random = () => {
      draws += 1;
      return 0.5;
    };
    try {
      expect(exponentialBackoff(2, { baseDelayMs: 100, maxDelayMs: 10_000 })).toBe(400);
      expect(draws).toBe(0);
    } finally {
      Math.random = original;
    }
  });
});

describe("exponentialBackoff — additive jitter (network/util)", () => {
  const options = { baseDelayMs: 100, maxDelayMs: 10_000, jitterPolicy: "additive" as const };

  test("random()=0 returns the bare bound", () => {
    expect(withRandom(0, () => exponentialBackoff(0, options))).toBe(100);
    expect(withRandom(0, () => exponentialBackoff(4, options))).toBe(1_600);
  });

  test("random()=1 approaches but stays inside bound * 1.25", () => {
    // Math.random() never returns 1, so pin 0.999999: bound 1600 + ~400.
    const delay = withRandom(0.999999, () => exponentialBackoff(4, options));
    expect(delay).toBe(2000);
    expect(delay).toBeLessThanOrEqual(Math.round(1600 * 1.25));
  });

  test("the result is always an integer inside [bound, bound * 1.25]", () => {
    const original = Math.random;
    try {
      for (const attempt of [0, 1, 2, 3, 10]) {
        const bound = boundOf(attempt, 100, 10_000);
        for (const draw of [0, 0.25, 0.5, 0.75, 0.999999]) {
          Math.random = () => draw;
          const delay = exponentialBackoff(attempt, options);
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(bound);
          expect(delay).toBeLessThanOrEqual(Math.round(bound * 1.25) + 1);
        }
      }
    } finally {
      Math.random = original;
    }
  });

  test("additive jitter never shrinks the delay below the bound", () => {
    // A jitter that could go negative or below the bound would let a retry
    // fire before its backoff elapsed. Draws are real here: the property is
    // the envelope, not a pinned value.
    for (let i = 0; i < 200; i += 1) {
      const delay = exponentialBackoff(2, options);
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(Math.round(400 * 1.25) + 1);
    }
  });
});

describe("exponentialBackoff — full jitter (protocol/failure-policy)", () => {
  const options = { baseDelayMs: 100, maxDelayMs: 2_000, jitterPolicy: "full" as const };

  test("random()=0 returns 0 and random()→1 approaches the bound", () => {
    expect(withRandom(0, () => exponentialBackoff(0, options))).toBe(0);
    expect(withRandom(0.999999, () => exponentialBackoff(0, options))).toBeLessThan(100);
    expect(withRandom(0.999999, () => exponentialBackoff(30, options))).toBeLessThan(2_000);
  });

  test("the result is always inside [0, bound) across the attempt range", () => {
    const original = Math.random;
    try {
      for (const attempt of [0, 1, 2, 5, 6, 30]) {
        const bound = boundOf(attempt, 100, 2_000);
        for (const draw of [0, 0.1, 0.5, 0.9, 0.999999]) {
          Math.random = () => draw;
          const delay = exponentialBackoff(attempt, options);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThan(bound);
        }
      }
    } finally {
      Math.random = original;
    }
  });

  test("the draw is NOT rounded — sub-millisecond bounds survive", () => {
    // `fallbackRetryDelayMs` once computed `Math.random() * bound` directly;
    // rounding here would collapse a configured 0.4ms cap to 0 or 1 and change
    // the pinned env-tunable behavior.
    const delay = withRandom(0.5, () =>
      exponentialBackoff(0, { baseDelayMs: 0.4, maxDelayMs: 10, jitterPolicy: "full" }),
    );
    expect(delay).toBe(0.2);
  });
});
