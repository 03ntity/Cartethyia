/**
 * Reference-alignment tests: OpenCode free-tier dispatch shaped 1:1 with the
 * reference gateway (v2 only). These pin the things the previous
 * implementation did not do: the 2.1 family-segment upstream paths, the
 * official CLI system-prompt injection, the v2 completion ceiling, the always-on
 * `include_usage`, the client key-order byte layout, the pinned client version,
 * and the root/child session split.
 */
import { describe, expect, test } from "bun:test";
import { OPENCODE_FREE_SPEC, isFreeTierZenModel } from "../../src/providers/integrations/opencode/provider";
import { OPENCODE_PROMPT_MARKER } from "../../src/providers/integrations/opencode/prompt";
import { OPENCODE_CLIENT_VERSION } from "../../src/providers/integrations/opencode/fingerprint";
import { encodeWireRequest } from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const FREE_CHAT: ProviderDispatchTarget = {
  provider_id: "opencode",
  model_id: "mimo-v2.6-flash-free",
  wire_family: "chat",
  endpoint_path: "/inference/openai/v1/chat/completions",
  capabilities: {},
};

const FREE_RESPONSES: ProviderDispatchTarget = {
  provider_id: "opencode",
  model_id: "mimo-v2.6-flash-free",
  wire_family: "responses",
  endpoint_path: "/inference/openai/v1/responses",
  capabilities: {},
};

const FREE_MESSAGES: ProviderDispatchTarget = {
  provider_id: "opencode",
  model_id: "mimo-v2.6-flash-free",
  wire_family: "messages",
  endpoint_path: "/inference/anthropic/v1/messages?beta=true",
  capabilities: {},
};

function textMessage(
  role: "system" | "developer" | "user" | "assistant",
  text: string,
): {
  role: "system" | "developer" | "user" | "assistant";
  content: readonly { kind: "text"; text: string }[];
} {
  return { role, content: [{ kind: "text", text }] };
}

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: FREE_CHAT.model_id,
    messages: [],
    tools: [{ name: "read", description: "read a file", jsonSchema: { type: "object", properties: {} } }],
    stream: false,
    source_surface: "chat",
    generation_controls: {},
    ...overrides,
  } as unknown as CanonicalRequest;
}

function encodeChat(source: CanonicalRequest): Promise<Record<string, unknown>> {
  const field = OPENCODE_FREE_SPEC.chatTokenLimitField;
  return encodeWireRequest("chat", source, {
    ...(field === undefined ? {} : { chatTokenLimitField: field }),
  }) as Promise<Record<string, unknown>>;
}

describe("OpenCode donor parity", () => {
  test("free-tier detection follows the donor name rule plus measured exclusions", () => {
    expect(isFreeTierZenModel("opencode/x-model-free")).toBe(true);
    expect(isFreeTierZenModel("opencode/FREE-X")).toBe(true);
    expect(isFreeTierZenModel("opencode/big-pickle")).toBe(true);
    // Measured refusals stay out even though they carry the suffix.
    expect(isFreeTierZenModel("opencode/deepseek-v4-flash-free")).toBe(false);
    expect(isFreeTierZenModel("opencode/ling-3.1-flash-free")).toBe(false);
    expect(isFreeTierZenModel("opencode/claude-opus-5")).toBe(false);
  });

  test("chat free dispatch forces stream and include_usage even for a non-streaming caller", async () => {
    const payload = await encodeChat(baseRequest({ stream: false }));
    OPENCODE_FREE_SPEC.prePayload?.(payload, baseRequest({ stream: false }), FREE_CHAT);
    expect(payload["stream"]).toBe(true);
    expect((payload["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(true);
  });

  test("the v2 completion ceiling is injected only when the caller sets no limit", async () => {
    const payload = await encodeChat(baseRequest());
    OPENCODE_FREE_SPEC.prePayload?.(payload, baseRequest(), FREE_CHAT);
    expect(payload["max_completion_tokens"]).toBe(32_000);

    const explicit = await encodeChat(baseRequest({ generation_controls: { max_tokens: 600 } }));
    OPENCODE_FREE_SPEC.prePayload?.(explicit, baseRequest({ generation_controls: { max_tokens: 600 } }), FREE_CHAT);
    expect(explicit["max_completion_tokens"]).toBe(600);
    expect(explicit["max_tokens"]).toBeUndefined();
  });

  test("the completion ceiling follows the model's declared output limit", async () => {
    const payload = await encodeChat(baseRequest());
    OPENCODE_FREE_SPEC.prePayload?.(payload, baseRequest(), { ...FREE_CHAT, output_limit: 8000 });
    expect(payload["max_completion_tokens"]).toBe(8000);
  });

  test("the official CLI prompt is injected and system/developer messages fold into one leading system", async () => {
    const source = baseRequest({
      messages: [
        textMessage("system", "system instructions"),
        textMessage("developer", "dev instructions"),
        textMessage("user", "hi"),
      ],
    });
    const payload = await encodeWireRequest("chat", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, FREE_CHAT);
    const messages = payload["messages"] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain(OPENCODE_PROMPT_MARKER);
    expect(messages[0]?.content).toContain("system instructions");
    expect(messages[0]?.content).toContain("dev instructions");
    expect(messages[1]?.role).toBe("user");
  });

  test("a body that already carries the official prompt is not double-injected", async () => {
    const source = baseRequest({
      messages: [textMessage("system", `${OPENCODE_PROMPT_MARKER} already here`)],
    });
    const payload = await encodeWireRequest("chat", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, FREE_CHAT);
    const messages = payload["messages"] as Array<{ content: string }>;
    expect(messages.filter((m) => m.content.includes(OPENCODE_PROMPT_MARKER))).toHaveLength(1);
  });

  test("responses free dispatch injects the prompt and sets store=false", async () => {
    const source = baseRequest({ messages: [textMessage("user", "hi")] });
    const payload = await encodeWireRequest("responses", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, FREE_RESPONSES);
    expect(String(payload["instructions"])).toContain(OPENCODE_PROMPT_MARKER);
    expect(payload["store"]).toBe(false);
    expect(payload["stream"]).toBe(true);
  });

  test("anthropic free dispatch prepends the prompt to system", async () => {
    const source = baseRequest({ messages: [textMessage("user", "hi")] });
    const payload = await encodeWireRequest("messages", source);
    OPENCODE_FREE_SPEC.prePayload?.(payload, source, FREE_MESSAGES);
    expect(String(payload["system"])).toContain(OPENCODE_PROMPT_MARKER);
  });

  test("v2 chat bodies serialize in the 2.x client key order", async () => {
    const payload = await encodeChat(baseRequest({ stream: true }));
    payload["extra"] = true;
    OPENCODE_FREE_SPEC.prePayload?.(payload, baseRequest({ stream: true }), FREE_CHAT);
    const skeleton = ["model", "messages", "tools", "stream", "stream_options", "max_completion_tokens"];
    const keys = Object.keys(payload);
    // Every skeleton key the body carries comes first, in the client's order,
    // and everything else follows sorted.
    expect(keys.slice(0, skeleton.length)).toEqual(skeleton);
    expect(keys.slice(skeleton.length)).toEqual(["extra"]);
  });

  test("the client version falls back to the reference identity until discovery", () => {
    // The live feed wins once resolved; the fallback is the known-good 2.1.1.
    expect(OPENCODE_CLIENT_VERSION).toBe("2.1.1");
  });
});
