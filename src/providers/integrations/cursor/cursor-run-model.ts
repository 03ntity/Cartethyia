// Cursor wire model-id mapping.
//
// The canonical client model ids the gateway exposes are not all Cursor's wire
// ids; this is the single translation point the Run opener uses.

/** Maps virtual/canonical client model IDs to upstream Cursor wire IDs. */
export function resolveCursorWireModelId(rawModelId: string): string {
  const id = rawModelId.trim().toLowerCase();
  // Only `auto` is an alias: Cursor's own roster names its Auto model
  // `default`. `grok-4.6` is already the upstream id, and rewriting it to
  // `cursor-grok-4.6` made every Grok Run answer "AI Model Not Found".
  if (id === "auto") return "default";
  return rawModelId;
}
