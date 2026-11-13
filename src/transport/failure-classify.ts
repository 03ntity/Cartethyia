/**
 * Failure classification and retry policy, split out of `failure-policy.ts`
 * (which re-exports this module so existing importers are unchanged).
 *
 * `classifyUpstreamFailure` / `classifyUpstreamError` decide what one failure
 * means for fallback routing and account health; the `classifyTerminal*`
 * family derives the three terminal telemetry fields from one decision so
 * they can never disagree; `fallbackRetryDelayMs` / `MIN_RETRY_BUDGET_MS` /
 * `sleep` are the shared retry mechanics every retry site must agree on.
 */
import { GatewayError, type GatewayErrorCode, type GatewayErrorOrigin } from "../protocol/gateway-error";
import { resolveFallbackRetryBaseMs, resolveFallbackRetryCapMs } from "../config/timeouts";
import { exponentialBackoff } from "../network/util/backoff";

/** Normalized account-health evidence and retry decision for one failure. */
export interface UpstreamFailurePolicy {
  readonly retryable: boolean;
  readonly mutatesAccount: boolean;
  readonly cooldownMs?: number;
  readonly category: string;
  readonly scope?: "account" | "provider" | "network";
  readonly origin: GatewayErrorOrigin;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  /** Provider that produced the failure, for the buddy policy blocks (`11140`, and `11-128` channel verification). */
  readonly providerId?: string;
}

/** Classifies one dispatch failure for both fallback routing and account health. */
export function classifyUpstreamFailure(error: unknown): UpstreamFailurePolicy {
  if (!(error instanceof GatewayError)) {
    return { retryable: true, mutatesAccount: false, category: "network", scope: "network", origin: "network" };
  }
  const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : undefined;
  const providerId = typeof error.details.providerId === "string" ? error.details.providerId : undefined;
  const credentialEvidence = error.details.credentialEvidence === true || error.details.accountScope === true;
  // The buddy family reuses `11-128` for two unrelated rejections, so the code
  // alone is not evidence:
  //
  // - "conversation id missing" — a malformed outbound request. The fault is
  //   this gateway's, so cooling the account would burn a healthy credential
  //   on a body that fails identically everywhere.
  // - "request illegal" / "failed channel verification … not sent from an
  //   official client" — a verdict on the account's channel. Proven account-
  //   scoped: two live share-page requests carrying byte-identical bodies and
  //   headers to the same model differed only in the pooled account, and the
  //   blocked one 400'd while the other 200'd (2026-10-16).
  //
  // Only the second may mutate account health, hence the message test.
  const message = error.message.toLowerCase();
  const channelBlockEvidence =
    providerCode === "11-128" &&
    (message.includes("request illegal") || message.includes("channel verification"));
  const policyAccountEvidence = providerCode === "11140" || channelBlockEvidence;
  let scope: "network" | "account" | "provider";
  if (error.origin === "network") scope = "network";
  else if (credentialEvidence || policyAccountEvidence) scope = "account";
  else scope = "provider";
  const retryAfterMs = typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : undefined;
  // The retry decision follows `statusToGatewayErrorCode` — the canonical
  // status→code table in `upstream-errors.ts` — rather than a hand-rolled range.
  // The two disagreed:
  // the table classifies the whole 500–599 band as `platform_unavailable`, while
  // this predicate retried only 500–504. An upstream 505/507/520/522/524/530/599
  // therefore produced a `platform_unavailable` error that this called terminal,
  // and `runAttemptLoop` stopped on it (`!isRetryableFailure(error)` sets
  // `terminalAttempt`) even with healthy candidates left.
  //
  // The reachable cases are exactly the ones failover exists for: Cloudflare
  // answers 520/521/522/523/524 when the ORIGIN is down or timing out — a
  // per-route condition a sibling candidate would survive — and 530 is an origin
  // DNS failure. Failing the client request instead of failing over is the wrong
  // outcome for a whole class the table already names as platform-wide.
  const statusCode = error.status;
  const retryableByStatus =
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 429 ||
    (statusCode >= 500 && statusCode <= 599);
  const mutatesAccount = error.origin === "upstream" && scope === "account";
  const retryable =
    // Gateway-wide overload: no sibling candidate can help, because the whole
    // process is short of memory. The correct move is the client retrying after
    // the hint, not another attempt here.
    error.code === "overloaded"
      ? false
      : mutatesAccount || // account-scoped failure: try a sibling regardless of status
        error.code === "capability_unsupported" ||
    error.code === "model_not_found" ||
    error.code === "admission_unavailable" ||
    error.code === "route_unavailable" ||
    error.code === "capacity_exhausted" ||
    error.code === "upstream_overloaded" ||
    // A provider max-inflight rejection: the plan's next sibling account may
    // have a free slot, exactly as with an API-key concurrency rejection.
    error.code === "provider_capacity_exhausted" ||
    // The upstream accepted the request and is holding it in a queue. Another
    // account of the same provider is very likely not queued, so failover is
    // the faster answer — and if every account is queued, the caller still has
    // the stated interval to wait for.
    error.code === "upstream_queued" ||
    error.code === "accounts_unavailable" ||
    error.code === "accounts_rate_limited" ||
    error.code === "quota_exceeded" ||
    error.code === "rate_limited" ||
    error.code === "authentication_failed" ||
    error.code === "proxy_auth_required" ||
    error.code === "deadline_exceeded" ||
    // An overflow is a property of the window the *chosen* route offers, not
    // of the request: a sibling on a larger window may take it unchanged. 413
    // is not in `retryableByStatus`, so without this the client got the first
    // candidate's overflow even when a candidate that fit was next in line.
    // Nothing here shrinks or rewrites the prompt — a candidate that fits is
    // tried verbatim, and only exhausting them returns the overflow.
    error.code === "context_length_exceeded" ||
    retryableByStatus;
  return {
    retryable,
    mutatesAccount,
    category: error.code,
    scope,
    origin: error.origin,
    ...(providerCode ? { providerCode } : {}),
    ...(providerId ? { providerId } : {}),
    ...(credentialEvidence ? { credentialEvidence: true } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, cooldownMs: retryAfterMs }),
    statusCode: error.status,
  };
}

/**
 * Transport-level failure signatures a runtime fetch body can raise when the
 * upstream socket dies mid-response. Bun (this gateway's runtime) raises
 * `TypeError` with `code: "ECONNRESET"` ("The socket connection was closed
 * unexpectedly"); Node/undici raises `TypeError: terminated`; libuv surfaces
 * `ECONNRESET`/`EPIPE` on the error. All mean the same thing: the upstream
 * connection dropped — an upstream transport failure, not an unexplained
 * gateway fault.
 */
function isUpstreamSocketDrop(error: unknown): boolean {
  if (!(error instanceof TypeError) && !(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string") {
    if (error.code === "ECONNRESET" || error.code === "EPIPE" || error.code === "UND_ERR_SOCKET") {
      return true;
    }
  }
  const message = String(error.message ?? "");
  return (
    message.includes("socket connection was closed unexpectedly") ||
    message.startsWith("terminated") ||
    message.includes("other side closed")
  );
}

/**
 * Terminal telemetry category for one failed attempt.
 *
 * A raw abort is not an unexplained gateway failure: our own deadline timers
 * abort with a `TimeoutError`, a client disconnect bridges the inbound signal
 * or the stream's `cancel()` (both `AbortError`s), and the stall watchdog
 * aborts with a `GatewayError` the reader may surface only as an abort.
 * Labeling every non-GatewayError `unknown_error` recorded ordinary client
 * cancels as "the upstream failure could not be classified" — blameless
 * diagnostics lost the real outcome. Only a failure with no abort behind it
 * stays unknown.
 */
export function classifyTerminalCategory(
  error: unknown,
  signal: AbortSignal,
): GatewayErrorCode | "unknown_error" {
  if (error instanceof GatewayError) return error.code;
  const reason: unknown = signal.reason;
  // The reader often rejects with a bare AbortError while the signal carries
  // the actual cause (watchdog deadline, shutdown).
  if (reason instanceof GatewayError) return reason.code;
  if (signal.aborted) {
    if (reason instanceof DOMException && reason.name === "TimeoutError") return "deadline_exceeded";
    return "transport_closed";
  }
  // A mid-response upstream socket drop reaches here as a raw runtime error:
  // the upstream's transport failed, so the blame is upstream, not unknown.
  if (isUpstreamSocketDrop(error) || isUpstreamSocketDrop(reason)) {
    return "transport_unavailable";
  }
  return "unknown_error";
}

/**
 * Whether a failed attempt is a **client cancel** — the one case the console
 * records as `cancelled` (499) rather than `failed`.
 *
 * The request controller aborts for three different reasons, and only one of
 * them is the client's:
 *
 * - **Client disconnect** — the inbound signal bridges the client's
 *   `AbortError`; the request truly has no client left.
 * - **Deadline / stall watchdog** — our own timer aborts with a
 *   `deadline_exceeded` `GatewayError` or a `TimeoutError`. The client is
 *   still there and is owed the 504/502.
 * - **Drain** — a shutdown `GatewayError`; the caller gets a 503.
 *
 * Reading `signal.aborted` alone conflated all three: a request that failed
 * because the upstream ended without a terminal event (`transport_unavailable`,
 * 502) was recorded `cancelled`/499 whenever the watchdog had also fired,
 * producing a row whose status (499), error category (`transport_unavailable`)
 * and http status (502) disagreed — the drawer could not be trusted. The
 * decision must key on *why* the controller aborted, not that it did.
 *
 * A `transport_closed` `GatewayError` is our own "no client left" marker (the
 * attempt loop raises it when the signal is already aborted at entry), so it
 * counts as a cancel even without a signal reason. Every other abort —
 * including a bare `AbortError` whose signal reason is a watchdog/drain
 * `GatewayError` — is a failure, not a cancel.
 */
export function isClientCancellation(error: unknown, signal: AbortSignal): boolean {
  // A typed error names the outcome directly: only our own "no client left"
  // marker is a cancel, whatever the signal says.
  if (error instanceof GatewayError) return error.code === "transport_closed";
  // Otherwise the reader rejected with a bare abort and the signal reason says
  // why. A watchdog (deadline/stall) or drain abort is a gateway-side outcome.
  const reason: unknown = signal.reason;
  if (reason instanceof GatewayError) return false;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return false;
  return signal.aborted && reason instanceof DOMException && reason.name === "AbortError";
}

/** The three terminal fields that must never disagree about one failed attempt. */
export interface TerminalOutcome {
  readonly status: "cancelled" | "failed";
  readonly errorCategory: GatewayErrorCode | "unknown_error";
  readonly errorOrigin: GatewayErrorOrigin;
  /**
   * The HTTP status the row should carry. `undefined` means the caller has a
   * better one (the wire status of an actual response) and should keep it;
   * a raw error has none, and the caller's own fallback was 500 — which
   * read as a gateway fault for what was an upstream transport drop.
   */
  readonly httpStatus?: number;
}

/** The HTTP status each classifier-derived category carries when no wire response named one. */
const CATEGORY_HTTP_STATUS: Partial<Record<GatewayErrorCode | "unknown_error", number>> = {
  // The upstream's transport died mid-response: a bad gateway, not a fault
  // in this process.
  transport_unavailable: 502,
  platform_unavailable: 502,
  upstream_overloaded: 529,
  deadline_exceeded: 504,
  transport_closed: 499,
  shutting_down: 503,
  overloaded: 529,
  route_unavailable: 503,
  model_not_allowed: 403,
  rate_limited: 429,
  unknown_error: 500,
};

/**
 * Derives a failed attempt's status, error category, and error origin **from
 * one decision**, so the three can never contradict each other.
 *
 * Computing them independently at a dispatch call site lets them
 * drift: a request that failed on an upstream condition could be recorded
 * `cancelled` (499) while its category said `transport_unavailable` and its
 * http status said 502 — a row no operator could trust. Bundling them here
 * makes the inconsistency unrepresentable: a cancel always carries
 * `transport_closed` (the only category a cancel can produce), and any other
 * outcome carries the real code and origin.
 */
export function classifyTerminalOutcome(error: unknown, signal: AbortSignal): TerminalOutcome {
  const category = classifyTerminalCategory(error, signal);
  const gateway = error instanceof GatewayError ? error : signal.reason instanceof GatewayError ? signal.reason : undefined;
  return {
    status: isClientCancellation(error, signal) ? "cancelled" : "failed",
    errorCategory: category,
    // The classifier owns the blame. An upstream socket drop arrives as a
    // raw runtime error — no `GatewayError` wraps it — and calling that ours
    // made the row accuse the gateway for an upstream failure.
    errorOrigin: gateway
      ? gateway.origin
      : category === "transport_unavailable"
        ? "upstream"
        : "cartethyia",
    // A `GatewayError` carries its own status; a raw error takes the
    // category's, so an upstream drop is 502 rather than the 500 fallback.
    ...(gateway || CATEGORY_HTTP_STATUS[category] !== undefined
      ? { httpStatus: gateway ? gateway.status : CATEGORY_HTTP_STATUS[category] }
      : {}),
  };
}

/** True when fallback routing should try another candidate. */
export function isRetryableFailure(error: unknown): boolean {
  return classifyUpstreamFailure(error).retryable;
}

/**
 * Minimum wall-clock budget a follow-on attempt needs to be worth starting.
 *
 * A retry repeats the whole pre-dispatch phase — credential resolution,
 * admission, pool slot, request preparation — so it needs at least this much
 * headroom on top of whatever the upstream itself takes. Below this, the
 * attempt is killed by the deadline before it can return anything usable, and
 * starting it replaces the first attempt's real error with a second one's
 * timeout.
 *
 * Owned here so the attempt loop, the empty-stream replay, and the Codex
 * retry budget cannot drift apart.
 */
export const MIN_RETRY_BUDGET_MS = 15_000;

/**
 * Capped exponential backoff with full jitter for a zero-based attempt index.
 * The base and cap are operator-tunable (`CARTETHYIA_FALLBACK_RETRY_BASE_MS`,
 * `CARTETHYIA_FALLBACK_RETRY_CAP_MS`) and default to 100ms / 2000ms.
 *
 * Used for every retry delay, including the empty-stream replay: jitter keeps
 * concurrent clients from resynchronizing, and the cap keeps a provider that
 * returns 200-with-no-events from driving an unbounded wait.
 */
export function fallbackRetryDelayMs(attemptIndex: number): number {
  // The bound is `min(cap, base * 2^attempt)`; `Math.max(0, attemptIndex)` only
  // matters for a negative index, which no caller produces — the shared helper
  // clamps it so the formula stays monotone in attempt number.
  return exponentialBackoff(attemptIndex, {
    baseDelayMs: resolveFallbackRetryBaseMs(),
    maxDelayMs: resolveFallbackRetryCapMs(),
    jitterPolicy: "full",
  });
}

/** Sleeps until the delay expires or the request is aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃"));
  if (ms <= 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃")); };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
