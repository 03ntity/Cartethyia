/**
 * Exponential backoff utilities for retry logic and scheduling.
 *
 * This module is the single owner of the delay calculation; callers pick the
 * jitter policy that matches their traffic shape instead of re-implementing
 * the formula:
 *
 * - "none" — the bare bound, for callers that schedule their own delay.
 * - "additive" — bound plus a random 0..+25% slice. Used by
 *   `network/util/retry.ts` (idempotent lookups): additive jitter keeps the
 *   mean delay near the bound while still desynchronizing a herd.
 * - "full" — `random() * bound`, the AWS-style full jitter used by
 *   `protocol/failure-classify.ts` `fallbackRetryDelayMs` for candidate
 *   failover, where the first retry should land anywhere inside the window.
 */

/** How the computed bound is randomized before it is returned. */
export type BackoffJitterPolicy = "none" | "additive" | "full";

export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterPolicy?: BackoffJitterPolicy;
}

/**
 * Calculate exponential backoff delay for a given attempt.
 *
 * @param attempt - The attempt number (0-indexed for first retry)
 * @param options - Backoff configuration
 * @returns The delay in milliseconds
 *
 * Formula: min(maxDelayMs, baseDelayMs * 2^max(0, attempt))
 * t"additive"t adds 0..+25% random jitter to avoid thundering herd;
 * t"full"t returns a uniform draw in [0, bound) and stays unrounded so
 * sub-millisecond bounds (and env-configured caps below 1ms) survive.
 */
export function exponentialBackoff(attempt: number, options: BackoffOptions): number {
  const { baseDelayMs, maxDelayMs, jitterPolicy = "none" } = options;
  const bound = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));

  if (jitterPolicy === "full") {
    return Math.random() * bound;
  }
  if (jitterPolicy === "additive") {
    const jitterAmount = bound * 0.25 * Math.random();
    return Math.round(bound + jitterAmount);
  }

  return bound;
}
