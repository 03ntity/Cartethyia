/**
 * Scheduler for periodic maintenance tasks. Each task owns
 * only its domain work; this registry owns timer, re-entrancy, and logging
 * behavior.
 */
import { log } from "../observability/logger";
import type { MaintenanceLeaseStore } from "./maintenance-lease";
import { leaseTtlMs } from "./maintenance-lease";

export interface ScheduledTask {
  readonly name: string;
  readonly intervalMs: number;
  /** Delay before the first run after the registry starts. */
  readonly initialDelayMs?: number;
  /**
   * Whether this task's work is SHARED across the fleet, so only one process
   * should run it per interval.
   *
   * Opt-in, because the opposite is also correct: a task that only reads this
   * process's own state — publishing memory gauges, say — must run everywhere,
   * and leasing it would mean only one process reported its numbers.
   *
   * Side-effecting sweeps (retention, payload cleanup, session expiry) set
   * this: two processes over the same batches do not produce two correct
   * halves, they double the row churn and contend for one core.
   */
  readonly shared?: boolean;
  run(): Promise<unknown> | void;
}

export interface ScheduledTaskRegistryOptions {
  /**
   * Cross-process coordinator. When present, a task that cannot acquire the
   * fleet lease SKIPS its tick rather than waiting — the next interval is the
   * retry, so a missed run cannot become a catch-up storm.
   */
  readonly lease?: MaintenanceLeaseStore | undefined;
  /** Injected clock for deterministic tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Runs `items` in completed waves that grow from 2 up to `maxConcurrency`.
 *
 * Growing the wave instead of starting at full width keeps a cold sweep from
 * stampeding every provider at once, while still finishing in a few waves
 * rather than one round trip per account. Each wave is awaited to completion
 * before the next starts, so at most `maxConcurrency` items are in flight.
 *
 * `shouldStop` is consulted between waves, never mid-wave, so a caller's
 * deadline cannot leave a half-finished wave behind.
 */
export async function runGrowingWaves<T>(
  items: readonly T[],
  options: {
    readonly maxConcurrency: number;
    readonly onItem: (item: T) => Promise<void> | void;
    readonly shouldStop?: () => boolean;
  },
): Promise<void> {
  const limit = Math.max(1, options.maxConcurrency);
  let offset = 0;
  let waveSize = Math.min(DEFAULT_INITIAL_BATCH_SIZE, limit);
  while (offset < items.length) {
    if (options.shouldStop?.() === true) return;
    const wave = items.slice(offset, offset + waveSize);
    offset += wave.length;
    await Promise.all(wave.map((item) => options.onItem(item)));
    waveSize = Math.min(waveSize + 1, limit);
  }
}

export const DEFAULT_INITIAL_BATCH_SIZE = 2;

/**
 * Tasks may be registered at any time: before `start()`, they are scheduled
 * when `start()` runs; after `start()`, each `register()` immediately schedules
 * that task. Registration order never decides whether a task runs.
 */
export class ScheduledTaskRegistry {
  private readonly tasks: ScheduledTask[] = [];
  private readonly timers: Timer[] = [];
  /**
   * Latched by `start()` and cleared by `stop()`. This is the idempotency and
   * late-registration flag: unlike `timers.length`, it stays true when `start()`
   * ran with no tasks yet, so a task registered afterwards is scheduled exactly
   * once (immediately) and a later `start()` call does not stack a second timer.
   */
  private started = false;
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Task names an operator has switched off. Read once at construction from
   * `CARTETHYIA_DISABLED_TASKS` rather than per interval: the list cannot
   * change without a restart, and re-parsing it on every tick would put a
   * string split on the maintenance path.
   */
  private readonly disabled: ReadonlySet<string>;
  /**
   * Optional cross-process coordinator. Absent, only this process's own
   * re-entrancy rule applies — which is correct for a single-process
   * deployment and for tasks that are already idempotent.
   */
  private readonly lease: MaintenanceLeaseStore | undefined;
  /** Injected clock, so a test can drive the maintenance cadence deterministically. */
  private readonly now: () => number;
  /** Ticks that could not acquire the fleet lease. Diagnostic, not a queue. */
  private readonly skippedByLease = new Map<string, number>();
  /** When each task last skipped on the lease, from the injected clock. */
  private readonly lastSkipAt = new Map<string, number>();
  /** Whether any maintenance task in this process is currently running. */
  private busy: string | undefined;

  constructor(
    disabledTaskNames: readonly string[] = [],
    options: ScheduledTaskRegistryOptions = {},
  ) {
    this.disabled = new Set(disabledTaskNames);
    this.lease = options.lease;
    this.now = options.now ?? Date.now;
  }

  /**
   * How many ticks a task has skipped because another process held the lease.
   *
   * A non-zero, steadily rising number means the fleet is duplicating work
   * somewhere OR one holder is not releasing — both worth seeing, and neither
   * visible from the task's own logs.
   */
  leaseSkips(name: string): number {
    return this.skippedByLease.get(name) ?? 0;
  }

  /** When a task last skipped on the lease, or `undefined` if it never has. */
  lastLeaseSkipAt(name: string): number | undefined {
    return this.lastSkipAt.get(name);
  }

  register(task: ScheduledTask): void {
    if (this.disabled.has(task.name)) {
      // Logged once, not per interval: a disabled task is a deliberate
      // operator choice, and repeating it every tick would be noise in the
      // very log the operator is reading to find out why a sweep is stale.
      log.info(`[scheduled-task:${task.name}] disabled by CARTETHYIA_DISABLED_TASKS`);
      return;
    }
    this.tasks.push(task);
    if (this.started) this.schedule(task);
  }

  /**
   * Schedules every registered task, respecting any initial delay. Idempotent: a
   * second call while started schedules nothing new, so `--hot` reloads cannot
   * stack duplicate sweeps — including for tasks registered after the first
   * `start()`, which already run on their own timers. `stop()` clears the
   * timers, after which `start()` schedules again.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) this.schedule(task);
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Names of the tasks this process will actually run. */
  names(): readonly string[] {
    return this.tasks.map((task) => task.name);
  }

  /** Whether a task is mid-run. A manual trigger uses this to answer 409. */
  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** Runs one named task immediately, bypassing its interval — for tests and manual triggers. */
  async runNow(name: string): Promise<boolean> {
    const task = this.tasks.find((t) => t.name === name);
    if (!task) return false;
    await this.runOnce(task);
    return true;
  }

  /** Starts one task's interval timer: unref'd, so it never holds the process open. */
  private schedule(task: ScheduledTask): void {
    if (task.initialDelayMs !== undefined) {
      const timer = setTimeout(() => {
        if (!this.started) return;
        void this.runOnce(task);
        this.scheduleInterval(task);
      }, task.initialDelayMs);
      if (typeof timer.unref === "function") timer.unref();
      this.timers.push(timer);
      return;
    }
    this.scheduleInterval(task);
  }

  private scheduleInterval(task: ScheduledTask): void {
    const timer = setInterval(() => void this.runOnce(task), task.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.push(timer);
  }

  private async runOnce(task: ScheduledTask): Promise<void> {
    if (this.running.has(task.name)) return;
    // LOCAL rule: one maintenance task at a time per process, across ALL
    // names. A different task's tick skips (it does not queue) while one is
    // running — the two would contend for the same rows, the same file
    // handles, and the same single core. Queuing the skipped tick would mean
    // every task fires at once once the blocker finishes, which is the burst
    // this rule exists to prevent.
    if (this.busy !== undefined) return;
    this.running.add(task.name);
    this.busy = task.name;
    const lease =
      this.lease !== undefined && task.shared === true
        ? await this.lease.tryAcquire(task.name, leaseTtlMs(task.intervalMs))
        : undefined;
    if (lease !== undefined && !lease.held) {
      this.running.delete(task.name);
      this.busy = undefined;
      this.skippedByLease.set(task.name, (this.skippedByLease.get(task.name) ?? 0) + 1);
      this.lastSkipAt.set(task.name, this.now());
      return;
    }
    const done = (async () => {
      // Renewal at a third of the TTL: enough headroom that one slow
      // iteration cannot drop the lease mid-run, without hammering Redis.
      const renewEveryMs = Math.max(1_000, Math.floor(leaseTtlMs(task.intervalMs) / 3));
      let renewTimer: ReturnType<typeof setInterval> | undefined;
      if (lease !== undefined) {
        renewTimer = setInterval(() => {
          void lease.renew();
        }, renewEveryMs);
        if (typeof renewTimer.unref === "function") renewTimer.unref();
      }
      try {
        await task.run();
        if (lease !== undefined) await lease.release();
      } catch (error) {
        log.error(`[scheduled-task:${task.name}] failed`, error as Error);
        // Released on failure too: the error is this process's, not the
        // fleet's, and holding the lease until it expires would block the
        // next tick for no reason.
        if (lease !== undefined) await lease.release().catch(() => undefined);
      } finally {
        // No-ops for an absent handle, and the renewal timer is always
        // assigned before this runs.
        clearInterval(renewTimer);
      }
    })();
    this.inFlight.add(done);
    try {
      await done;
    } finally {
      this.inFlight.delete(done);
      this.running.delete(task.name);
      this.busy = undefined;
    }
  }
}