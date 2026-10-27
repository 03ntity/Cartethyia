/**
 * A qoder request must carry its tool calls.
 *
 * The translator emitted every assistant turn as text only: it handled
 * `toolResult` parts and then fell through to a text-only emit for everything
 * else, so the `toolCall` parts on an assistant turn were dropped. The payload
 * still carried the `tool` results, so the upstream received a transcript whose
 * results had no calls and rejected the whole request:
 *
 *   Messages with role 'tool' must be a response to a preceding message with
 *   'tool_calls'
 *
 * Recorded as request `eb9e4493`, 862 calls in and 0 out.
 */
import { expect, test } from "bun:test";
import { buildQoderRequest } from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

// `QoderModelConfig` is not exported, and this test needs no catalog entry:
// the request builder reads only the reasoning flag from it.
const AUTH = { userId: "test", token: "token" } as never;
const CONFIG = { is_reasoning: false } as never;

function build(messages: Array<{ role: "user" | "assistant" | "tool"; content: ContentPart[] }>): Array<Record<string, unknown>> {
  const request = {
    model: "deepseek-v4.1-flash",
    messages,
    generation_controls: { max_tokens: 1024 },
  } as unknown as CanonicalRequest;
  const built = buildQoderRequest("deepseek-v4.1-flash", request, CONFIG, AUTH);
  return (built["messages"] ?? []) as Array<Record<string, unknown>>;
}

const CALL: ContentPart = {
  kind: "toolCall",
  call_id: "call_1",
  name: "read_file",
  arguments: '{"path":"a.txt"}',
};
const RESULT: ContentPart = { kind: "toolResult", call_id: "call_1", content: "hello" };

test("an assistant turn that called a tool carries the call", () => {
  const out = build([
    { role: "user", content: [{ kind: "text", text: "read a.txt" }] },
    { role: "assistant", content: [{ kind: "text", text: "sure" }, CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  const calls = assistant?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
  expect(calls).toBeArray();
  expect(calls?.[0]?.["id"]).toBe("call_1");
  expect((calls?.[0]?.["function"] as Record<string, unknown>)?.["name"]).toBe("read_file");
});

test("the call also appears as a tool_use content block", () => {
  const out = build([
    { role: "assistant", content: [CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  const contents = (assistant?.["contents"] ?? []) as Array<Record<string, unknown>>;
  const block = contents.find((c) => c["type"] === "tool_use");
  expect(block).toBeDefined();
  expect(block?.["id"]).toBe("call_1");
  expect(block?.["name"]).toBe("read_file");
  expect(block?.["input"]).toEqual({ path: "a.txt" });
});

test("a tool result is not duplicated as a user turn", () => {
  // The result's own text was emitted a second time as `user`, doubling the
  // payload. One `tool` turn per result is the whole point of the block scan.
  const out = build([
    { role: "assistant", content: [CALL] },
    { role: "tool", content: [RESULT] },
  ]);
  const results = out.filter((m) => m["role"] === "tool");
  expect(results.length).toBe(1);
  const echoed = out.filter(
    (m) => m["role"] === "user" && String(m["content"] ?? "").includes("hello"),
  );
  expect(echoed.length).toBe(0);
});

test("unparseable arguments become an empty object, as upstream does", () => {
  const out = build([
    { role: "assistant", content: [{ ...CALL, arguments: "not json" } as ContentPart] },
    { role: "tool", content: [RESULT] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  const contents = (assistant?.["contents"] ?? []) as Array<Record<string, unknown>>;
  const block = contents.find((c) => c["type"] === "tool_use");
  expect(block?.["input"]).toEqual({});
});

test("a plain assistant turn is unaffected", () => {
  const out = build([
    { role: "user", content: [{ kind: "text", text: "hi" }] },
    { role: "assistant", content: [{ kind: "text", text: "hello" }] },
  ]);
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["content"]).toBe("hello");
  expect(assistant?.["tool_calls"]).toBeUndefined();
});
