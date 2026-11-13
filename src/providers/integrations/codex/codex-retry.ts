/**
 * Codex 429 capacity-wait planning.
 *
 * A transient quota/overload response is latency, not a terminal error: the
 * upstream names how long the bucket is closed and the dispatch loop can
 * simply wait it out instead of surfacing `quota_exceeded` to the client.
 * This module owns that planning — the pure `codex429WaitMs` clamp, the
 * response-header readers that feed it, and the test-overridable sleep the
 * loop actually pauses on.
 *
 * Split out of `codex.ts`; `codex.ts` re-exports the public symbols so
 * importers keep their existing module path.
 */
import {
  MIN_RETRY_BUDGET_MS,
  sleep as defaultSleep,
} from "../../../protocol/failure-policy";
import { parseUpstreamBackoff } from "../../../protocol/upstream-parsing";

/**
 * Sleep used by the 429 capacity-wait loop, overridable in tests.
 *
 * A real capacity wait is tens of seconds by design, so a test that exercises
 * the loop would otherwise spend that long on the clock or blow its timeout.
 * Production always uses the shared `failure-policy` sleep; only a test swaps
 * it.
 */
let rateLimitSleep = defaultSleep;
export function _setCodexRateLimitSleepForTesting(
  impl: typeof defaultSleep | null,
): void {
  rateLimitSleep = impl ?? defaultSleep;
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return rateLimitSleep(ms, signal);
}

/**
 * Total wall-clock a Codex dispatch may spend *waiting* on 429s.
 *
 * A transient quota/overload response is latency, not a terminal error: the
 * upstream names how long the bucket is closed and the request can simply
 * wait it out instead of surfacing `quota_exceeded` to the client. The budget
 * is what keeps that from becoming an unbounded stall — a server that keeps
 * restating a delay (or states one longer than the request has left) must not
 * hold the attempt open past its own deadline.
 *
 * 5 minutes matches the donor Codex 429 window this closes
 * (`openai-codex-responses.ts:310-311`, research item Codex #2) and is far
 * below the default request deadline, so the deadline clamp below — not this
 * cap — is the binding limit in practice.
 */
const CODEX_429_RETRY_BUDGET_MS = 5 * 60 * 1000;

/** Upper bound on one 429 wait before the deadline clamp. */
const CODEX_429_MAX_WAIT_MS = 60_000;

/** Zero-delay 429 guard. Grows from 50ms, doubling per wait. */
const CODEX_429_MIN_WAIT_MS = 50;

/** The `x-codex-*` window headers, in seconds or epoch seconds. */
function codexWindowResetMs(res: Response): number | undefined {
  for (const header of ["x-codex-primary-reset-at", "x-codex-secondary-reset-at"]) {
    const raw = res.headers.get(header);
    const parsed = raw === null || raw.trim().length === 0 ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const targetMs = parsed >= 1_000_000_000 ? parsed * 1000 : Date.now() + parsed * 1000;
    const remaining = targetMs - Date.now();
    if (remaining > 0) return remaining;
  }
  return undefined;
}

/**
 * The delay the Codex upstream asked us to wait before retrying a 429, in ms.
 *
 * Standard backoff headers first, then the Codex window headers. `null` when
 * the upstream named no delay at all, which is *not* the same as "retry now" —
 * see `codex429WaitMs`.
 */
export function codex429ServerDelayMs(res: Response): number | null {
  const headerDelay = parseUpstreamBackoff(res.headers);
  if (headerDelay !== null) return headerDelay;
  return codexWindowResetMs(res) ?? null;
}

/**
 * How long to actually wait before re-posting a 429, or `null` to stop.
 *
 * Pure — `now` is passed in rather than read, so the clamps are testable
 * without running the clock.
 *
 * Three cases:
 *
 * - **No server-stated delay** — a 429 that names no wait is retired as an
 *   error (current behavior), *except* that the first bare 429 gets one short
 *   backoff, because the rate-limit window itself is the evidence that a retry
 *   is meaningful. UNCONFIRMED: our captures do not show whether Codex emits
 *   `retry-after` on 429, so the header path is unverified against live traffic
 *   and the backoff is the conservative fallback.
 * - **The wait fits** — budget and deadline both leave room, so the stated
 *   delay is honored in full.
 * - **The wait does not fit** — clamped to what is left, or skipped entirely
 *   when less than `MIN_RETRY_BUDGET_MS` would remain, because a re-post the
 *   deadline would kill mid-flight has only turned a fast error into a slow
 *   one.
 */
export function codex429WaitMs(options: {
  readonly serverDelayMs: number | null;
  readonly waitedMs: number;
  readonly retry: number;
  readonly deadline: number;
  readonly now: number;
}): number | null {
  const { serverDelayMs, waitedMs, retry, deadline, now } = options;
  const target =
    serverDelayMs ?? (retry === 0 ? CODEX_429_MIN_WAIT_MS * 2 ** retry : null);
  if (target === null) return null;
  const budgetLeft = CODEX_429_RETRY_BUDGET_MS - waitedMs;
  if (budgetLeft <= 0) return null;
  // Leave the pre-dispatch floor for the re-post itself: the retry has to pay
  // the whole pre-dispatch phase again before the upstream is even called.
  const deadlineLeft = deadline - now - MIN_RETRY_BUDGET_MS;
  if (deadlineLeft <= 0) return null;
  const wait = Math.min(
    target,
    CODEX_429_MAX_WAIT_MS,
    Math.max(budgetLeft, 0),
    Math.max(deadlineLeft, 0),
  );
  return wait > 0 ? wait : null;
}
