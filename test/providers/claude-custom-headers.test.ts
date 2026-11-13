/**
 * `ClaudeAdapter`'s `custom_headers` constructor option must reach the wire.
 *
 * The field was declared and spread into the outbound header set but never
 * assigned in the constructor, so the option was silently inert: a caller
 * configuring custom headers got a request without them and no error. This
 * pins the assignment.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const TARGET: ProviderDispatchTarget = {
  provider_id: "claude",
  model_id: "claude-sonnet-4-6",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
} as unknown as ProviderDispatchTarget;

function makeRequest(): CanonicalRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "messages",
  } as unknown as CanonicalRequest;
}

function makeContext(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("tok"),
      account_id: `custom-headers-${crypto.randomUUID()}`,
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  } as unknown as ProviderDispatchContext;
}

/** Captures the headers of the one request dispatched. */
async function dispatchedHeaders(): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  const fetcher = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    captured = { ...(init?.headers as Record<string, string>) };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const claude = new ClaudeAdapter({
    fetch: fetcher,
    custom_headers: { "x-session-tag": "wave-a" },
  });
  try {
    for await (const _event of claude.dispatch(makeRequest(), TARGET, makeContext())) {
      void _event;
    }
  } catch {
    // A dispatch that throws still records what it sent.
  }
  return captured;
}

describe("ClaudeAdapter custom_headers option", () => {
  test("constructor custom_headers reach the outbound request", async () => {
    const headers = await dispatchedHeaders();
    expect(headers["x-session-tag"]).toBe("wave-a");
  });
});
