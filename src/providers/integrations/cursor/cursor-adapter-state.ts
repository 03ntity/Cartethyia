// Shared runtime context for the Cursor adapter's split controllers.
//
// The adapter shell (cursor.ts) owns one `CursorAdapterState` bag — the live
// per-Run maps that outlive any single request — and hands the same instance to
// both internal controllers:
//
//   - `CursorRunLifecycle` (cursor-run-lifecycle.ts) opens/continues Runs and
//     resolves origins and rosters;
//   - `CursorFramePump` (cursor-run-pump.ts) pumps frames and answers server
//     interactions.
//
// The refusal shapes below are shared by both controllers so a cancelled or
// failed request cannot answer differently depending on the leg that hit it.
import { GatewayError } from "../../../protocol/gateway-error";
import type { CursorRunTransport } from "./cursor-http2";
import type { CursorRunFrameState } from "./cursor-run-frames";
import type { RunFrameStream } from "./cursor-run-frames";
import type { CursorFrameShape } from "./cursor-hardening";
import { CURSOR_PROVIDER_ID } from "./cursor-shared";

/** One Run's live state while the adapter is pumping it. */
export interface RunHandle {
  readonly transport: CursorRunTransport;
  readonly write: (message: Uint8Array) => Promise<void>;
  close(reason?: string): void;
}

/** Per-Run maps shared by the lifecycle and frame-pump controllers. */
export interface CursorAdapterState {
  /** Live Run handles, keyed by run id. Process-local, like the sessions. */
  readonly handles: Map<string, RunHandle>;
  /** One shared frame reader per live Run, surviving its requests. */
  readonly readers: Map<string, RunFrameStream>;
  /** Checkpoint/exec accounting per Run: survives every pump leg. */
  readonly frameState: Map<string, CursorRunFrameState>;
  /** Async exec handlers decoded from a chunk, drained on both pump exits. */
  readonly dispatches: Map<string, Set<Promise<void>>>;
  /** Opt-in shape-only traces of failed Runs. */
  readonly wireTraces: Map<string, CursorFrameShape[]>;
}

export function createCursorAdapterState(): CursorAdapterState {
  return {
    handles: new Map<string, RunHandle>(),
    readers: new Map<string, RunFrameStream>(),
    frameState: new Map<string, CursorRunFrameState>(),
    dispatches: new Map<string, Set<Promise<void>>>(),
    wireTraces: new Map<string, CursorFrameShape[]>(),
  };
}

/**
 * The refusal every leg raises when the client's abort signal fires. One
 * message for all paths so a cancelled request cannot answer differently
 * depending on where it was parked.
 */
export function cursorRequestCancelledError(): GatewayError {
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
export function cursorRunUpstreamFailure(error: unknown): GatewayError {
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
