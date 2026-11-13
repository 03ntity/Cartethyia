// Shared tool call/result pairing sweep.
//
// Every orphan-repair pass needs the same two sets before it can apply its
// policy: which call ids were declared, and which have a matching result
// somewhere in the history. This module owns that scan so the policies that
// consume it (`repairMissingToolResponses`, `dropOrphanToolResults`,
// `repairOrphanedCodexToolExchanges`) cannot drift on what "paired" means.
//
// The policies themselves stay split, deliberately:
// - `repairMissingToolResponses` / `dropOrphanToolResults` (this directory)
//   judge pairing *positionally* — a result answers only calls in earlier
//   messages — because a replayed stale turn must not satisfy a later call
//   that reuses the same id.
// - `repairOrphanedCodexToolExchanges` (request/codex.ts) pairs by bare id
//   across the whole history, then *folds* orphan results into a user note
//   and synthesizes placeholder results for orphan calls — the Responses
//   wire rejects an unpaired `function_call_output` outright.
//
// Both read the same `calledIds`/`resultedIds` sets from `toolPairingSweep`;
// only the repair action differs.

import type { CanonicalMessage } from "../canonical-model";
import { canContainToolResult, toolCallParts, toolResultParts } from "../canonical-model";

export interface ToolPairing {
  /** Every `toolCall` id declared on an assistant turn, in first-seen order. */
  readonly calledIds: ReadonlySet<string>;
  /** Every `toolResult` id carried by a result-capable turn (`tool` or `user`). */
  readonly resultedIds: ReadonlySet<string>;
}

/**
 * One forward sweep collecting declared call ids and answered result ids.
 * O(messages·parts), no allocation beyond the two sets.
 */
export function toolPairingSweep(
  messages: readonly CanonicalMessage[],
): ToolPairing {
  const calledIds = new Set<string>();
  const resultedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of toolCallParts(message)) calledIds.add(part.call_id);
    } else if (canContainToolResult(message)) {
      // Results live in `tool` turns or in `user` turns (the Messages ledger
      // re-homes them). A `role === "tool"`-only scan missed every
      // Messages-origin history, so its results read as orphaned and its
      // calls as unanswered — the repair then rewrote a valid exchange.
      for (const part of toolResultParts(message)) resultedIds.add(part.call_id);
    }
  }
  return { calledIds, resultedIds };
}
