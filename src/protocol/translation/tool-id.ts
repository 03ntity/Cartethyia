// Tool-call ID sanitization for canonical requests.
//
// Anthropic-compatible endpoints require tool_use.id / tool_result.tool_use_id
// to match ^[a-zA-Z0-9_-]+$. Canonical requests may carry provider-native IDs
// with characters those endpoints reject, so IDs are normalized here before a
// strict wire encoder runs. The same original→sanitized mapping is applied to
// both the `toolCall` and its matching `toolResult` so pairing is preserved.

import type { CanonicalMessage, CanonicalRequest } from "../canonical-model";

/** Anthropic tool ID contract: alphanumerics, underscore, hyphen only. */
const TOOL_ID_PATTERN: RegExp = /^[a-zA-Z0-9_-]+$/;

const INVALID_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * Strips characters Anthropic tool IDs reject. Responses-style composite
 * `call_id|item_id` values are split first (first segment wins), matching
 * the wire builder's composite handling, so both layers agree instead of
 * one stripping the separator the other splits on. Returns `null` when the
 * input is not a non-empty string or nothing valid remains, so callers can
 * fall back to a deterministic generated ID.
 */
function sanitizeToolId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const base = id.includes("|") ? (id.split("|")[0] ?? id) : id;
  const sanitized = base.replace(INVALID_TOOL_ID_CHARS, "");
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Deterministic positional tool-call ID. Deterministic (no clock/random) so
 * identical histories produce byte-identical requests — cache-friendly and
 * directly testable.
 */
function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName?: string): string {
  const name = toolName ? `_${toolName.replace(INVALID_TOOL_ID_CHARS, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

/**
 * Rewrites every invalid tool-call/tool-result `call_id` to a valid one while
 * keeping call/result pairs matched: an invalid `toolCall` records
 * original→sanitized, and each `toolResult` reuses that mapping. A `toolResult`
 * with no originating call (or a valid one) is left alone; an orphan invalid
 * result is sanitized independently. Returns the same reference when every ID
 * is already valid, otherwise a new request — the input is never mutated.
 */
export function sanitizeRequestToolIds(request: CanonicalRequest): CanonicalRequest {
  const replacements = new Map<string, string>();
  // Hit flag: the prepare path runs this on every request, so a history whose
  // ids are all already valid must cost one scan and zero allocations — the
  // message list is only rebuilt once an invalid id is actually found.
  let hasInvalid = false;

  for (const [msgIndex, message] of request.messages.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      // Results count toward the hit flag too: an orphan invalid result is
      // sanitized independently even when no call needed rewriting.
      if (
        (part.kind === "toolCall" || part.kind === "toolResult") &&
        !TOOL_ID_PATTERN.test(part.call_id)
      ) {
        hasInvalid = true;
      }
      if (part.kind !== "toolCall" || TOOL_ID_PATTERN.test(part.call_id)) continue;
      replacements.set(
        part.call_id,
        sanitizeToolId(part.call_id) ?? generateToolCallId(msgIndex, partIndex, part.name),
      );
    }
  }

  if (!hasInvalid) return request;

  let changed = false;
  let messages: CanonicalMessage[] | undefined;

  for (const [msgIndex, message] of request.messages.entries()) {
    // A message with no invalid id keeps its identity; only messages that
    // actually carry one are rebuilt.
    const needsRewrite = message.content.some(
      (part) =>
        (part.kind === "toolCall" || part.kind === "toolResult") &&
        !TOOL_ID_PATTERN.test(part.call_id),
    );
    if (!needsRewrite) {
      messages?.push(message);
      continue;
    }
    let messageChanged = false;
    const content = message.content.map((part, partIndex) => {
      if (part.kind === "toolCall") {
        if (TOOL_ID_PATTERN.test(part.call_id)) return part;
        const callId =
          replacements.get(part.call_id) ??
          sanitizeToolId(part.call_id) ??
          generateToolCallId(msgIndex, partIndex, part.name);
        messageChanged = true;
        return { ...part, call_id: callId };
      }
      if (part.kind === "toolResult") {
        if (TOOL_ID_PATTERN.test(part.call_id)) return part;
        const callId =
          replacements.get(part.call_id) ??
          sanitizeToolId(part.call_id) ??
          generateToolCallId(msgIndex, partIndex);
        messageChanged = true;
        return { ...part, call_id: callId };
      }
      return part;
    });
    if (messages === undefined) messages = request.messages.slice(0, msgIndex);
    messages.push(messageChanged ? { ...message, content } : message);
    changed = changed || messageChanged;
  }

  return changed ? { ...request, messages: messages ?? request.messages } : request;
}
