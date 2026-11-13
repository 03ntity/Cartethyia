/**
 * Shared lifecycle for process-wide push samplers.
 *
 * Two console surfaces run a background sampler that fans results out to SSE
 * subscribers — share-link stats (`share-router.ts`) and update/memory
 * notifications (`updates/routes.ts`). Both spelled out the same contract:
 * timers run only while at least one subscriber is connected, the first
 * subscriber starts them, the last unsubscribe stops them, and each tick is a
 * self-rescheduling `setTimeout` so a slow pass delays the next one instead of
 * overlapping it.
 *
 * `createSamplerLifecycle` owns only that contract. What a tick *does* —
 * resolve a family rollup, sample memory, check for a release — stays with
 * the caller, because the two samplers share the cadence machinery and
 * nothing else.
 */

/** The timer handle shape both samplers used (`setTimeout`'s return). */
export type SamplerTimer = ReturnType<typeof setTimeout>;

export interface SamplerLifecycle {
  /**
   * Registers one subscriber. The first subscriber starts the timers; later
   * ones only bump the count. Call before arming any per-subscriber work.
   */
  acquire(): void;
  /**
   * Releases one subscriber. The last release stops every armed timer.
   * Idempotent per acquire/release pair — an extra release is a no-op.
   */
  release(): void;
  /**
   * Arms one self-rescheduling timer while subscribers exist. `arm` dedupes:
   * a second call while a timer for the same cadence is still pending is a
   * no-op, so a tick may re-arm unconditionally and a fresh `subscribe` can
   * never stack a second timer on top of a pending one. The callback is
   * responsible for re-arming through another `arm` call once it finishes its
   * work, so a slow pass delays the next tick instead of overlapping it.
   * Returns `undefined` when no subscriber holds the sampler or the cadence
   * is already armed.
   */
  arm(delayMs: number, tick: () => Promise<void> | void): SamplerTimer | undefined;
  /** How many subscribers are currently holding the sampler alive. */
  readonly active: number;
  /** How many timers are currently armed and pending. */
  readonly armed: number;
}

export function createSamplerLifecycle(): SamplerLifecycle {
  let subscribers = 0;
  // Pending timers keyed by their cadence, so `arm` can tell "already armed"
  // from "fired and awaiting its re-arm" — the latter must be allowed through
  // or the cadence would stall after the first tick.
  const pending = new Map<number, SamplerTimer>();
  return {
    acquire() {
      subscribers += 1;
    },
    release() {
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
      }
    },
    arm(delayMs, tick) {
      if (subscribers === 0 || pending.has(delayMs)) return undefined;
      const timer = setTimeout(() => {
        pending.delete(delayMs);
        void Promise.resolve(tick());
      }, delayMs);
      pending.set(delayMs, timer);
      return timer;
    },
    get active() {
      return subscribers;
    },
    get armed() {
      return pending.size;
    },
  };
}
