/**
 * Kiro adapter dispatch — conversation-id integrity.
 *
 * The resolver mints a fresh UUID only when a request carries no session
 * header, no conversation id, and no derivable opening-turn affinity. Before
 * the M-35 consolidation, dispatch resolved it twice, giving
 * `conversationId` and `rootConversationId` two different UUIDs on that
 * fallback path and keying the session-cache estimate under yet another one.
 * These tests pin the fix: one resolution per dispatch, reused for both wire
 * fields and the cache key.
 */
import { describe, expect, test } from "bun:test";
import { createKiroAdapter } from "../../src/providers/integrations/kiro/kiro";
import { crc32 } from "../../src/providers/integrations/kiro/aws-event-stream";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A request with no session, conversation id, or derivable affinity → fallback. */
function fallbackRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "auto",
    stream: true,
    source_surface: "chat",
    messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
    generation_controls: {},
    ...overrides,
  } as CanonicalRequest;
}

function context(overrides: Partial<ProviderDispatchContext> = {}): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "kiro",
      credential_kind: "api_key",
      secret: new TextEncoder().encode("tok"),
      account_id: "acc-1",
      auth_state: { authMethod: "api_key", region: "us-east-1" },
    },
    deadline: Date.now() + 120_000,
    abort_signal: new AbortController().signal,
    ...overrides,
  } as unknown as ProviderDispatchContext;
}

function target(): ProviderDispatchTarget {
  return {
    provider_id: "kiro",
    model_id: "auto",
    wire_family: "chat",
    endpoint_path: "/generateAssistantResponse",
    capabilities: {},
  } as unknown as ProviderDispatchTarget;
}

async function dispatchBody(req: CanonicalRequest, ctx: ProviderDispatchContext): Promise<Record<string, unknown>> {
  let capturedBody = "";
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    // Empty body: the stream loop finishes immediately with no events; the
    // adapter still yields usage + terminal and the wire body is inspectable.
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = createKiroAdapter({ fetch: fetchImpl });
  for await (const _event of adapter.dispatch(req, target(), ctx)) {
    // drain
  }
  const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
  return (parsed["conversationState"] as Record<string, unknown>) ?? {};
}

describe("Kiro usage token recovery", () => {
  /**
   * One AWS EventStream message, CRCs included — the decoder verifies both, so
   * a hand-built frame must be framed exactly like the upstream's.
   */
  function eventStreamMessage(eventType: string, payload: string): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder();
    const headerBytes: number[] = [];
    const pushHeader = (name: string, value: string): void => {
      const nameBytes = encoder.encode(name);
      const valueBytes = encoder.encode(value);
      headerBytes.push(
        nameBytes.length,
        ...nameBytes,
        7, // string value type
        (valueBytes.length >> 8) & 0xff,
        valueBytes.length & 0xff,
        ...valueBytes,
      );
    };
    pushHeader(":message-type", "event");
    pushHeader(":event-type", eventType);
    const payloadBytes = encoder.encode(payload);
    const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, totalLength, false);
    view.setUint32(4, headerBytes.length, false);
    out.set(headerBytes, 12);
    out.set(payloadBytes, 12 + headerBytes.length);
    view.setUint32(8, crc32(out.subarray(0, 8)));
    view.setUint32(totalLength - 4, crc32(out.subarray(0, totalLength - 4)));
    return out;
  }

  function streamBody(messages: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
    const total = messages.reduce((sum, message) => sum + message.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const message of messages) {
      out.set(message, offset);
      offset += message.length;
    }
    return out;
  }

  async function dispatchEvents(
    req: CanonicalRequest,
    ctx: ProviderDispatchContext,
    tgt: ProviderDispatchTarget,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<CanonicalEvent[]> {
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const adapter = createKiroAdapter({ fetch: fetchImpl });
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(req, tgt, ctx)) events.push(event);
    return events;
  }

  test("usage tokens scale against the routed model's window, not the request alias", async () => {
    // request.model names a 200k-window model while the routed candidate is a
    // 1M-window one. The upstream reports only a window percentage, so scaling
    // it against the alias would undercount the recovered tokens fivefold.
    const events = await dispatchEvents(
      fallbackRequest({ model: "claude-haiku-4.5" }),
      context(),
      { ...target(), model_id: "claude-opus-5" },
      streamBody([
        eventStreamMessage(
          "assistantResponseEvent",
          JSON.stringify({ content: "pong", modelId: "claude-opus-5" }),
        ),
        eventStreamMessage("contextUsageEvent", JSON.stringify({ contextUsagePercentage: 10 })),
        eventStreamMessage("metadataEvent", JSON.stringify({ stopReason: "END_TURN" })),
      ]),
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type !== "usage") throw new Error("unreachable");
    // 1_000_000 * 10% = 100_000 measured total; "pong" is one completion
    // token, leaving 99_999 input tokens.
    expect(usage.usage.input_tokens).toBe(99_999);
    expect(usage.usage.output_tokens).toBe(1);
  });
});

describe("Kiro conversation-id resolution at dispatch", () => {
  test("fallback path mints ONE id, shared by conversationId and rootConversationId", async () => {
    const cs = await dispatchBody(fallbackRequest(), context());
    const conversationId = cs["conversationId"] as string;
    expect(conversationId).toMatch(UUID_RE);
    expect(cs["rootConversationId"]).toBe(conversationId);
  });

  test("healthy path uses the inbound session id for both fields", async () => {
    const cs = await dispatchBody(
      fallbackRequest(),
      context({ request_headers: { "x-session-id": "ses-42" } }),
    );
    expect(cs["conversationId"]).toBe("ses-42");
    expect(cs["rootConversationId"]).toBe("ses-42");
  });

  test("healthy path keeps the caller's own conversation id", async () => {
    const cs = await dispatchBody(
      fallbackRequest({ conversation_id: "conv-7" }),
      context(),
    );
    expect(cs["conversationId"]).toBe("conv-7");
    expect(cs["rootConversationId"]).toBe("conv-7");
  });
});
