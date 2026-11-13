// The Cursor Run lifecycle: open, continue, rebase, and origin/roster
// resolution.
//
// This controller owns how a Run comes into being and how a pending tool
// result resolves back into it: `#startRun` opens a fresh Run (with the
// donor's bounded retry/backoff and checkpoint resume), `#continueRun` writes
// one tool result into the held Run, and `#cleanupRun` drops every per-Run
// trace on a terminal path. The frame pump (`CursorFramePump`) is owned here:
// every leg ends by delegating to it, and every teardown clears its per-Run
// maps.
//
// State is not stored here: the per-Run maps live in the `CursorAdapterState`
// bag the adapter shell owns and passes in.
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { readCredentialSecret } from "../../provider-contracts";
import { CURSOR_PROVIDER_ID, RUN_IDLE_TTL_MS, isAllowedAgentHost } from "./cursor-shared";
import {
  buildCancelAction,
  buildMcpResult,
  buildRunRequest,
  historyFromRequest,
  liveUserText,
  systemPromptFrom,
  toolDescriptorsFor,
} from "./cursor-request";
import { openCursorRunWithFallback, isRetryableOpenFailure, openRetryDelayMs } from "./cursor-http2";
import type { CursorRunTransport } from "./cursor-http2";
import {
  classifyCursorFailure,
  createCheckpointState,
  createRunCompletion,
} from "./cursor-hardening";
import { cursorRunSessions } from "./cursor-session-manager";
import type { CursorRunSession } from "./cursor-session-manager";
import { fetchCursorRunOrigin, fetchCursorModels, defaultParameterValues } from "./cursor-catalog";
import type { CursorModelInfo } from "./cursor-catalog";
import { collectImages } from "./cursor-images";
import { rosterCacheGet, rosterCachePeek, rosterCacheSet } from "./cursor-roster";
import {
  CURSOR_MAX_OPEN_RETRIES,
  isCompleteToolHistoryReplay,
  missingToolCallIds,
  readPendingToolResult,
  sessionScope,
  structuredCursorFailure,
  toolCallIds,
  type PendingToolResult,
} from "./cursor-run-support";
import { resolveCursorWireModelId } from "./cursor-run-model";
import { CursorFramePump } from "./cursor-run-pump";
import {
  cursorRequestCancelledError,
  cursorRunUpstreamFailure,
  type CursorAdapterState,
  type RunHandle,
} from "./cursor-adapter-state";

/** The refusal every continuation leg raises when the held Run is gone. */
function cursorRunGoneError(): GatewayError {
  return new GatewayError(
    "invalid_request",
    400,
    "Cursor Run is no longer live (request {requestId}). The session went cold — reconnect or resend 🔌",
  );
}

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

/** Optional client-version override for transport tests and live probes. */
const clientVersionOverride = (() => {
  const raw = process.env.CARTETHYIA_CURSOR_CLIENT_VERSION?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
})();

/**
 * The Cursor Run lifecycle controller: open, continue, rebase, and origin/
 * roster resolution. Owns the frame pump for the legs it serves.
 */
export class CursorRunLifecycle {
  readonly pump: CursorFramePump;

  constructor(private readonly state: CursorAdapterState) {
    this.pump = new CursorFramePump(state);
  }

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
    const handle = this.state.handles.get(runId);
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
      yield* this.pump.runPump({
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
    this.state.handles.set(runId, handle);
    this.state.frameState.set(runId, {
      completion: createRunCompletion(),
      checkpoint: createCheckpointState(),
      kindsSinceCheckpoint: [],
      quietBeats: 0,
      serverToolCount: 0,
      transport: transport.mode,
      attempt,
    });
    if (retry?.checkpoint !== undefined) {
      const state = this.state.frameState.get(runId);
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
      yield* this.pump.runPump({
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
      const state = this.state.frameState.get(runId);
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

  /**
   * Opens the Run's single frame reader, delegated to the frame pump.
   */
  #startReader(runId: string, handle: RunHandle): void {
    this.pump.runReader(runId, handle);
  }

  /** Drains every still-running exec handler before a Run is finalized. */
  async #drainDispatches(runId: string, signal?: AbortSignal): Promise<void> {
    await this.pump.drainDispatches(runId, signal);
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
    this.state.handles.delete(runId);
    this.pump.cleanupReader(runId);
    this.state.frameState.delete(runId);
    this.state.dispatches.delete(runId);
    this.state.wireTraces.delete(runId);
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
}
