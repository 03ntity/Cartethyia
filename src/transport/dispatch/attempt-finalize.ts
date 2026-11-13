// Attempt completion bookkeeping: one home for everything every dispatch attempt ends with.
import { GatewayError, publicGatewayErrorBody } from "../../protocol/gateway-error";
import type { UsageRecord } from "../../protocol/canonical-model";
import {
  classifyUpstreamFailure,
} from "../../protocol/failure-classify";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestOutcome, ProxyRequestState } from "../request/state";
import { finalizeRequestTelemetry } from "../guards/error-lifecycle";
import { debitCachedQuota, quotaLens } from "../../providers/quota/cache";
import { BUDDY_PROVIDER_IDS } from "../../providers/provider-metadata";
import { modelsDevCatalog } from "../../providers/discovery/models-dev-catalog";
import {
  disablePoolForProxyHttpStatus,
  recordPoolDispatchOutcome,
} from "../../network/pool/health";
import { ProxyConnectRefusalError } from "../../network/pool/agent";
import { reportAttemptOutcome } from "../../providers/operations/account-health-service";
// Provider-exchange payload capture lives in its sibling module; re-export the
// public capture API here so importers of `attempt-finalize` keep working.
import { captureTerminalPayload } from "./capture-payload";
import type { ProviderExchangeCapture } from "./capture-payload";
export { parseCapturedBody } from "./capture-payload";
export { captureProviderExchange } from "./capture-payload";
export { providerRequestMetadataOnly } from "./capture-payload";
export { resolvedProviderResponse } from "./capture-payload";
export type { ProviderExchangeCapture } from "./capture-payload";

/**
 * What the client received for a failed terminal attempt, in the same public
 * envelope the error middleware sends on the wire (`{ error: { origin, code,
 * message, details } }`). Stored so Request Detail's "Client Response"
 * panel can trace an error exactly as the client saw it, including for failures
 * that never produced a response body.
 */
export function errorClientResponseBody(error: unknown): string {
  if (error instanceof GatewayError) {
    // Same serializer the error middleware sends on the wire, so the stored
    // copy cannot drift from what the client received.
    return JSON.stringify(publicGatewayErrorBody(error));
  }
  return JSON.stringify({
    error: { origin: "cartethyia", code: "internal_error", message: "Internal server error" },
  });
}

/**
 * Maps a missing or non-successful upstream terminal event to the GatewayError
 * the client should see.
 *
 * Shared by the streaming and non-streaming dispatch paths so both report the
 * same code, status and message for the same upstream condition. The stream
 * path passes `truncated` because it can distinguish "ended early" from "never
 * terminated"; the non-stream path cannot.
 */
export function terminalFailure(
  terminal: { readonly state: string; readonly stop_reason?: string; readonly provider_stop_reason?: string; readonly stop_details?: Record<string, unknown> } | undefined,
  options: { readonly truncated?: boolean } = {},
): GatewayError | undefined {
  if (terminal === undefined) {
    // The upstream produced no terminal event: its own stream is what ended
    // without a verdict, so this is an upstream failure, not ours.
    return new GatewayError(
      "transport_unavailable",
      502,
      "The upstream closed the response without reporting a result (request {requestId}). Retry; if it keeps happening, the account or pool is unstable. The connection ghosted us — come back in a moment 👻",
      {},
      "upstream",
    );
  }
  if (terminal.state === "failed") {
    // A terminal `failed` state is only ever written by the upstream decoders
    // (a provider error envelope or a corrupt provider stream), so it carries
    // the upstream's failure, not the gateway's.
    const details: Record<string, unknown> = {};
    if (terminal.provider_stop_reason) details["provider_code"] = terminal.provider_stop_reason;
    if (terminal.stop_details) Object.assign(details, terminal.stop_details);
    const message = typeof details["message"] === "string" ? details["message"] : "upstream request failed (request {requestId}). The upstream came back empty-handed — retry 🌙";
   // Preserve the upstream's error code when the provider embedded it in
   // `stop_details` (Cursor writes `quota_exceeded` and `authentication_failed`
   // there). Wrapping every terminal failure as `transport_unavailable` discarded
   // those codes, so `quota_exceeded` was never seen by the classifier and the
   // exhausted account was never cooled.
   const code = typeof details["code"] === "string" ? details["code"] : undefined;
   const status = typeof details["status"] === "number" ? details["status"] : 502;
   const gatewayCode =
     code === "quota_exceeded" ? "quota_exceeded" :
     code === "authentication_failed" ? "authentication_failed" :
     "transport_unavailable";
   const gatewayStatus =
     gatewayCode === "quota_exceeded" ? 429 :
     gatewayCode === "authentication_failed" ? 401 :
     status;
   return new GatewayError(gatewayCode, gatewayStatus, message, details, "upstream");
  }
  if (terminal.state === "aborted") {
    // A client-initiated cancellation is not an upstream fault; the stream path
    // reports it as truncation instead.
    return options.truncated === true
      ? undefined
      : new GatewayError("transport_closed", 499, "The request was cancelled (request {requestId}). Send it again whenever ready 🙃");
  }
  return undefined;
}

/**
 * A usage record carrying only the request's own token estimate, with no price
 * yet: `estimated_cost` is `null` (unpriced) so the analytics `partial` flag
 * counts it, rather than `0`, which would claim the turn cost nothing. The
 * dispatch call sites reprice it against the routed model before committing.
 */
export function estimatedUsage(inputTokens: number, outputTokens: number): UsageRecord {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
  };
}

/**
 * Single attempt completion: one home for everything every dispatch attempt
 * ends with — outcome recording, usage commit, health report, payload
 * capture, telemetry finalization. Streaming and non-streaming paths build
 * the same completion (outcome literal first, so `state.outcome` keeps its
 * exact per-path shape) and differ only in `terminal`: intermediate
 * failover attempts commit usage + report health but defer capture and
 * telemetry to the terminal attempt, so one request emits exactly one
 * telemetry row however many candidates it tried.
 *
 * Pool cooldown flagging, metrics, client encoding, and failover/refresh
 * decisions stay at the call sites — they are retry/transport policy, not
 * completion bookkeeping.
 */
export interface AttemptCompletion extends ProxyRequestOutcome {
  readonly modelId?: string;
  readonly error?: unknown;
  /**
   * The HTTP status the terminal classifier derived for a raw (non-GatewayError)
   * failure — an upstream socket drop is 502, not the 500 the fallback implied.
   * Only consulted when the error carries no status of its own and no wire
   * response named one.
   */
  readonly terminalHttpStatus?: number;
  readonly lease?: AdmissionLease;
  /** Usage to reconcile, or undefined when this attempt consumed nothing billable. */
  readonly commitUsage?: UsageRecord;
  /** Capture + telemetry run only for the terminal attempt of a request. */
  readonly terminal: boolean;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly responseBody: unknown;
  readonly clientResponseText?: string;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly snapshotService?: { invalidate(): unknown };
  /** First content delta timestamp (for TTFT calculation). */
  readonly firstContentDeltaAtMs?: number;
  /** Last event timestamp (for generation duration calculation). */
  readonly lastEventAtMs?: number;
  /** The model the upstream reported in its own response, verbatim. */
  readonly reportedModel?: string;
}

/**
 * The fields every dispatch completion shares, regardless of outcome.
 *
 * The streaming path and the non-streaming path each assembled this set by
 * hand, so a field added to one (a new telemetry buffer, a snapshot service)
 * could silently miss the other. Callers spread this and add only what differs:
 * status, usage, error classification, and the response body.
 */
export function completionContext(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly accountId?: string | undefined;
  readonly accountLabel?: string | undefined;
  readonly networkPoolId?: string | undefined;
  readonly lease?: AdmissionLease | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
  readonly snapshotService?: { invalidate(): unknown } | undefined;
}): Pick<
  AttemptCompletion,
  | "providerId"
  | "modelId"
  | "tenantId"
  | "ingressBody"
  | "db"
  | "terminal"
  | "accountId"
  | "accountLabel"
  | "networkPoolId"
  | "lease"
  | "providerCapture"
  | "telemetryBuffer"
  | "snapshotService"
> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    tenantId: input.tenantId,
    ingressBody: input.ingressBody,
    ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
    db: input.db,
    terminal: true,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.telemetryBuffer === undefined ? {} : { telemetryBuffer: input.telemetryBuffer }),
    ...(input.snapshotService === undefined ? {} : { snapshotService: input.snapshotService }),
  };
}

/**
 * The terminal-completion base the native routes (generation, responses
 * compact, system one, web search, token count) all assemble. The proxy and
 * streaming paths use `completionContext`; these routes previously spelled
 * the same twelve fields by hand in six places. Callers spread this and add
 * only what differs: status, response body, error classification.
 */
export function nativeCompletionBase(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly lease?: AdmissionLease;
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly snapshotService?: { invalidate(): unknown };
  readonly providerCapture?: ProviderExchangeCapture;
  readonly usage?: AttemptCompletion["usage"];
  readonly commitUsage?: AttemptCompletion["commitUsage"];
}): Omit<
  AttemptCompletion,
  | "status"
  | "responseBody"
  | "httpStatus"
  | "terminalHttpStatus"
  | "error"
  | "clientResponseText"
  | "firstContentDeltaAtMs"
  | "lastEventAtMs"
  | "reportedModel"
  | "errorCategory"
  | "errorOrigin"
  | "ttfbMs"
  | "tokensPerSec"
> {
  return {
    ...completionContext({
      providerId: input.providerId,
      modelId: input.modelId,
      tenantId: input.tenantId,
      ingressBody: input.ingressBody,
      ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
      db: input.db,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
      ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
      ...(input.lease === undefined ? {} : { lease: input.lease }),
      ...(input.telemetryBuffer === undefined ? {} : { telemetryBuffer: input.telemetryBuffer }),
      ...(input.snapshotService === undefined ? {} : { snapshotService: input.snapshotService }),
    }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.commitUsage === undefined ? {} : { commitUsage: input.commitUsage }),
  };
}

/**
 * Decides whether a failed attempt proves *the pool* is unusable, and which
 * HTTP status that verdict rests on.
 *
 * Both a proxy and an upstream can answer 402, and the two mean opposite
 * things: a proxy's 402 says this pool cannot carry traffic (disable it), while
 * an upstream's 402 is that provider's billing verdict on the account that was
 * dialed (cool the account down, leave the pool alone). The status alone
 * cannot separate them, so the decision rides on who answered.
 *
 * A proxy that refuses the CONNECT handshake answers *before* any upstream is
 * dialed, so its status is unambiguously the proxy's own. That refusal is not a
 * `GatewayError` — it is a typed `ProxyConnectRefusalError` — so reading the
 * status off `error.status` alone saw `undefined` here, the 402/407 check never
 * fired, and a pool that had refused to tunnel stayed enabled and kept being
 * selected.
 */
export function resolveProxyDisableDecision(completion: AttemptCompletion): {
  readonly disableProxy: boolean;
  readonly responseHttpStatus: number | undefined;
} {
  const proxyConnectStatus =
    completion.error instanceof ProxyConnectRefusalError
      ? completion.error.statusCode
      : undefined;
  const responseHttpStatus =
    completion.error instanceof GatewayError
      ? completion.error.status
      : (proxyConnectStatus ?? completion.httpStatus);
  // Only a proxy-origin payment/auth response proves the pool itself is unusable;
  // an upstream provider's 402 is a quota/billing response for that provider.
  const errorOrigin =
    completion.error instanceof GatewayError
      ? completion.error.origin
      : proxyConnectStatus !== undefined
        ? "network"
        : completion.errorOrigin;
  const disableProxy =
    completion.networkPoolId !== undefined &&
    completion.status !== "completed" &&
    errorOrigin === "network" &&
    (responseHttpStatus === 402 || responseHttpStatus === 407);
  return { disableProxy, responseHttpStatus };
}

/**
 * Reduces the account's cached pooled balance by the credits this request
 * reported, so the next plan sees the spend instead of the balance the sweep
 * last fetched.
 *
 * Scoped to the buddy family: `credit_used` there is buddy-meter credit, the
 * same unit the cached windows store. Other providers report the field in
 * their own unit, and debiting them would subtract the wrong thing. A missing
 * cache entry, a failed last fetch, or a cache write that throws is left
 * alone — the request already succeeded, and the floor keeps its previous
 * reading until the sweep.
 */
async function debitBuddySpend(completion: AttemptCompletion): Promise<void> {
  if (completion.status !== "completed") return;
  const accountId = completion.accountId;
  const providerId = completion.providerId;
  const credits = completion.usage?.credit_used;
  if (accountId === undefined || providerId === undefined) return;
  if (!BUDDY_PROVIDER_IDS.has(providerId.toLowerCase())) return;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits <= 0) return;
  try {
    await debitCachedQuota(quotaLens(completion.tenantId), accountId, credits, undefined);
  } catch {
    // Swallowed: the balance update is advisory. The sweep corrects it.
  }
}

/**
 * Whether a completed attempt is a "degenerate stop": output far smaller than
 * the model's ceiling, ended by an ordinary `stop` rather than `length`.
 *
 * This is the signature of a model truncating itself on a cached prefix — the
 * pattern that surfaced as short, cut-off chat replies that the upstream still
 * reported as a clean stop. It is measured so the operator can see how often
 * it happens instead of eyeballing request detail.
 */
export function isDegenerateStop(
  usage: UsageRecord | undefined,
  outputLimit: number | undefined,
): boolean {
  if (usage === undefined) return false;
  const output = usage.output_tokens;
  const reasoning = typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : 0;
  const totalOutput = output + reasoning;
  if (totalOutput === 0 || totalOutput > 512) return false;
  // A model with no meaningful ceiling cannot be "far smaller than it can
  // produce", so the flag is only meaningful when a ceiling exists.
  if (!(typeof outputLimit === "number" && Number.isFinite(outputLimit) && outputLimit > 0)) {
    return false;
  }
  return totalOutput <= Math.max(1, Math.floor(outputLimit / 10));
}

export async function completeAttempt(
  state: ProxyRequestState,
  completion: AttemptCompletion,
): Promise<void> {
  // Idempotency guard: the terminal completion claims the request before any
  // await, so a caller that retries completion after a bookkeeping failure
  // (e.g. the streaming error path re-entering after `commitUsage` threw)
  // cannot double-commit usage, report health twice, or emit a second
  // telemetry row. Intermediate failover attempts deliberately leave
  // `completed` clear: they commit their own usage estimate and report
  // health, then the terminal attempt records the real outcome and emits the
  // one telemetry row the request is owed.
  if (state.completed) return;
  // Read before the outcome is frozen. The capture wrapper already started the
  // read when the response arrived; awaiting it here costs nothing on the
  // non-streaming path and only a bounded head-read on the streaming one.
  // Absent means the upstream named no model — never backfilled from the
  // request, which would report the ask as the answer.
  const reportedModel =
    completion.reportedModel ??
    (completion.providerCapture?.reportedModel === undefined
      ? undefined
      : await completion.providerCapture.reportedModel.catch(() => undefined));
  state.outcome = {
    status: completion.status,
    httpStatus:
      completion.httpStatus ??
      (completion.error instanceof GatewayError
        ? completion.error.status
        : completion.terminalHttpStatus ??
          (completion.status === "completed"
            ? 200
            : completion.status === "cancelled"
              ? 499
              : completion.status === "truncated"
                ? 502
                : 500)),
    ...(completion.providerId === undefined ? {} : { providerId: completion.providerId }),
    ...(completion.accountId === undefined ? {} : { accountId: completion.accountId }),
    ...(completion.accountLabel === undefined ? {} : { accountLabel: completion.accountLabel }),
    ...(completion.networkPoolId === undefined ? {} : { networkPoolId: completion.networkPoolId }),
    ...(completion.errorCategory === undefined ? {} : { errorCategory: completion.errorCategory }),
    ...(completion.errorOrigin === undefined ? {} : { errorOrigin: completion.errorOrigin }),
    ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    ...(completion.ttfbMs === undefined ? {} : { ttfbMs: completion.ttfbMs }),
    ...(completion.tokensPerSec === undefined ? {} : { tokensPerSec: completion.tokensPerSec }),
    // The outcome's `reportedModel` key appears exactly once: the precedence
    // lives in the resolution above (completion's own attribution first, then
    // the value read from the upstream bytes).
    ...(reportedModel === undefined ? {} : { reportedModel }),
    ...(completion.firstContentDeltaAtMs === undefined ? {} : { firstContentDeltaAtMs: completion.firstContentDeltaAtMs }),
    ...(completion.lastEventAtMs === undefined ? {} : { lastEventAtMs: completion.lastEventAtMs }),
    ...(completion.status === "completed" &&
    isDegenerateStop(
      completion.usage,
      completion.providerId !== undefined && completion.modelId !== undefined
        ? (modelsDevCatalog.resolve(completion.providerId, completion.modelId)?.outputLimit ?? undefined)
        : undefined,
    )
      ? { degenerateStop: true }
      : {}),
  };
  if (completion.terminal) state.completed = true;
  // Usage reconciliation is bookkeeping, and it is the last thing standing
  // between the caller and its resource release. Letting a store failure
  // propagate from here aborts the completion sequence *after* `completed` is
  // claimed, so the caller's release never runs and the in-flight gauge climbs
  // for the life of the process; the reservation is released unreconciled
  // either way, so the slot is not what is at stake. Swallowed for the same
  // reason the health and pool reports below are: a failed report must not
  // decide the request's outcome.
  if (completion.lease?.commitUsage && completion.commitUsage) {
    try {
      await completion.lease.commitUsage(completion.commitUsage);
    } catch {
      // Swallowed: usage reconciliation is non-critical bookkeeping.
    }
  }
  await debitBuddySpend(completion);
  const { disableProxy, responseHttpStatus } = resolveProxyDisableDecision(completion);
  // Cancelled attempts write no health (client gone; outcome unknown) —
  // matches the historical `!cancelled` guards at every site. Health is
  // advisory: a failed report must never re-enter the retry path (a retry
  // would see `completed` and skip completion entirely), so it is swallowed.
  if (completion.status !== "cancelled" && !disableProxy) {
    // Account health records only failures that are evidence about the
    // provider's own account: upstream verdicts (quota, auth, model
    // capacity, rate limits), or credential-scoped refusals from the
    // upstream. Local rejections — API-key admission (`max_concurrent`,
    // rpm/token budgets), routing capacity, pool selection, request
    // preparation — are decisions this gateway made about its own limits;
    // they say nothing about the account and must not cool it or write a
    // phantom `logged -> cooldown` transition. Success always reports so a
    // cooling account recovers.
    const succeeded = completion.status === "completed";
    const gatewayError = completion.error instanceof GatewayError ? completion.error : undefined;
    const upstreamVerdict = gatewayError?.origin === "upstream";
    const isProxyDeploymentError =
      completion.error instanceof Error ? completion.error.message.toLowerCase().includes("deployment_disabled") || (completion.error.message.toLowerCase().includes("sin1::") && completion.error.message.toLowerCase().includes("deployment")) : false;
    if (succeeded || isProxyDeploymentError || upstreamVerdict) {
      const evidence = isProxyDeploymentError
        ? { scope: "pool" as const, origin: "network" as const }
        : { ...classifyUpstreamFailure(completion.error) };
      try {
        await reportAttemptOutcome(completion.db, {
          accountId: completion.accountId,
          ...(completion.modelId === undefined ? {} : { modelId: completion.modelId }),
          ...(completion.status === "failed"
            ? {
                error: completion.error,
                evidence,
              }
            : {}),
          ...(completion.snapshotService ? { snapshotService: completion.snapshotService } : {}),
        });
      } catch {
        // Swallowed: health reporting is non-critical bookkeeping.
      }
    }
  }
  if (completion.networkPoolId && completion.status !== "cancelled") {
    try {
      if (disableProxy && (responseHttpStatus === 402 || responseHttpStatus === 407)) {
        await disablePoolForProxyHttpStatus(
          completion.db,
          completion.networkPoolId,
          responseHttpStatus,
          completion.snapshotService,
        );
      } else {
        const errorOrigin =
          completion.errorOrigin ??
          (completion.error instanceof ProxyConnectRefusalError ? "network" : undefined);
        await recordPoolDispatchOutcome(completion.db, completion.networkPoolId, {
          succeeded: completion.status === "completed",
          ...(completion.providerId === undefined ? {} : { providerId: completion.providerId }),
          ...(completion.error === undefined ? {} : { error: completion.error }),
          // A CONNECT refusal is the proxy's own answer, given before any
          // upstream was dialed, so it is a network fault even though the
          // error carries no origin of its own. Without one the pool stays in
          // rotation and the next probe dials the same front door.
          ...(errorOrigin === undefined ? {} : { errorOrigin }),
          ...(completion.snapshotService === undefined
            ? {}
            : { snapshotInvalidator: completion.snapshotService }),
        });
      }
    } catch {
      // Pool health is advisory; never fail or retry a completed request for it.
    }
  }
  if (!completion.terminal) {
    // An intermediate failover attempt: the terminal attempt is the one that
    // captures. Named rather than left blank so a request that never reached a
    // terminal attempt is distinguishable from one that did and captured
    // nothing.
    if (state.payloadCaptureState === undefined) {
      state.payloadCaptureState = "skipped_not_terminal";
    }
    return;
  }
  await captureTerminalPayload(
    state,
    completion.db,
    completion.tenantId,
    state.requestId,
    completion.ingressBody,
    completion.responseBody,
    completion.clientResponseText,
    completion.providerCapture,
  );
  if (completion.telemetryBuffer) finalizeRequestTelemetry(state, completion.telemetryBuffer);
}
