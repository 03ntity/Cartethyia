// The canonical Cursor adapter.
//
// Cursor speaks Connect-RPC over protobuf on a bidirectional HTTP/2 stream, so
// this adapter frames its own protocol instead of going through a wire codec. It
// owns the whole tool loop in both directions:
//
//   - a Cursor executable tool request becomes a client `tool_call_delta`;
//   - the client's next request carries that tool's result and the *same*
//     upstream Run answers it, so the model continues where it left off.
//
// Two rules govern what is executed. Only Cursor's authoritative
// `exec_server_message.mcp_args` is a tool call — `interaction_update`'s
// `tool_call_started` / `tool_call_completed` are display notifications, and
// Cursor's native shell/filesystem/workspace tools are never run here. And an
// `mcp_args` request is executable only when its namespace and function name
// match a tool the current request declared; anything else is answered
// `rejected` so the model can continue without the gateway ever touching a
// filesystem or a shell on the caller's behalf.

import { GatewayError } from "../../../protocol/gateway-error";
import { asRecord as recordOf } from "../../../shared/coerce";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  UsageRecord,
} from "../../../protocol/canonical-model";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { readCredentialSecret } from "../../provider-contracts";
import type { Http2BidiEndReason } from "../../../network/bidi";
import { CURSOR_PROVIDER_ID, RUN_IDLE_TTL_MS, isAllowedAgentHost } from "./cursor-shared";
import {
  buildAllowlistPrecheckResult,
  buildCancelAction,
  buildExecStreamClose,
  buildExecThrow,
  buildInteractionResponse,
  buildKvGetBlobResult,
  buildKvSetBlobResult,
  buildMcpRejected,
  buildMcpResult,
  buildMcpStateResult,
  buildHeartbeat,
  buildRequestContextResult,
  buildRunRequest,
  historyFromRequest,
  liveUserText,
  systemPromptFrom,
  toolDescriptorsFor,
  type CursorToolDescriptor,
} from "./cursor-request";
import { decodeServerMessages, isRetryableOpenFailure, openRetryDelayMs, openCursorRunWithFallback } from "./cursor-http2";
import type { CursorRunTransport } from "./cursor-http2";
import {
  classifyCursorFailure,
  createCheckpointState,
  createRunCompletion,
  cursorQuietError,
  drainInFlightDispatches,
  frameKindOf,
  frameShapeOf,
  reconcileToolCount,
  wireTraceEnabled,
  CURSOR_WIRE_TRACE_MAX,
  type CursorFrameShape,
} from "./cursor-hardening";
import { cursorRunSessions } from "./cursor-session-manager";
import type { CursorRunSession } from "./cursor-session-manager";
import { fetchCursorRunOrigin } from "./cursor-catalog";
import { defaultParameterValues, fetchCursorModels } from "./cursor-catalog";
import { encodeMessage } from "./protocol/messages";
import { executeNativeTool, resolveExecFrame } from "./cursor-exec";
import { collectImages } from "./cursor-images";
import {
  rosterCacheForTests,
  rosterCacheGet,
  rosterCachePeek,
  rosterCacheSet,
} from "./cursor-roster";
import type { CursorModelInfo } from "./cursor-catalog";
import {
  CURSOR_MAX_OPEN_RETRIES,
  isCompleteToolHistoryReplay,
  missingToolCallIds,
  nonEmptyStringOf,
  readExecutableMcpCall,
  readPendingToolResult,
  sessionScope,
  structuredCursorFailure,
  toolCallIds,
  usageFromTurnEnded,
  type PendingToolResult,
} from "./cursor-run-support";
import {
  RunFrameStream,
  isRunStreamEnd,
  type CursorRunFrameState,
  type RunFrame,
} from "./cursor-run-frames";

// Public surface preserved: tests and callers import these from cursor.ts.
export { RunFrameStream } from "./cursor-run-frames";
export { rosterCacheForTests };

/**
 * Client-heartbeat cadence for every Cursor Run.
 *
 * The edge answers a turn only after it has seen at least one client
 * heartbeat, and the donor pins this to 5s (`heartbeatMs` in its continuation
 * policy). A longer cadence is a Run that streams heartbeats and never
 * answers; a shorter one is traffic the upstream does not ask for.
 */
const CURSOR_HEARTBEAT_INTERVAL_MS = 5_000;

/** Heartbeats with no semantic frame before a Run is declared quiet. */
const CURSOR_QUIET_BEATS = 48; // 48 × 5s = 240s (donor quiet window)

/** Optional client-version override for transport tests and live probes. */
const clientVersionOverride = (() => {
  const raw = process.env.CARTETHYIA_CURSOR_CLIENT_VERSION?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
})();

/** Abortable open-retry backoff. */
function sleepBeforeOpenRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(cursorRequestCancelledError());
      },
      { once: true },
    );
  });
}

/**
 * The refusal every leg raises when the client's abort signal fires. One
 * message for all paths so a cancelled request cannot answer differently
 * depending on where it was parked.
 */
function cursorRequestCancelledError(): GatewayError {
  return new GatewayError(
    "transport_closed",
    499,
    "The request was cancelled (request {requestId}). Send it again whenever ready 🙃",
  );
}

/**
 * The upstream-refusal shape every Cursor Run surface shares: an unexpected
 * failure becomes `platform_unavailable` with the same headline, suffix, and
 * provider detail, so the surfaces cannot drift apart on copy.
 */
function cursorRunUpstreamFailure(error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : new GatewayError(
        "platform_unavailable",
        502,
        `Cursor Run failed (request {requestId}): ${error instanceof Error ? error.message : String(error)}. The upstream came back empty-handed — retry 🌙`,
        { providerId: CURSOR_PROVIDER_ID },
        "upstream",
      );
}

/** The refusal every continuation leg raises when the held Run is gone. */
function cursorRunGoneError(): GatewayError {
  return new GatewayError(
    "invalid_request",
    400,
    "Cursor Run is no longer live (request {requestId}). The session went cold — reconnect or resend 🔌",
  );
}

/** Client-heartbeat cadence the Cursor edge expects (donor `heartbeatMs`). */
const CURSOR_HEARTBEAT_INTERVAL_OVERRIDE = (() => {
  const raw = process.env.CARTETHYIA_CURSOR_HEARTBEAT_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
})();

/** One Run's live state while this adapter is pumping it. */
interface RunHandle {
  readonly transport: CursorRunTransport;
  readonly write: (message: Uint8Array) => Promise<void>;
  close(reason?: string): void;
}

class CursorAdapter implements ProviderAdapter {
  readonly provider_id = CURSOR_PROVIDER_ID;

  /**
   * Dispatches one canonical request.
   *
   * Two entry shapes, decided before anything is dialed:
   *
   * - **Continuation** — the request carries a tool result for a call this
   *   process is holding. The already-open Run is resumed: no new Run, no new
   *   account lease, no new pool slot.
   * - **Fresh turn** — a new Run. If the request carries complete assistant +
   *   tool history but no live session (a restart, or an expired idle Run), the
   *   whole history is rebased into the new Run so the model still sees the
   *   conversation.
   */
  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const pending = readPendingToolResult(request, context);
    if (pending !== undefined && pending.length > 0) {
      yield* this.#continueRun(request, candidate, context, pending);
      return;
    }
    yield* this.#startRun(request, candidate, context);
  }

  /**
   * Resumes the held Run for one tool result.
   *
   * Every pending call must resolve to the *same* Run and the same account. A
   * request whose calls resolve to different Runs — or to no live Run at all —
   * is refused rather than partially applied: writing one result to another
   * account's Run would corrupt both conversations, and silently starting a new
   * Run would answer a tool call the model is still waiting on.
   */
  async *#continueRun(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
    pending: readonly PendingToolResult[],
  ): AsyncIterable<CanonicalEvent> {
    const scope = context.continuation_scope;
    if (scope === undefined) {
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result cannot be matched to a live Cursor Run (request {requestId}); resend the complete conversation. The session went cold — reconnect or resend 🔌",
      );
    }
    const resolvedAll = pending.map((item) => cursorRunSessions.resolveCall(item.callId, scope));
    const resolved = resolvedAll.filter((entry) => entry !== undefined);
    const allSameRun =
      resolved.length === pending.length && new Set(resolved.map((entry) => entry.session.runId)).size === 1;
    // A call id that is live in this process but resolves to nothing under this
    // caller's scope belongs to another tenant's Run. Rebasing over it would
    // surface that conversation under this caller — always a hard refusal.
    const foreignLive = pending.some(
      (item) =>
        cursorRunSessions.resolveCall(item.callId, scope) === undefined &&
        cursorRunSessions.hasAnyCall(item.callId),
    );
    // Complete-replay rebase (donor / oh-my-pi behavior): when the request is
    // the full transcript — every `call_cursor_*` result it carries is paired
    // with a `toolCall` in the same conversation — and no foreign-live call is
    // involved, cancel whatever live Runs its ids still touch and rebuild a
    // fresh Run from history. This covers the cases the old code refused with
    // a hard 400: a replay mixing results of an already-answered leg with a
    // live one ("mixes live Cursor tool results"), and results spanning
    // multiple live Runs. A hard refusal there is what stalled the client loop
    // every time Cursor replays a superseded transcript; the donor instead
    // closes the parked runs and answers with a fresh turn.
    if (!allSameRun) {
      // One scan of the conversation serves both the rebase check and the
      // refusal below.
      const calledIds = toolCallIds(request);
      if (!foreignLive && isCompleteToolHistoryReplay(calledIds, pending)) {
        for (const entry of resolved) {
          cursorRunSessions.terminate(entry.session.runId, "Cursor Run superseded by a rebase");
          this.#cleanupRun(entry.session.runId);
        }
        yield* this.#startRun(request, candidate, context);
        return;
      }
      // Not a safe rebase. Two distinct cases:
      // 1. A partial tail — a result whose `toolCall` is absent from the sent
      //    conversation. That is not a complete replay, so there is nothing
      //    safe to rebase; name the missing ids so the client can resend the
      //    whole transcript.
      // 2. A complete replay that still resolves to mixed runs — either a call
      //    id live under another scope (foreignLive, hard refusal) or results
      //    spanning more than one live Run with a transcript that is not a
      //    complete replay. Both stay refused rather than partially applied.
      const missing = missingToolCallIds(calledIds, pending);
      if (missing.length > 0) {
        throw new GatewayError(
          "invalid_request",
          400,
          "This tool result has no matching tool call in the sent conversation (request {requestId}); resend the complete conversation. The session went cold — reconnect or resend 🔌",
          { callIds: missing },
        );
      }
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result refers to a Cursor tool call that is no longer pending (request {requestId}). Resend the complete conversation. The session went cold — reconnect or resend 🔌",
        { callIds: pending.map((item) => item.callId) },
      );
    }
    const runId = resolved[0]?.session.runId;
    if (runId === undefined || cursorRunSessions.get(runId) === undefined) {
      // Unreachable: every path that leaves `allSameRun` false throws above or
      // rebases. This keeps the non-null narrowing legible for the rest.
      throw cursorRunGoneError();
    }
    const session = cursorRunSessions.get(runId);
    if (session === undefined) {
      // Same "gone" state as above; the narrowing keeps the rest of the leg
      // non-null without a cast.
      throw cursorRunGoneError();
    }
    const handle = this.#handles.get(runId);
    if (handle === undefined) {
      // The Run's socket is gone even though the record survived (a transport
      // failure the pump did not observe). Rebase rather than answer into a
      // dead stream.
      cursorRunSessions.terminate(runId, "Cursor Run transport is gone");
      this.#cleanupRun(runId);
      yield* this.#startRun(request, candidate, context);
      return;
    }
    let sequence = 0;
    const next = (): number => (sequence += 1);
    try {
      try {
        for (const item of pending) {
          const entry = cursorRunSessions.resolveCall(item.callId, scope);
          if (entry === undefined) continue;
          await handle.write(
            buildMcpResult({
              execId: entry.call.execId,
              ...(entry.call.execIdString === undefined ? {} : { execIdString: entry.call.execIdString }),
              text: item.text,
              isError: item.isError,
              ...(item.images.length > 0 ? { images: item.images } : {}),
            }),
          );
          // Cleared only after the write succeeded: a half-delivered result
          // must stay pending so a retry answers the same call, never a new one.
          cursorRunSessions.clearPendingCall(runId, item.callId);
        }
      } catch (error) {
        // The Run's transport rejected a result that the model is waiting on.
        // The call was never delivered: terminate the held Run and rebase the
        // whole transcript into a fresh Run (donor rule — a lost owner rebuilds
        // Chat history on a fresh Run; a result is never replayed into an
        // uncertain transport twice). Failing the request here instead left the
        // client loop stuck: every resend hit the same dead handle.
        cursorRunSessions.terminate(
          runId,
          `Cursor Run rejected a tool result: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#cleanupRun(runId);
        yield* this.#startRun(request, candidate, context);
        return;
      }
      yield* this.#pump({
        request,
        candidate,
        context,
        handle,
        runId,
        session,
        next,
        continuation: true,
      });
    } finally {
      // The Run stays open only while it still owes an answer. A terminal close
      // is the session manager's single release path.
      if (cursorRunSessions.get(runId) === undefined) {
        this.#cleanupRun(runId);
      } else if (session.pending.size === 0) {
        cursorRunSessions.terminate(runId);
        this.#cleanupRun(runId);
      }
    }
  }

  async *#startRun(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
    retry?: {
      readonly attempt: number;
      readonly requestId: string;
      readonly conversationId: string;
      readonly checkpoint?: Uint8Array;
      readonly forceH1?: boolean;
      readonly rotateConversation?: boolean;
    },
  ): AsyncIterable<CanonicalEvent> {
    const attempt = retry?.attempt ?? 0;
    const outboundHttp2 = context.outbound_http2;
    const outboundFetch = context.outbound_fetch as unknown as typeof fetch | undefined;
    if (outboundHttp2 === undefined && outboundFetch === undefined) {
      throw new GatewayError(
        "admission_unavailable",
        503,
        "Cursor requires validated egress for its Run transport (request {requestId}); none is configured for this route. No bridge to cross — configure a pool first 🏗️",
        { providerId: CURSOR_PROVIDER_ID },
      );
    }
    const credential = readCredentialSecret(
      context.credential,
      "Cursor account credential is missing or empty; reconnect the account",
    );
    const origin = await this.#resolveOrigin(credential, context);
    const rawModelId = candidate.model_id.length > 0 ? candidate.model_id : request.model;
    const modelId = resolveCursorWireModelId(rawModelId);
    // Cursor declares per-model parameter tuples (effort / context / fast). A
    // fresh Run must carry the model's declared default tuple: with an empty
    // `parameters` the Run streams only heartbeats and never turns.
    const roster = await this.#rosterFor(credential, context);
    const rosterEntry =
      roster.find((model) => model.id === modelId) ??
      roster.find((model) => model.id === rawModelId) ??
      roster.find((model) => model.id.toLowerCase() === "default") ??
      roster.find((model) => model.id.toLowerCase() === "auto");
    const parameterValues = defaultParameterValues(rosterEntry);
    const images = await collectImages(request, context);
    const descriptors = toolDescriptorsFor(request.tools);
    const systemPrompt = systemPromptFrom(request);
    const conversationId = retry?.conversationId ?? crypto.randomUUID();
    const runId = crypto.randomUUID();
    // Bounded open retries with the donor's backoff: connection and deadline
    // failures retry; auth, quota, and request-shape refusals do not. Inside
    // each attempt the transport policy applies (HTTP/2 first, HTTP/1.1 when
    // HTTP/2 is blocked here), so a network that cannot carry HTTP/2 still
    // serves Cursor without the caller ever seeing a transport error.
    let opened: { transport: CursorRunTransport; requestId: string } | undefined;
    let openError: unknown;
    for (let openAttempt = 0; openAttempt <= CURSOR_MAX_OPEN_RETRIES; openAttempt += 1) {
      if (context.abort_signal.aborted) {
        throw cursorRequestCancelledError();
      }
      try {
        opened = await openCursorRunWithFallback({
          origin,
          credential,
          outboundHttp2,
          outboundFetch,
          signal: context.abort_signal,
          ...(retry?.requestId === undefined ? {} : { requestId: retry.requestId }),
          ...(retry?.forceH1 === true ? { forceH1: true } : {}),
          ...(clientVersionOverride === undefined ? {} : { clientVersion: clientVersionOverride }),
        });
        break;
      } catch (error) {
        openError = error;
        if (!isRetryableOpenFailure(error) || openAttempt === CURSOR_MAX_OPEN_RETRIES) throw error;
        await sleepBeforeOpenRetry(openRetryDelayMs(openAttempt), context.abort_signal);
      }
    }
    if (opened === undefined) throw openError;
    const transport = opened.transport;
    let closed = false;
    const handle: RunHandle = {
      transport,
      write: (message) => transport.write(message),
      close: (reason) => {
        if (closed) return;
        closed = true;
        if (reason !== undefined && reason.length > 0) {
          void transport.write(buildCancelAction(reason)).catch(() => undefined);
        }
        transport.abort();
      },
    };
    this.#handles.set(runId, handle);
    this.#frameState.set(runId, {
      completion: createRunCompletion(),
      checkpoint: createCheckpointState(),
      kindsSinceCheckpoint: [],
      quietBeats: 0,
      serverToolCount: 0,
      transport: transport.mode,
      attempt,
    });
    if (retry?.checkpoint !== undefined) {
      const state = this.#frameState.get(runId);
      if (state !== undefined) state.checkpoint.bytes = retry.checkpoint;
    }
    // Reader before the run request: frames can only arrive after it, but the
    // reader must own them from the first byte, across every serving request.
    this.#startReader(runId, handle);
    const session: CursorRunSession = {
      runId,
      conversationId,
      scope: sessionScope(context),
      descriptors,
      pending: new Map(),
      calls: new Map(),
    };
    let sequence = 0;
    const next = (): number => (sequence += 1);
    try {
      await handle.write(
        buildRunRequest({
          text: liveUserText(request),
          modelId,
          conversationId,
          ...(images.length > 0 ? { images } : {}),
          ...(descriptors.length > 0 ? { descriptors } : {}),
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
          ...(parameterValues.length > 0 ? { parameterValues } : {}),
          // A fresh Run always rebases the client's history into its user text:
          // Cursor's own checkpoint cannot be reconstructed after a restart, and
          // `root_prompt_messages_json` would suppress the RequestContext rules.
          // A retry with a checkpoint resumes instead of replaying the turn.
          history: historyFromRequest(request),
          ...(retry?.checkpoint === undefined ? {} : { conversationState: retry.checkpoint }),
          ...(retry?.checkpoint === undefined ? {} : { action: "resume" as const }),
        }),
      );
      // Registered before the first frame is pumped: a tool call can arrive on
      // the very first frame, and the Run must already be claimable.
      cursorRunSessions.register({
        session,
        releaseLease: context.lease_ownership?.transferToProviderSession(),
        close: (reason) => handle.close(reason),
        idleTtlMs: RUN_IDLE_TTL_MS,
      });
      yield* this.#pump({
        request,
        candidate,
        context,
        handle,
        runId,
        session,
        next,
        continuation: false,
      });
    } catch (error) {
      const state = this.#frameState.get(runId);
      const failure = cursorRunUpstreamFailure(error);
      const classification = classifyCursorFailure(
        failure,
        state?.transport ?? transport.mode,
      );
      // Only a Run that produced no observable event can be safely replayed:
      // after the first content_delta/tool_call the client has already seen
      // half an answer. This is the donor's replaySafe rule. A checkpoint
      // carried across the retry stands for the work already done.
      const replaySafe = sequence === 0;
      if (
        replaySafe &&
        classification.retryable &&
        (state?.attempt ?? 0) < CURSOR_MAX_OPEN_RETRIES &&
        !context.abort_signal.aborted
      ) {
        const nextAttempt = (state?.attempt ?? 0) + 1;
        const checkpoint = state?.checkpoint.bytes;
        await this.#drainDispatches(runId, context.abort_signal);
        cursorRunSessions.terminate(runId, failure.message);
        this.#cleanupRun(runId);
        await sleepBeforeOpenRetry(openRetryDelayMs(nextAttempt - 1), context.abort_signal);
        yield* this.#startRun(request, candidate, context, {
          attempt: nextAttempt,
          requestId: opened.requestId,
          conversationId: classification.rotateConversation ? crypto.randomUUID() : conversationId,
          ...(classification.fallbackH1 ? { forceH1: true } : {}),
          ...(checkpoint === undefined || classification.rotateConversation ? {} : { checkpoint }),
        });
        return;
      }
      await this.#drainDispatches(runId, context.abort_signal);
      cursorRunSessions.terminate(runId, failure.message);
      this.#cleanupRun(runId);
      throw structuredCursorFailure(failure, classification, state, runId);
    } finally {
      if (cursorRunSessions.get(runId) === undefined) {
        this.#cleanupRun(runId);
      }
      // A Run whose tool call is registered and unanswered is *held*, not
      // finished. Its pump ended at the interim `tool_use` terminal, but the
      // reader and the heartbeat cadence stay alive so the result leg can
      // resolve the call; tearing the Run down at this boundary loses the call
      // it just handed out, and the next request's tool result resolves nothing.
      else if (session.pending.size === 0) {
        cursorRunSessions.terminate(runId);
        this.#cleanupRun(runId);
      }
    }
  }

  /** Live Run handles, keyed by run id. Process-local, like the sessions. */
  readonly #handles = new Map<string, RunHandle>();
  /** One shared frame reader per live Run, surviving its requests. */
  readonly #readers = new Map<string, RunFrameStream>();
  /** Checkpoint/exec accounting per Run: survives every pump leg. */
  readonly #frameState = new Map<string, CursorRunFrameState>();
  /** Async exec handlers decoded from a chunk, drained on both pump exits. */
  readonly #dispatches = new Map<string, Set<Promise<void>>>();
  /** Opt-in shape-only traces of failed Runs. */
  readonly #wireTraces = new Map<string, CursorFrameShape[]>();

  /** Records one frame's shape (opt-in, never payload text/ids). */
  #trace(runId: string, message: RunFrame): void {
    if (!wireTraceEnabled()) return;
    const trace = this.#wireTraces.get(runId) ?? [];
    if (trace.length < CURSOR_WIRE_TRACE_MAX) trace.push(frameShapeOf(message));
    this.#wireTraces.set(runId, trace);
  }

  /** Tracks one async exec handler; it removes itself when it settles. */
  #trackDispatch(runId: string, dispatch: Promise<void>): void {
    const dispatches = this.#dispatches.get(runId) ?? new Set<Promise<void>>();
    dispatches.add(dispatch);
    void dispatch.finally(() => dispatches.delete(dispatch));
    this.#dispatches.set(runId, dispatches);
  }

  /** Drains every still-running exec handler before a Run is finalized. */
  async #drainDispatches(runId: string, signal?: AbortSignal): Promise<void> {
    const dispatches = this.#dispatches.get(runId);
    if (dispatches === undefined) return;
    await drainInFlightDispatches(dispatches, signal);
  }

  /**
   * Opens the Run's single frame reader.
   *
   * Ownership lives here, not inside a request: every request that serves this
   * Run subscribes to the same queue, so a request that ends between a tool
   * call and its answer cannot cancel the reading of the next one's turn.
   *
   * A reader whose body iterator ended between legs (the edge closes, or a
   * test harness drains the queue) can be restarted on the still-live handle;
   * the Run's continuation then re-opens the read side instead of failing.
   */
  #startReader(runId: string, handle: RunHandle): RunFrameStream {
    const frames = new RunFrameStream();
    this.#readers.set(runId, frames);
    // The client-heartbeat cadence belongs to the reader: the Cursor edge
    // expects a keepalive while the Run stays open, including the window
    // between a tool call and the request that carries its result. A write
    // that failed means the transport died; stop the cadence rather than
    // spinning on a dead stream until the idle TTL fires.
    let state = "open";
    const beat = (): void => {
      if (state !== "open") return;
      void handle.write(buildHeartbeat()).catch(() => {
        state = "failed";
        clearInterval(heartbeatTimer);
      });
    };
    const heartbeatTimer = setInterval(
      beat,
      CURSOR_HEARTBEAT_INTERVAL_OVERRIDE ?? CURSOR_HEARTBEAT_INTERVAL_MS,
    );
    heartbeatTimer.unref();
    const finish = (): void => {
      if (state === "open") state = "closed";
      clearInterval(heartbeatTimer);
    };
    // Stream failures do not always surface as a throw from the body iterator;
    // the terminal event is the authoritative signal (auth revoked, quota,
    // RST_STREAM). `local-close` is our own abort: the session manager already
    // decided the outcome, so the pump just sees a clean end. Normalized over
    // both transports: HTTP/1.1 reports the same terminal kinds.
    const unsubscribeTerminal = handle.transport.onTerminal((terminal) => {
      if (terminal.kind === "local-close") return;
      const endReason: Http2BidiEndReason =
        terminal.kind === "remote-error"
          ? { kind: "remote-error", error: terminal.failure ?? new Error("Cursor Run transport failed") }
          : { kind: terminal.kind };
      // A clean close carries no failure of its own: the pump decides whether
      // a turn without `turn_ended` is complete (text/step/tool batch) or
      // quiet. Inventing "ended before turn_ended" here made every held tool
      // round fail before its call could be handed to the client.
      const terminalFailure =
        terminal.failure ??
        (terminal.kind === "remote-error"
          ? new GatewayError(
              "platform_unavailable",
              502,
              "Cursor Run transport failed (request {requestId}). The upstream came back empty-handed — retry 🌙",
              {},
              "network",
            )
          : undefined);
      frames.end(endReason, terminalFailure);
      unsubscribeTerminal();
    });
    void (async () => {
      try {
        for await (const message of decodeServerMessages(handle.transport.body)) {
          frames.push(message);
        }
        // The body ended without a recorded terminal: treat it as a clean
        // server close so every pump sees an end marker either way.
        frames.end({ kind: "remote-clean-close" }, undefined);
      } catch (error) {
        frames.end({ kind: "remote-error", error: error instanceof Error ? error : new Error(String(error)) }, cursorRunUpstreamFailure(error));
      } finally {
        unsubscribeTerminal();
        finish();
        this.#readers.delete(runId);
      }
    })();
    return frames;
  }

  private cleanupReader(runId: string): void {
    this.#readers.get(runId)?.end({ kind: "local-close" }, undefined);
    this.#readers.delete(runId);
  }

  /**
   * Removes every per-Run trace of a finished Run: handle, reader, frame
   * state, exec dispatch set, and wire trace. Idempotent, and called from
   * every terminal path (finish, failure, retry, rebase) — a Run the session
   * manager released must not keep checkpoint bytes and sets alive in these
   * maps for the life of the process. A held Run (pending tool calls) is
   * never cleaned here: its state belongs to the result leg that answers them.
   */
  #cleanupRun(runId: string): void {
    this.#handles.delete(runId);
    this.cleanupReader(runId);
    this.#frameState.delete(runId);
    this.#dispatches.delete(runId);
    this.#wireTraces.delete(runId);
  }

  /**
   * Resolves the Run origin for one account.
   *
   * Cursor routes an account to a region-specific host, and the wrong host
   * silently refuses the Run; the API host serves auth and catalog calls but is
   * not the origin `GetServerConfig` names for Run. A resolution failure is a
   * transport fault, never a fallback to the API host.
   */
  async #resolveOrigin(credential: string, context: ProviderDispatchContext): Promise<string> {
    try {
      const origin = await fetchCursorRunOrigin({
        credential,
        ...(context.outbound_fetch === undefined
          ? {}
          : { fetcher: context.outbound_fetch as unknown as typeof fetch }),
        signal: context.abort_signal,
      });
      if (!isAllowedAgentHost(new URL(origin).hostname)) {
        throw new Error("resolved origin is not a Cursor host");
      }
      return origin;
    } catch (error) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Cursor Run origin could not be resolved (request {requestId}): ${error instanceof Error ? error.message : String(error)}. The connection ghosted us — come back in a moment 👻`,
        { providerId: CURSOR_PROVIDER_ID },
        "upstream",
      );
    }
  }

  /**
   * The account's model roster, for the default parameter tuple.
   *
   * Cached per credential and never fatal: a Run whose model is not in the
   * roster (or whose roster fetch failed) still runs with no parameters rather
   * than failing the dispatch. The tuple is an optimization, not a requirement.
   */
  async #rosterFor(
    credential: string,
    context: ProviderDispatchContext,
  ): Promise<readonly CursorModelInfo[]> {
    // Peek first: `get` deletes expired entries, but the stale roster must
    // survive as the fallback when the refetch fails (see the catch below).
    const stale = rosterCachePeek(credential);
    const cached = rosterCacheGet(credential);
    if (cached !== undefined) return cached.roster;
    try {
      const roster = await fetchCursorModels({
        credential,
        ...(context.outbound_fetch === undefined
          ? {}
          : { fetcher: context.outbound_fetch as unknown as typeof fetch }),
        signal: context.abort_signal,
      });
      rosterCacheSet(credential, roster);
      return roster;
    } catch {
      return stale?.roster ?? [];
    }
  }

  /**
   * Hands the queued exec calls to the client and closes the leg with the
   * interim `tool_use` terminal.
   *
   * The Run stays open for the result leg; waiting for `turn_ended` here
   * deadlocked the original tool loop. Every pump exit that carries unflushed
   * calls (stream end, mid-loop batch, post-loop drain) routes through here.
   */
  async *#flushToolCalls(
    runId: string,
    next: () => number,
    pendingToolCalls: Array<{ callId: string; toolName: string; arguments: string }>,
  ): AsyncIterable<CanonicalEvent> {
    for (const pending of pendingToolCalls.splice(0)) {
      yield {
        type: "tool_call_delta",
        sequence_number: next(),
        call_id: pending.callId,
        name: pending.toolName,
        arguments_delta: pending.arguments,
      };
    }
    cursorRunSessions.touch(runId);
    yield {
      type: "terminal",
      sequence_number: next(),
      state: "complete",
      stop_reason: "tool_use" as const,
      usage_deferred: true,
    };
  }

  async *#pump(input: {
    readonly request: CanonicalRequest;
    readonly candidate: ProviderDispatchTarget;
    readonly context: ProviderDispatchContext;
    readonly handle: RunHandle;
    readonly runId: string;
    readonly session: CursorRunSession;
    readonly next: () => number;
    readonly continuation: boolean;
  }): AsyncIterable<CanonicalEvent> {
    const { context, handle, runId, session } = input;
    let sawToolCall = false;
    let terminalUsage: UsageRecord | undefined;
    const stopReason: CanonicalStopReason = "stop";
    let failure: GatewayError | undefined;
    const state = this.#frameState.get(runId) ?? {
      completion: createRunCompletion(),
      checkpoint: createCheckpointState(),
      kindsSinceCheckpoint: [],
      quietBeats: 0,
      serverToolCount: 0,
      transport: handle.transport.mode,
      attempt: 0,
    };
    this.#frameState.set(runId, state);
    const pendingToolCalls: Array<{ callId: string; toolName: string; arguments: string }> = [];
    const frames = this.#readers.get(runId) ?? this.#startReader(runId, handle);
    try {
      const messages = frames.subscribe();
      for await (const item of messages) {
        if (isRunStreamEnd(item)) {
          // The reader can end while an exec handler decoded from its last
          // chunk is still registering a call: drain before deciding.
          await this.#drainDispatches(runId, context.abort_signal);
          if (pendingToolCalls.length > 0) {
            yield* this.#flushToolCalls(runId, input.next, pendingToolCalls);
            return;
          }
          if (item.failure !== undefined && item.__streamEnd.kind !== "remote-clean-close") {
            failure = item.failure;
          }
          state.completion.settle(item.failure === undefined ? "end" : "error");
          break;
        }
        const message = item;
        this.#trace(runId, message);
        if (context.abort_signal.aborted) {
          failure = cursorRequestCancelledError();
          state.completion.settle("timeout");
          break;
        }
        // Checkpoint retention: bytes are opaque and are never decoded here.
        // A checkpoint with no semantic frame since the previous one is a
        // repeated one: the streak is what the "went quiet" error names.
        const checkpointBytes = message["conversation_checkpoint_update"];
        if (checkpointBytes instanceof Uint8Array && checkpointBytes.byteLength > 0) {
          state.checkpoint.bytes = new Uint8Array(checkpointBytes);
          state.checkpoint.index += 1;
          state.checkpoint.step += 1;
          state.checkpoint.streak = state.kindsSinceCheckpoint.length === 0 ? state.checkpoint.streak + 1 : 1;
          state.checkpoint.kinds = state.kindsSinceCheckpoint.slice(-8);
          state.kindsSinceCheckpoint = [];
          state.quietBeats = 0;
          continue;
        }
        const kind = frameKindOf(message);
        state.kindsSinceCheckpoint.push(kind);
        if (state.kindsSinceCheckpoint.length > 16) state.kindsSinceCheckpoint.shift();

        const execServer = recordOf(message["exec_server_message"]);
        if (execServer !== undefined) {
          // Exec handlers are async and may outlive the chunk that spawned
          // them. Track the dispatch so BOTH exits drain it before terminal.
          const dispatch = (async () => {
            const handled = await this.#handleExecServerMessage(execServer, session, handle);
            if (handled.kind !== "tool_call") return;
            // Only MCP arms are relayed to the client for execution (client-
            // declared tools). Native tools are answered in-band by the executor.
            const callId = `call_cursor_${runId}_${handled.execId}`;
            const scope = context.continuation_scope;
            if (scope === undefined) {
              // Without a scope, no later request could be authorized to answer
              // this call, so the Run must not be held open for one.
              await handle.write(buildMcpRejected(handled.execId, "tool call is not answerable", handled.execIdString));
              return;
            }
            if (state.checkpoint.completedCallIds.has(callId)) {
              // The server already counted this call (donor rule): answering it
              // twice is what made tool rounds fail with duplicate results.
              return;
            }
            if (!cursorRunSessions.registerPendingCall(runId, {
              callId,
              execId: handled.execId,
              ...(handled.execIdString === undefined ? {} : { execIdString: handled.execIdString }),
              toolName: handled.toolName,
            })) {
              await handle.write(buildMcpRejected(handled.execId, "tool call is not answerable", handled.execIdString));
              return;
            }
            state.checkpoint.pendingCallIds.add(callId);
            state.checkpoint.dispatchedCount += 1;
            sawToolCall = true;
            // The yield happens on the pump's own loop, not inside this async
            // dispatch: the queue below carries the call out to the client.
            pendingToolCalls.push({
              callId,
              toolName: handled.toolName,
              arguments: handled.arguments,
            });
          })().catch((error) => {
            failure = error instanceof GatewayError
              ? error
              : new GatewayError(
                  "platform_unavailable",
                  502,
                  `Cursor exec handler failed (request {requestId}): ${error instanceof Error ? error.message : String(error)}`,
                  { providerId: CURSOR_PROVIDER_ID },
                  "upstream",
                );
          });
          this.#trackDispatch(runId, dispatch);
          continue;
        }

        // Drain handlers before surfacing a tool call: a second exec decoded
        // from the same chunk may still be registering its call, and the
        // client's interim terminal must carry the whole batch (donor park).
        if (pendingToolCalls.length > 0) {
          await this.#drainDispatches(runId, context.abort_signal);
          yield* this.#flushToolCalls(runId, input.next, pendingToolCalls);
          return;
        }

        const kv = recordOf(message["kv_server_message"]);
        if (kv !== undefined && (await this.#handleKvMessage(kv, handle))) continue;

        // A permission gate the edge raises outside the exec channel (hosted
        // web search, Exa, first-call MCP auth, ...). Dropping the frame left
        // the Run alive on heartbeats alone: the tool turn never started and
        // every tools-declaring request stalled to the client until its own
        // timeout. Answering a conservative typed response keeps the turn live.
        const query = recordOf(message["interaction_query"]);
        if (query !== undefined) {
          await this.#handleInteractionQuery(query, handle);
          continue;
        }

        const interaction = recordOf(message["interaction_update"]);
        if (interaction === undefined) continue;

        const textDelta = recordOf(interaction["text_delta"]);
        if (textDelta !== undefined) {
          const text = typeof textDelta["text"] === "string" ? textDelta["text"] : "";
          if (text.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: input.next(),
              content: { kind: "text", text },
            };
          }
          continue;
        }
        const thinking = recordOf(interaction["thinking_delta"]);
        if (thinking !== undefined) {
          const text = typeof thinking["text"] === "string" ? thinking["text"] : "";
          if (text.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: input.next(),
              content: { kind: "reasoning", payload: null, summary: text },
            };
          }
          continue;
        }
        // `tool_call_started` / `tool_call_completed` are display notifications,
        // but their count is authoritative for the step boundary: a step whose
        // calls are all counted is done without waiting out its heartbeats
        // (magpie 0.2.35 / oh-my-pi StepCalls rule).
        const listed = recordOf(interaction["tool_requests_listed"]);
        if (listed !== undefined) {
          const count = typeof listed["call_count"] === "number" ? listed["call_count"] : 0;
          state.checkpoint.expectedCallCount = count;
          continue;
        }
        const completed = recordOf(interaction["tool_call_completed"]);
        if (completed !== undefined) {
          state.serverToolCount += 1;
          const callId = typeof completed["call_id"] === "string" ? completed["call_id"] : "";
          if (callId.length > 0) state.checkpoint.completedCallIds.add(callId);
          const endStep = reconcileToolCount(state.checkpoint, state.serverToolCount);
          if (endStep) {
            state.checkpoint.step = 0;
            state.quietBeats = 0;
          }
          continue;
        }
        const heartbeat = recordOf(interaction["heartbeat"]);
        if (heartbeat !== undefined) {
          state.quietBeats += 1;
          // A Run that keeps heartbeating after a checkpoint with no semantic
          // frame is "quiet": name the checkpoint instead of hanging forever.
          if (state.quietBeats >= CURSOR_QUIET_BEATS) {
            failure = cursorQuietError(state.checkpoint);
            state.completion.settle("timeout");
            break;
          }
          continue;
        }
        // `turn_ended` is authoritative for the turn's end and its usage.
        const turnEnded = recordOf(interaction["turn_ended"]);
        if (turnEnded !== undefined) {
          terminalUsage = usageFromTurnEnded(turnEnded);
          state.completion.settle("end");
          break;
        }
      }
    } catch (error) {
      failure = cursorRunUpstreamFailure(error);
      state.completion.settle("error");
    }
    // BOTH exits drain: an exec handler decoded from the last chunk can still
    // be running when the transport fails (donor L1198-L1201).
    await this.#drainDispatches(runId, context.abort_signal);
    // A dispatch that settled during the drain may have queued a call. Hand it
    // to the client before any terminal event, so a call is never lost.
    if (pendingToolCalls.length > 0) {
      yield* this.#flushToolCalls(runId, input.next, pendingToolCalls);
      return;
    }

    if (failure !== undefined) {
      const classification = classifyCursorFailure(failure, state.transport);
      const structured = structuredCursorFailure(failure, classification, state, runId);
      cursorRunSessions.terminate(runId, structured.message);
      yield {
        type: "terminal",
        sequence_number: input.next(),
        state: "failed",
        stop_reason: "error",
        // The refusal text, so the caller sees the checkpoint/transport reason
        // instead of a terminal with no reason attached.
        stop_details: { code: structured.code, status: structured.status, message: structured.message },
        ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
      };
      return;
    }
    if (sawToolCall) {
      // Defensive: the interim terminal was already emitted with the call; the
      // ends-fast path below must not terminate the held Run.
      cursorRunSessions.touch(runId);
      yield {
        type: "terminal",
        sequence_number: input.next(),
        state: "complete",
        stop_reason: "tool_use" as const,
        usage_deferred: true,
      };
      return;
    }
    cursorRunSessions.terminate(runId);
    yield {
      type: "terminal",
      sequence_number: input.next(),
      state: "complete",
      stop_reason: stopReason,
      ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
    };
  }

  /**
   * Handles one Cursor exec request.
   *
   * The control paths are mandatory, not optional: `request_context_args`,
   * `mcp_state_exec_args`, and the KV channel all stall the Run forever if the
   * client never answers. `mcp_args` — only for a declared tool — and the host
   * exec variants the client itself declared (`shell_args` → its shell tool,
   * `write_args`, `read_args`) become tool calls: the client executes them
   * locally. Every other variant is refused rather than executed here.
   */
  async #handleExecServerMessage(
    execServer: Record<string, unknown>,
    session: CursorRunSession,
    handle: RunHandle,
  ): Promise<
    | { kind: "handled" }
    | {
        kind: "tool_call";
        execId: number;
        execIdString: string | undefined;
        toolName: string;
        arguments: string;
      }
  > {
    const execId = typeof execServer["id"] === "number" ? execServer["id"] : 0;
    // Newer builds pair exec replies by this frame's UUID as well as the
    // numeric id: a reply carrying only the numeric id is never matched and
    // the Run strands on heartbeats waiting for a result that already left.
    const execIdString = nonEmptyStringOf(execServer["exec_id"]);
    if (recordOf(execServer["request_context_args"]) !== undefined) {
      await handle.write(buildRequestContextResult(execId, probeContextFor(session.descriptors), execIdString));
      return { kind: "handled" };
    }
    if (recordOf(execServer["mcp_state_exec_args"]) !== undefined) {
      await handle.write(buildMcpStateResult(execId, session.descriptors, execIdString));
      return { kind: "handled" };
    }
    // Allowlist prechecks precede the real call. They are approval probes, not
    // invocations. Shell is allowlisted because the native executor runs it
    // locally; MCP is allowlisted only when the tool is client-declared
    // (relayed to the client); web fetch is never executed and stays denied.
    const precheckKind = recordOf(execServer["shell_allowlist_precheck_args"]) !== undefined
      ? "shell"
      : recordOf(execServer["mcp_allowlist_precheck_args"]) !== undefined
        ? "mcp"
        : recordOf(execServer["web_fetch_allowlist_precheck_args"]) !== undefined
          ? "web_fetch"
          : undefined;
    if (precheckKind !== undefined) {
      const allowlisted =
        precheckKind === "shell" ? true
        : precheckKind === "web_fetch" ? false
        : this.mcpArgsAreDeclared(execServer, session.descriptors);
      await handle.write(buildAllowlistPrecheckResult(execId, precheckKind, execIdString, allowlisted));
      return { kind: "handled" };
    }
    // Native exec frames (`read_args`, `shell_args`, `ct_read_args`, …) are
    // executed locally by this gateway — not relayed to the client and not
    // refused. The executor returns the wire result message for the frame's
    // result oneof, so a reply can only come back in the arm it arrived on.
    // Frames the executor does not implement fall through to the refusal.
    const execFrame = resolveExecFrame(execServer);
    if (execFrame !== undefined) {
      const executed = await executeNativeTool(execFrame.frameKey, execFrame.args, process.cwd());
      if (executed !== undefined) {
        await handle.write(
          encodeMessage("AgentClientMessage", {
            exec_client_message: {
              id: execId,
              exec_id: execIdString ?? "",
              [executed.field]: executed.message,
            },
          }),
        );
        return { kind: "handled" };
      }
    }
    // MCP remains for client-declared tools: they have no native slot, so a
    // declared `mcp_args` arm is relayed to the client as an ordinary tool
    // call. Undeclared MCP is refused.
    const mcpArgs = recordOf(execServer["mcp_args"]);
    if (mcpArgs !== undefined) {
      const call = readExecutableMcpCall(mcpArgs, session.descriptors);
      if (call === undefined) {
        await handle.write(
          buildMcpRejected(execId, "this tool is not one the request declared", execIdString),
        );
        return { kind: "handled" };
      }
      return {
        kind: "tool_call",
        execId,
        execIdString,
        toolName: call.toolName,
        arguments: call.arguments,
      };
    }
    const refusal = "this tool is not one the request declared";
    await handle.write(buildExecThrow(execId, refusal, execIdString));
    await handle.write(buildExecStreamClose(execId, execIdString));
    return { kind: "handled" };
  }

  /**
   * True when an MCP allowlist precheck targets a tool the request actually
   * declared (so it can be relayed to the client). Undeclared MCP is denied.
   */
  mcpArgsAreDeclared(
    execServer: Record<string, unknown>,
    descriptors: readonly CursorToolDescriptor[],
  ): boolean {
    const precheck = recordOf(execServer["mcp_allowlist_precheck_args"]);
    if (precheck === undefined) return false;
    const toolName = nonEmptyStringOf(precheck["tool_name"]);
    if (toolName === undefined) return false;
    return descriptors.some((d) => d.toolName === toolName);
  }

  /**
   * Answers one interaction query so the Run RPC can continue.
   *
   * Hosted web search, Exa, web fetch, and the first-call MCP auth gate block
   * the turn until the client writes an `interaction_response`; dropping the
   * frame left the stream alive on heartbeats that are not semantic progress.
   * Network permission gates are approved (the gateway already serves the
   * model through its own validated egress), interactive prompts are rejected
   * in band, and VM setup is left unanswered rather than reporting a fake
   * success.
   */
  async #handleInteractionQuery(query: Record<string, unknown>, handle: RunHandle): Promise<void> {
    const queryId = typeof query["id"] === "number" ? query["id"] : 0;
    const body = recordOf(query["query"]);
    const queryVariant = body === undefined ? undefined : Object.keys(body)[0];
    const rejectReason = "this gateway runs headless and cannot answer interactive prompts";
    switch (queryVariant) {
      case "web_search_request_query":
        await handle.write(buildInteractionResponse(queryId, "web_search_request_response", {
          approved: {},
        }));
        return;
      case "web_fetch_request_query":
        await handle.write(buildInteractionResponse(queryId, "web_fetch_request_response", {
          approved: {},
        }));
        return;
      case "ask_question_interaction_query":
        await handle.write(buildInteractionResponse(queryId, "ask_question_interaction_response", {
          result: { rejected: { reason: rejectReason } },
        }));
        return;
      case "switch_mode_request_query":
        await handle.write(buildInteractionResponse(queryId, "switch_mode_request_response", {
          rejected: { reason: rejectReason },
        }));
        return;
      case "create_plan_request_query":
        await handle.write(buildInteractionResponse(queryId, "create_plan_request_response", {
          result: { error: { error: rejectReason } },
        }));
        return;
      case "pr_management_request_query":
        await handle.write(buildInteractionResponse(queryId, "pr_management_result", {
          rejected: { reason: rejectReason },
        }));
        return;
      case "mcp_auth_request_query":
        await handle.write(buildInteractionResponse(queryId, "mcp_auth_request_response", {
          rejected: { reason: rejectReason },
        }));
        return;
      case "generate_image_request_query":
        await handle.write(buildInteractionResponse(queryId, "generate_image_request_response", {
          rejected: { reason: rejectReason },
        }));
        return;
      case "replace_env_args":
        await handle.write(buildInteractionResponse(queryId, "replace_env_result", {
          failure: { error_message: rejectReason },
        }));
        return;
      case "connect_scm_request_query":
        await handle.write(buildInteractionResponse(queryId, "connect_scm_request_response", {
          rejected: { reason: rejectReason },
        }));
        return;
      case "setup_vm_environment_args":
        // Result oneof is success-only: do not invent a VM; silence is better
        // than a false SetupVmEnvironmentSuccess.
        return;
      default:
        return;
    }
  }

  /** Answers one KV blob request; `false` when the message carried none. */
  async #handleKvMessage(kv: Record<string, unknown>, handle: RunHandle): Promise<boolean> {
    const id = typeof kv["id"] === "number" ? kv["id"] : 0;
    if (recordOf(kv["set_blob_args"]) !== undefined) {
      await handle.write(buildKvSetBlobResult(id));
      return true;
    }
    const getArgs = recordOf(kv["get_blob_args"]);
    if (getArgs !== undefined) {
      const blobId = getArgs["blob_id"];
      const data = blobId instanceof Uint8Array ? blobId : new Uint8Array(0);
      await handle.write(buildKvGetBlobResult(id, data));
      return true;
    }
    return false;
  }
}

/** RequestContext Cursor receives in reply to a context probe. */
function probeContextFor(descriptors: readonly CursorToolDescriptor[]): Record<string, unknown> {
  return {
    tools: descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      input_schema: descriptor.inputSchema,
      provider_identifier: descriptor.providerIdentifier,
      tool_name: descriptor.toolName,
    })),
    mcp_info_complete: true,
    rules_info_complete: true,
    env_info_complete: true,
  };
}

export function createCursorAdapter(): ProviderAdapter {
  return new CursorAdapter();
}

export const cursorAdapter: ProviderAdapter = createCursorAdapter();
/** Maps virtual/canonical client model IDs to upstream Cursor wire IDs. */
function resolveCursorWireModelId(rawModelId: string): string {
  const id = rawModelId.trim().toLowerCase();
  // Only `auto` is an alias: Cursor's own roster names its Auto model
  // `default`. `grok-4.6` is already the upstream id, and rewriting it to
  // `cursor-grok-4.6` made every Grok Run answer "AI Model Not Found".
  if (id === "auto") return "default";
  return rawModelId;
}
