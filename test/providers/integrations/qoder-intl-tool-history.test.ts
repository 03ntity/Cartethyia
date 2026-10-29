import { expect, test } from "bun:test";
import {
  buildQoderRequest,
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
