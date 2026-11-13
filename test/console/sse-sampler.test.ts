/**
 * The shared sampler lifecycle owns the contract both SSE samplers rely on:
 * timers exist only while a subscriber holds them, the first acquire arms,
 * the last release clears every pending timer, and a fired timer's cadence
 * re-arms through `arm` without stacking a duplicate.
 *
 * Bun's `setTimeout` accepts a delay of 0 and `jest.useFakeTimers` is not the
 * runner here, so the suite drives real timers at 1ms cadence — fast enough
 * to stay deterministic, slow enough to observe ordering.
 */
import { describe, expect, test } from "bun:test";
import { createSamplerLifecycle } from "../../src/console/shared/sse-sampler";

const TICK_MS = 1;

function tickCounter(): { count: number; tick: () => Promise<void> } {
  const state = { count: 0 };
  return {
    get count() {
      return state.count;
    },
    tick: async () => {
      state.count += 1;
    },
  };
}

const flush = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 3));
  }
};

describe("createSamplerLifecycle", () => {
  test("arm is a no-op until a subscriber acquires", async () => {
    const lifecycle = createSamplerLifecycle();
    const counter = tickCounter();
    expect(lifecycle.arm(TICK_MS, counter.tick)).toBeUndefined();
    await flush();
    expect(counter.count).toBe(0);
    expect(lifecycle.armed).toBe(0);
  });

  test("a tick re-arms itself and keeps firing while a subscriber holds", async () => {
    const lifecycle = createSamplerLifecycle();
    const counter = tickCounter();
    lifecycle.acquire();
    lifecycle.arm(TICK_MS, async () => {
      lifecycle.arm(TICK_MS, counter.tick);
      await counter.tick();
    });
    await flush();
    expect(counter.count).toBeGreaterThanOrEqual(2);
    lifecycle.release();
  });

  test("the last release clears every armed timer", async () => {
    const lifecycle = createSamplerLifecycle();
    const counter = tickCounter();
    lifecycle.acquire();
    lifecycle.arm(TICK_MS, counter.tick);
    lifecycle.arm(TICK_MS * 7, counter.tick);
    expect(lifecycle.armed).toBe(2);
    const before = counter.count;
    lifecycle.release();
    expect(lifecycle.armed).toBe(0);
    await flush(8);
    expect(counter.count).toBe(before);
  });

  test("arm dedupes a pending cadence but allows re-arm after it fires", async () => {
    const lifecycle = createSamplerLifecycle();
    const counter = tickCounter();
    lifecycle.acquire();
    const first = lifecycle.arm(TICK_MS, counter.tick);
    // A second arm at the same cadence while the first is pending must not
    // stack a duplicate — that is what keeps `start()` idempotent.
    expect(lifecycle.arm(TICK_MS, counter.tick)).toBeUndefined();
    expect(lifecycle.armed).toBe(1);
    await flush();
    expect(first).toBeDefined();
    expect(counter.count).toBeGreaterThanOrEqual(1);
    lifecycle.release();
  });

  test("an extra release is a no-op and does not resurrect timers", async () => {
    const lifecycle = createSamplerLifecycle();
    const counter = tickCounter();
    lifecycle.acquire();
    lifecycle.arm(TICK_MS, counter.tick);
    lifecycle.release();
    lifecycle.release();
    expect(lifecycle.active).toBe(0);
    expect(lifecycle.armed).toBe(0);
    // Re-acquiring after a full release starts a fresh lifecycle.
    lifecycle.acquire();
    lifecycle.arm(TICK_MS, counter.tick);
    await flush();
    expect(counter.count).toBeGreaterThanOrEqual(1);
    lifecycle.release();
  });
});
