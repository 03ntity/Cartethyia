/**
 * `sanitizeRequestToolIds` rebuild-only-on-hit: the prepare path runs this on
 * every request, so a history whose ids are all already valid must return the
 * same request reference — and a partially-invalid history must keep the
 * identity of every message it did not touch.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";
import { sanitizeRequestToolIds } from "../../src/protocol/translation/tool-id";

function requestWith(messages: CanonicalMessage[]): CanonicalRequest {
  return {
    model: "claude-sonnet-4-5",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function call(id: string): ContentPart {
  return { kind: "toolCall", call_id: id, name: "t", arguments: "{}" };
}

function result(id: string): ContentPart {
  return { kind: "toolResult", call_id: id, content: "ok", is_error: false };
}

describe("sanitizeRequestToolIds — rebuild only on hit", () => {
  test("an all-valid history returns the same request reference", () => {
    const request = requestWith([
      { role: "assistant", content: [call("call_1")] },
      { role: "tool", content: [result("call_1")] },
    ]);
    expect(sanitizeRequestToolIds(request)).toBe(request);
  });

  test("an invalid call id is rewritten and its result follows the mapping", () => {
    const request = requestWith([
      { role: "assistant", content: [call("call:bad")] },
      { role: "tool", content: [result("call:bad")] },
    ]);
    const sanitized = sanitizeRequestToolIds(request);
    expect(sanitized).not.toBe(request);
    const newCallId = (sanitized.messages[0]!.content[0] as { call_id: string }).call_id;
    expect(newCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect((sanitized.messages[1]!.content[0] as { call_id: string }).call_id).toBe(newCallId);
  });

  test("untouched messages keep their identity", () => {
    const clean: CanonicalMessage = { role: "user", content: [{ kind: "text", text: "hi" }] };
    const dirty: CanonicalMessage = { role: "assistant", content: [call("bad:id")] };
    const request = requestWith([clean, dirty]);
    const sanitized = sanitizeRequestToolIds(request);
    expect(sanitized.messages[0]).toBe(clean);
    expect(sanitized.messages[1]).not.toBe(dirty);
  });

  test("an orphan invalid result is sanitized even with no invalid call", () => {
    const request = requestWith([
      { role: "tool", content: [result("orphan:id")] },
    ]);
    const sanitized = sanitizeRequestToolIds(request);
    const id = (sanitized.messages[0]!.content[0] as { call_id: string }).call_id;
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(id).not.toBe("orphan:id");
  });
});
