/**
 * `repairOrphanedCodexToolExchanges` (request/codex.ts) — the Responses-wire
 * orphan policy that shares `toolPairingSweep` with the canonical repair in
 * translation/tool-repair.ts.
 *
 * The pairing rule itself is covered by the shared sweep; what is pinned here
 * is the *policy* this wire applies to the two orphan sets:
 * - a call with no result gets a synthesized `function_call_output` marked
 *   as an error, inserted right after the assistant turn;
 * - a result with no call is folded into a plain user note instead of an
 *   unpaired `function_call_output`, which the backend rejects outright.
 */
import { describe, expect, test } from "bun:test";
import { canonicalToCodexResponsesPayload } from "../../src/protocol/request/codex";
import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../../src/protocol/canonical-model";

function requestWith(messages: CanonicalMessage[]): CanonicalRequest {
  return {
    model: "gpt-5.6-luna",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "responses",
  };
}

function call(id: string): ContentPart {
  return { kind: "toolCall", call_id: id, name: "t", arguments: "{}" };
}

function result(id: string, content = "ok"): ContentPart {
  return { kind: "toolResult", call_id: id, content, is_error: false };
}

describe("canonicalToCodexResponsesPayload — orphaned tool exchange repair", () => {
  test("an unanswered call gets a synthesized error output item", () => {
    const payload = canonicalToCodexResponsesPayload(
      requestWith([
        { role: "assistant", content: [call("c1")] },
        { role: "user", content: [{ kind: "text", text: "next" }] },
      ]),
    );
    const input = payload["input"] as Record<string, unknown>[];
    const outputs = input.filter((item) => item["type"] === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.["call_id"]).toBe("c1");
    expect(String(outputs[0]?.["output"])).toContain("interrupted");
  });

  test("an unpaired result folds into a user note, not an output item", () => {
    const payload = canonicalToCodexResponsesPayload(
      requestWith([
        { role: "tool", content: [result("ghost", "stale output")] },
      ]),
    );
    const input = payload["input"] as Record<string, unknown>[];
    expect(input.some((item) => item["type"] === "function_call_output")).toBe(false);
    const note = input.find(
      (item) =>
        item["type"] === "message" &&
        JSON.stringify(item["content"]).includes("Previous tool result"),
    );
    expect(note).toBeDefined();
    expect(JSON.stringify(note)).toContain("stale output");
  });

  test("a complete exchange is untouched", () => {
    const payload = canonicalToCodexResponsesPayload(
      requestWith([
        { role: "assistant", content: [call("c1")] },
        { role: "tool", content: [result("c1")] },
      ]),
    );
    const input = payload["input"] as Record<string, unknown>[];
    const outputs = input.filter((item) => item["type"] === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.["output"]).toBe("ok");
    // No synthesized note was folded in.
    expect(
      input.some(
        (item) =>
          item["type"] === "message" &&
          JSON.stringify(item["content"]).includes("Previous tool result"),
      ),
    ).toBe(false);
  });
});
