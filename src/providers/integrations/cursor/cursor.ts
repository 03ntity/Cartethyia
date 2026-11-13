// The canonical Cursor adapter — facade over the split controllers.
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
//
// The implementation lives in sibling controllers, split by concern:
//
//   - `cursor-run-lifecycle.ts` — Run lifecycle: open / continue / rebase,
//     origin-roster resolution, per-Run teardown;
//   - `cursor-run-pump.ts` — frame pump + server-interaction handling:
//     `#pump`, tool-call flush, exec / interaction / KV handlers, dispatch
//     tracking and drain, and the shared frame reader;
//   - `cursor-adapter-state.ts` — the per-Run state bag both controllers
//     share, plus the shared refusal shapes.
//
// This file keeps the public surface and the `CursorAdapter` class contract.

import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { CURSOR_PROVIDER_ID, resolveCursorWireModelId } from "./cursor-shared";
import { rosterCacheForTests } from "./cursor-roster";
import { CursorRunLifecycle } from "./cursor-run-lifecycle";
import { createCursorAdapterState } from "./cursor-adapter-state";


// Public surface preserved: tests and callers import these from cursor.ts.
export { RunFrameStream } from "./cursor-run-frames";
export { rosterCacheForTests };
export { resolveCursorWireModelId };

export class CursorAdapter implements ProviderAdapter {
  readonly provider_id = CURSOR_PROVIDER_ID;

  /** Run-lifecycle controller (owns the frame pump and shared state). */
  readonly runLifecycle: CursorRunLifecycle;

  constructor() {
    this.runLifecycle = new CursorRunLifecycle(createCursorAdapterState());
  }

  /** Dispatches one canonical request. */
  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    yield* this.runLifecycle.dispatch(request, candidate, context);
  }
}

export function createCursorAdapter(): ProviderAdapter {
  return new CursorAdapter();
}

export const cursorAdapter: ProviderAdapter = createCursorAdapter();
