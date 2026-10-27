import { expect, test } from "bun:test";
import {
  buildQoderRequest,
  parseLeakedToolCalls,
} from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

/**
 * The upstream reads tool calls as prose on its INTL realm, not as structured
 * turns. These pin the two halves of that: a past call is described in the
 * text, and a call the model echoes back in that shape is recovered.
 */

const MARKER = "[assistant 请求调用工具]";

const CONFIG = {
  id: "m",
  display_name: "M",
  max_input_tokens: 128_000,
  is_vl: false,
  is_reasoning: false,
};

const AUTH = {
  userId: "u",
  userName: "n",
  userType: "t",
  securityOauthToken: "s",
  refreshToken: "r",
  machineId: "m",
};

const CALL: ContentPart = {
  kind: "toolCall",
  call_id: "call_1",
  name: "Read",
  arguments: '{"file_path":"a.ts"}',
};

const RESULT: ContentPart = {
  kind: "toolResult",
  call_id: "call_1",
  content: "file body",
};

function build(parts: CanonicalRequest["messages"], realm: "intl" | "cn") {
  const req: CanonicalRequest = {
    model: "m",
    stream: false,
    source_surface: "chat",
    generation_controls: {},
    messages: parts,
  };
  return (buildQoderRequest("m", req, CONFIG, AUTH, realm)["messages"] ??
    []) as Array<Record<string, unknown>>;
}

test("INTL describes a past call in the text instead of dropping it", () => {
  // Dropping it leaves the next `tool` turn answering a call that was never
  // made, and the model re-emits a call with no arguments.
  const out = build([{ role: "assistant", content: [CALL] }, { role: "tool", content: [RESULT] }], "intl");
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["tool_calls"]).toBeUndefined();
  expect(String(assistant?.["content"])).toContain(MARKER);
  expect(String(assistant?.["content"])).toContain("Read");
});

test("CN keeps the structured call", () => {
  const out = build([{ role: "assistant", content: [CALL] }, { role: "tool", content: [RESULT] }], "cn");
  const assistant = out.find((m) => m["role"] === "assistant");
  expect(assistant?.["tool_calls"]).toHaveLength(1);
});

test("an echoed call is recovered from the text", () => {
  const text = `Let me read it.\n\n${MARKER}\n[{"name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}]`;
  const { calls, clean } = parseLeakedToolCalls(text);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("Read");
  expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ file_path: "a.ts" });
  expect(clean).toBe("Let me read it.");
});

test("a call naming an undeclared tool is not recovered", () => {
  // The marker is easy to reproduce; a name the caller never declared means
  // this is the model talking, not a call.
  const text = `${MARKER}\n[{"name":"Nope","arguments":"{}"}]`;
  expect(parseLeakedToolCalls(text, new Set(["Read"])).calls).toHaveLength(0);
});

test("malformed arguments are not recovered", () => {
  const text = `${MARKER}\n[{"name":"Read","arguments":"not json"}]`;
  expect(parseLeakedToolCalls(text).calls).toHaveLength(0);
});

test("prose mentioning the marker without a call is left alone", () => {
  const text = `The marker ${MARKER} is how calls are written.`;
  const { calls, clean } = parseLeakedToolCalls(text);
  expect(calls).toHaveLength(0);
  expect(clean).toBe(text);
});
