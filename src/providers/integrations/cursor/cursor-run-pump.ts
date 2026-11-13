// The Cursor Run frame pump and server-interaction handling.
//
// This controller owns the loop that consumes one Run's decoded frames and
// answers what the edge asks: exec requests (`#handleExecServerMessage`),
// interaction queries (`#handleInteractionQuery`), KV blob requests
// (`#handleKvMessage`), and the tool-call flush that hands queued MCP calls to
// the client with the interim `tool_use` terminal. It also owns the Run's
// single frame reader (heartbeat cadence and terminal wiring) and the exec
// dispatch tracking/drain that must settle before any terminal decision.
//
// State is not stored here: the per-Run maps live in the `CursorAdapterState`
// bag the adapter shell owns and passes in, so one Run's state survives the
// controllers that serve its legs.
import { GatewayError } from "../../../protocol/gateway-error";
import { asRecord as recordOf } from "../../../shared/coerce";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  UsageRecord,
} from "../../../protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import type { Http2BidiEndReason } from "../../../network/bidi";
import {
  buildAllowlistPrecheckResult,
  buildExecStreamClose,
  buildExecThrow,
  buildInteractionResponse,
  buildKvGetBlobResult,
  buildKvSetBlobResult,
  buildMcpRejected,
  buildMcpStateResult,
  buildHeartbeat,
  buildRequestContextResult,
  type CursorToolDescriptor,
} from "./cursor-request";
import { decodeServerMessages } from "./cursor-http2";
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
} from "./cursor-hardening";
import { cursorRunSessions } from "./cursor-session-manager";
import type { CursorRunSession } from "./cursor-session-manager";
import { encodeMessage } from "./protocol/messages";
import { executeNativeTool, resolveExecFrame } from "./cursor-exec";
import {
  nonEmptyStringOf,
  readExecutableMcpCall,
  structuredCursorFailure,
  usageFromTurnEnded,
} from "./cursor-run-support";
import {
  RunFrameStream,
  isRunStreamEnd,
  type RunFrame,
} from "./cursor-run-frames";
import {
  cursorRunUpstreamFailure,
  cursorRequestCancelledError,
  type CursorAdapterState,
  type RunHandle,
} from "./cursor-adapter-state";

/** Client-heartbeat cadence for every Cursor Run. */
const CURSOR_HEARTBEAT_INTERVAL_MS = 5_000;

/** Heartbeats with no semantic frame before a Run is declared quiet. */
const CURSOR_QUIET_BEATS = 48; // 48 × 5s = 240s (donor quiet window)

/** Client-heartbeat cadence the Cursor edge expects (donor `heartbeatMs`). */
const CURSOR_HEARTBEAT_INTERVAL_OVERRIDE = (() => {
  const raw = process.env.CARTETHYIA_CURSOR_HEARTBEAT_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
})();

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

/**
 * The frame-pump controller: one shared reader plus the per-Run map
 * bookkeeping, the pump loop, and the server-interaction handlers.
 */
export class CursorFramePump {
  constructor(private readonly state: CursorAdapterState) {}

  /** Records one frame's shape (opt-in, never payload text/ids). */
  #trace(runId: string, message: RunFrame): void {
    if (!wireTraceEnabled()) return;
    const trace = this.state.wireTraces.get(runId) ?? [];
    if (trace.length < CURSOR_WIRE_TRACE_MAX) trace.push(frameShapeOf(message));
    this.state.wireTraces.set(runId, trace);
  }

  /** Tracks one async exec handler; it removes itself when it settles. */
  #trackDispatch(runId: string, dispatch: Promise<void>): void {
    const dispatches = this.state.dispatches.get(runId) ?? new Set<Promise<void>>();
    dispatches.add(dispatch);
    void dispatch.finally(() => dispatches.delete(dispatch));
    this.state.dispatches.set(runId, dispatches);
  }

  /** Drains every still-running exec handler before a Run is finalized. */
  async #drainDispatches(runId: string, signal?: AbortSignal): Promise<void> {
    const dispatches = this.state.dispatches.get(runId);
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
    this.state.readers.set(runId, frames);
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
        this.state.readers.delete(runId);
      }
    })();
    return frames;
  }

  /** Ends and forgets the Run's reader (also used by the lifecycle teardown). */
  cleanupReader(runId: string): void {
    this.state.readers.get(runId)?.end({ kind: "local-close" }, undefined);
    this.state.readers.delete(runId);
  }

  /**
   * Opens the Run's single frame reader. Public for the lifecycle opener; the
   * frame pump uses the same path when a leg finds the reader already gone.
   */
  runReader(runId: string, handle: RunHandle): RunFrameStream {
    return this.#startReader(runId, handle);
  }

  /**
   * Drains every still-running exec handler before a Run is finalized. Public
   * for the lifecycle teardown; the pump drains on both exits itself.
   */
  async drainDispatches(runId: string, signal?: AbortSignal): Promise<void> {
    await this.#drainDispatches(runId, signal);
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
    const state = this.state.frameState.get(runId) ?? {
      completion: createRunCompletion(),
      checkpoint: createCheckpointState(),
      kindsSinceCheckpoint: [],
      quietBeats: 0,
      serverToolCount: 0,
      transport: handle.transport.mode,
      attempt: 0,
    };
    this.state.frameState.set(runId, state);
    const pendingToolCalls: Array<{ callId: string; toolName: string; arguments: string }> = [];
    const frames = this.state.readers.get(runId) ?? this.#startReader(runId, handle);
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
                  { providerId: "cursor" },
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

  /**
   * Runs the pump for a live Run leg.
   *
   * Public entry for the lifecycle controller; all per-Run state lives in the
   * shared `CursorAdapterState` bag.
   */
  async *runPump(input: {
    readonly request: CanonicalRequest;
    readonly candidate: ProviderDispatchTarget;
    readonly context: ProviderDispatchContext;
    readonly handle: RunHandle;
    readonly runId: string;
    readonly session: CursorRunSession;
    readonly next: () => number;
    readonly continuation: boolean;
  }): AsyncIterable<CanonicalEvent> {
    yield* this.#pump(input);
  }
}
