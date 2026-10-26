/**
 * InferHub conversation pinning.
 *
 * InferHub pins a conversation to one upstream provider while `X-Session-Id`
 * stays the same, which is what keeps the prompt cache warm across turns (the
 * pin lapses after roughly ten minutes idle). The header is only worth sending
 * if it is *stable*: a value that changed per request would re-pin every turn
 * and defeat the thing the header exists for.
 *
 * Both legs must send it — Claude-backed ids go out on Messages, everything
 * else on Responses — so this drives the real adapter with a stub transport and
 * reads the headers actually produced.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";
import { InferhubMessagesAdapter } from "../../src/providers/integrations/inferhub";
import { createInferhubAdapter } from "../../src/providers/integrations/inferhub";

const SECRET = new TextEncoder().encode("sk-airo-test-key");

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "cc/claude-opus-5-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
    ...overrides,
  };
}

function context(requestHeaders: Record<string, string> = {}): ProviderDispatchContext {
  return {
    credential: { provider_id: "inferhub", credential_kind: "api_key", secret: SECRET },
    deadline: Date.now() + 60_000,
    abort_signal: new AbortController().signal,
    request_headers: requestHeaders,
  } as unknown as ProviderDispatchContext;
}

function candidate(wireFamily: "messages" | "responses"): ProviderDispatchTarget {
  return {
    provider_id: "inferhub",
    model_id: "cc/claude-opus-5-5",
    wire_family: wireFamily,
    endpoint_path: wireFamily === "messages" ? "/v1/messages" : "/responses",
  } as unknown as ProviderDispatchTarget;
}

/** Captures the headers of the one request the adapter sends. */
function capturingFetch(): { fetchImpl: typeof fetch; headers: () => Headers } {
  let captured = new Headers();
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Headers(init?.headers);
    return new Response(
      "data: {}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, headers: () => captured };
}

/** Drains a dispatch so the request is actually issued. */
async function drain(
  adapter: { dispatch: (r: CanonicalRequest, c: ProviderDispatchTarget, x: ProviderDispatchContext) => AsyncIterable<unknown> },
  req: CanonicalRequest,
  cand: ProviderDispatchTarget,
  ctx: ProviderDispatchContext,
): Promise<void> {
  try {
    for await (const _ of adapter.dispatch(req, cand, ctx)) void _;
  } catch {
    // The stub answers a non-stream body; header capture already happened.
  }
}

describe("InferHub X-Session-Id", () => {
  test("forwards the client's own conversation id on the Messages leg", async () => {
    const { fetchImpl, headers } = capturingFetch();
    const adapter = new InferhubMessagesAdapter(fetchImpl, "https://api.inferhub.dev");
    await drain(adapter, request(), candidate("messages"), context({ "x-conversation-id": "conv-1" }));
    expect(headers().get("X-Session-Id")).toBe("conv-1");
  });

  test("forwards the client's own session id on the Responses leg", async () => {
    const { fetchImpl, headers } = capturingFetch();
    const adapter = createInferhubAdapter(fetchImpl);
    const req = request({ source_surface: "responses", model: "cx/gpt-5.6-terra" });
    await drain(adapter, req, candidate("responses"), context({ "x-session-id": "sess-9" }));
    expect(headers().get("X-Session-Id")).toBe("sess-9");
  });

  test("derives a stable affinity id when the client sends none", async () => {
    // A derived id must be identical across turns of one conversation and
    // different across conversations, or it pins nothing.
    const req = request({
      system: [{ kind: "text", text: "You are a careful assistant. ".repeat(3) }],
    });
    const a = capturingFetch();
    const b = capturingFetch();
    await drain(new InferhubMessagesAdapter(a.fetchImpl, "https://api.inferhub.dev"), req, candidate("messages"), context());
    await drain(new InferhubMessagesAdapter(b.fetchImpl, "https://api.inferhub.dev"), req, candidate("messages"), context());

    const idA = a.headers().get("X-Session-Id");
    const idB = b.headers().get("X-Session-Id");
    expect(idA).toBeDefined();
    expect(idA).toBe(idB);
  });

  test("a different conversation gets a different derived id", async () => {
    const build = (text: string): CanonicalRequest =>
      request({ system: [{ kind: "text", text: `${text} `.repeat(20) }] });
    const a = capturingFetch();
    const b = capturingFetch();
    await drain(
      new InferhubMessagesAdapter(a.fetchImpl, "https://api.inferhub.dev"),
      build("Alpha system prompt"),
      candidate("messages"),
      context(),
    );
    await drain(
      new InferhubMessagesAdapter(b.fetchImpl, "https://api.inferhub.dev"),
      build("Beta system prompt"),
      candidate("messages"),
      context(),
    );
    expect(a.headers().get("X-Session-Id")).not.toBe(b.headers().get("X-Session-Id"));
  });

  test("omits the header only when no session signal exists at all", async () => {
    // Too short to derive from: under the 30-character floor in the resolver.
    const req = request({ system: [{ kind: "text", text: "hi" }], messages: [] });
    const { fetchImpl, headers } = capturingFetch();
    await drain(new InferhubMessagesAdapter(fetchImpl, "https://api.inferhub.dev"), req, candidate("messages"), context());
    expect(headers().get("X-Session-Id")).toBeNull();
  });
});
