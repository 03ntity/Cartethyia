/**
 * Canonical resource policy: how much memory this process may use, and how
 * much work it may hold at once.
 *
 * These two numbers were previously decided in three unrelated places — a
 * hardcoded cap in `concurrency-guard.ts`, a host-wide `os.totalmem()` in the
 * headroom guard, and a fallback constant in `runtime-metrics.ts` — which
 * meant a container limited to 512 MiB admitted the same concurrency as a 4 GiB
 * one and only started shedding once the *host* was nearly full. On a 1-core /
 * 2 GiB VPS that is the difference between shedding early and being
 * OOM-killed, and the OOM kills the dashboard too — the one surface that would
 * have explained what happened.
 *
 * Everything here is derived from one limit and one body ceiling, so the
 * numbers cannot disagree with each other:
 *
 *   concurrency = floor(limit × BUDGET_FRACTION / (TRANSIENT_COPIES × body))
 *
 * The transient-copies factor is why this is not simply "limit / body": a
 * request body is held more than once between the socket read, the JSON parse,
 * and the upstream re-serialization, so budgeting one copy per request
 * understates the real hold by a factor of about two.
 */
import { CONFIG_SPEC, readOptionalInt } from "./spec";
import { resolveMaxBodyBytes } from "./runtime";

/** Used when no limit is discoverable at all (native dev, macOS, Windows). */
export const FALLBACK_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Ceiling on concurrent in-flight requests per process.
 *
 * A hard ceiling even when memory would allow more: this process is one core,
 * and past this point queueing delay, not memory, is what degrades. It also
 * bounds every per-request structure that is sized by concurrency.
 */
export const MAX_PROCESS_CONCURRENCY = 64;

/**
 * How many copies of a request body are resident at once.
 *
 * Measured, not assumed: the socket read buffer, the parsed object graph, and
 * the upstream re-serialization each hold a body-sized allocation, and garbage
 * collection lags rather than keeping them to one. Budgeting one copy halves
 * the real peak and lets the process admit twice the concurrency it can hold.
 */
export const REQUEST_BODY_TRANSIENT_COPIES = 2;

/** Share of the memory limit all in-flight request bodies together may hold. */
export const REQUEST_BODY_BUDGET_FRACTION = 0.25;

/** Share of the memory limit kept free for allocation spikes and GC slack. */
export const MEMORY_HEADROOM_FRACTION = 0.2;

/**
 * Concurrency this process should admit, derived from the memory limit and the
 * body ceiling rather than guessed.
 *
 * Worked examples, which are the point of having one formula:
 * - 2 GiB limit, 4 MiB bodies → 64 (the ceiling; memory is not the binder)
 * - 512 MiB limit, 4 MiB bodies → 16
 * - 256 MiB limit, 16 MiB bodies → 2
 *
 * An explicit override is honoured, clamped to 1..MAX_PROCESS_CONCURRENCY. It
 * is the operator's call and is never silently raised back to the derived
 * value; exceeding the derived figure is a deliberate choice, so it is
 * reported at the call site rather than corrected here.
 */
export function deriveProcessConcurrency(options: {
  readonly memoryLimitBytes: number;
  readonly maxBodyBytes: number;
  readonly override?: number | undefined;
}): number {
  if (options.override !== undefined) {
    if (!Number.isInteger(options.override)) return 1;
    return Math.min(MAX_PROCESS_CONCURRENCY, Math.max(1, options.override));
  }
  const body = Math.max(1, options.maxBodyBytes);
  const perRequest = REQUEST_BODY_TRANSIENT_COPIES * body;
  const budget = Math.max(1, Math.floor(options.memoryLimitBytes * REQUEST_BODY_BUDGET_FRACTION));
  const derived = Math.floor(budget / perRequest);
  return Math.min(MAX_PROCESS_CONCURRENCY, Math.max(1, derived));
}

/**
 * Bytes kept free below the memory limit.
 *
 * A guard that only reacts once RSS equals the limit has already lost: the
 * allocation that breaches it happens between two samples, and the spike that
 * matters — an upstream response landing all at once — arrives in far less
 * than one sample interval.
 */
export function deriveMemoryHeadroomBytes(memoryLimitBytes: number): number {
  return Math.ceil(memoryLimitBytes * MEMORY_HEADROOM_FRACTION);
}

/**
 * The optional operator override, read through the config spec so "unset" and
 * "out of range" are treated the way every other knob treats them.
 */
export function resolveProcessConcurrencyOverride(): number | undefined {
  return readOptionalInt(
    "CARTETHYIA_PROCESS_CONCURRENCY_LIMIT",
    CONFIG_SPEC.CARTETHYIA_PROCESS_CONCURRENCY_LIMIT,
  );
}

/**
 * Slack added on top of every key's concurrency limit.
 *
 * Operator configuration, not something a key carries about itself: it is
 * deliberate hidden allowance so a run that lands a few requests over the
 * number an operator chose is not refused at that number. The effective
 * ceiling is `limit + tolerance`, and only requests past it are refused.
 */
export function resolveConcurrencyTolerance(): number {
  const value = readOptionalInt(
    "CARTETHYIA_CONCURRENCY_TOLERANCE",
    CONFIG_SPEC.CARTETHYIA_CONCURRENCY_TOLERANCE,
  );
  return value === undefined ? 0 : Math.max(0, value);
}

/**
 * The effective concurrency for this process.
 *
 * Takes the limit as an argument rather than resolving it here: the limit
 * owner is `resolveMemoryLimitBytes()` in `observability/runtime-metrics.ts`,
 * and duplicating that resolution would let the two drift.
 */
export function resolveProcessConcurrency(memoryLimitBytes: number): number {
  return deriveProcessConcurrency({
    memoryLimitBytes,
    maxBodyBytes: resolveMaxBodyBytes(),
    override: resolveProcessConcurrencyOverride(),
  });
}
