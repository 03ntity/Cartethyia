/**
 * Pins the donor-adapted Qoder recovery behaviors:
 * - the INTL tool-call leak marker is recognized in its variants (angle
 *   brackets, missing closing bracket, ``` fence, trailing DSML residue);
 * - DeepSeek multi-turn backfills `reasoning_content` on every assistant turn
 *   once the conversation carries a reasoning trace.
 */
import { expect, test } from "bun:test";
import {
  buildQoderRequest,
  parseLeakedToolCalls,
} from "../../../src/providers/integrations/qoder/qoder";
import type { CanonicalRequest, ContentPart } from "../../../src/protocol/canonical-model";

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

const RESULT: ContentPart = {
  kind: "toolResult",
  call_id: "call_1",
  content: "file body",
};

const REASONING: ContentPart = {
  kind: "reasoning",
  payload: null,
  summary: "thinking",
};

function build(parts: CanonicalRequest["messages"], model = "deepseek-v4.1-flash") {
  const req = {
    model,
    messages: parts,
    generation_controls: {},
    stream: false,
    source_surface: "chat" as const,
  } as CanonicalRequest;
  return buildQoderRequest(model, req, CONFIG, AUTH, "intl");
}

test("leak echo is recovered from the angle-bracket marker variant", () => {
  const text = '<assistant 请求调用工具>\n[{"name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}]';
  const { calls, clean } = parseLeakedToolCalls(text, new Set(["Read"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("Read");
  expect(clean).toBe("");
});

test("leak echo is recovered when the marker misses its closing bracket", () => {
  const text = '[assistant 请求调用工具\n[{"name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}]';
  const { calls } = parseLeakedToolCalls(text, new Set(["Read"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("Read");
});

test("leak echo is recovered from inside a ``` fence", () => {
  const text = "```json\n[assistant 请求调用工具]\n[{\"name\":\"Read\",\"arguments\":\"{\\\"file_path\\\":\\\"a.ts\\\"}\"}]\n```";
  const { calls, clean } = parseLeakedToolCalls(text, new Set(["Read"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("Read");
  expect(clean).toBe("");
});

test("leak echo tolerates trailing DSML residue after the array", () => {
  const text =
    '[assistant 请求调用工具]\n[{"name":"Read","arguments":"{\\"file_path\\":\\"a.ts\\"}"}]\n</｜DSML｜parameter> </｜DSML｜invoke>';
  const { calls } = parseLeakedToolCalls(text, new Set(["Read"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("Read");
});

test("DeepSeek backfills reasoning_content on assistant turns without a trace field", () => {
  const body = build([
    { role: "user", content: [{ kind: "text", text: "hint" }] },
    { role: "assistant", content: [REASONING, { kind: "text", text: "ok" }] },
    { role: "user", content: [{ kind: "text", text: "more" }] },
    { role: "assistant", content: [{ kind: "text", text: "plain answer" }] },
  ]);
  const messages = body["messages"] as Array<Record<string, unknown>>;
  // The plain assistant turn (no reasoning part) still carries the empty field.
  const plain = messages.find((m) => m["role"] === "assistant" && m["content"] === "plain answer");
  expect(plain).toBeDefined();
  expect(plain!["reasoning_content"]).toBe("");
  // The thinking turn keeps its text.
  const thought = messages.find((m) => m["role"] === "assistant" && m["content"] === "ok");
  expect(thought!["reasoning_content"]).toBe("thinking");
});

test("non-DeepSeek models are not backfilled", () => {
  const body = build(
    [
      { role: "user", content: [{ kind: "text", text: "hint" }] },
      { role: "assistant", content: [REASONING, { kind: "text", text: "ok" }] },
      { role: "assistant", content: [{ kind: "text", text: "plain answer" }] },
    ],
    "qwen3.8-flash",
  );
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const plain = messages.find((m) => m["role"] === "assistant" && m["content"] === "plain answer");
  expect(plain).toBeDefined();
  expect(plain!["reasoning_content"]).toBeUndefined();
});

test("structured epoch fall back to prose when a call lacks an id", () => {
  const body = build(
    [
      { role: "user", content: [{ kind: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: "", name: "Read", arguments: "{}" }],
      },
      { role: "user", content: [RESULT] },
    ],
    "qwen3.8-flash",
  );
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const assistant = messages.find((m) => m["role"] === "assistant");
  // No structured `tool_calls` field, and the call is recorded in prose.
  expect(assistant!["tool_calls"]).toBeUndefined();
  expect(String(assistant!["content"])).toContain("[assistant 请求调用工具]");
});

test("image parts are carried as structured OpenAI parts, not dropped", () => {
  const body = build([
    {
      role: "user",
      content: [
        { kind: "image", payload: { source: { type: "base64", media_type: "image/png", data: "AAAA" } } },
        { kind: "text", text: "what color?" },
      ],
    },
  ]);
  const messages = body["messages"] as Array<Record<string, unknown>>;
  const user = messages.find((m) => m["role"] === "user");
  expect(Array.isArray(user!["content"])).toBe(true);
  const parts = user!["content"] as Array<Record<string, unknown>>;
  expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  expect(parts[1]).toEqual({ type: "text", text: "what color?" });
});
