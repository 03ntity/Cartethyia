/**
 * Claude `anthropic-user-profile-id` header.
 *
 * Rank #14 from the provider comparison research: the
 * donor sends the profile two ways — the `user-profiles` beta (capability) and
 * the `anthropic-user-profile-id` header (which profile). We already sent the
 * beta only, so profile-scoped credentials could never be addressed.
 *
 * The beta is DATED (`user-profiles-2026-09-04`, donor
 * `packages/ai/src/providers/anthropic-user-profiles.ts:4`). This file first
 * asserted the bare `user-profiles` because that was what the code sent — a
 * beta Anthropic has never published, which `ensureAnthropicBeta` accepted
 * silently because it takes any string.
 *
 * The header is stamped from `extension:user_profile_id`, the same key the
 * Messages parse surface already reads and `protocol/request/messages.ts`
 * already forwards as the `user_profile_id` body field.
 *
 * No network: the adapter's `fetch` is stubbed, so nothing leaves the process.
 */
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../../src/providers/integrations/claude/claude";
import { CLAUDE_USER_PROFILES_BETA } from "../../src/providers/integrations/claude/claude-user-profiles";
import {
  _resetClaudeCliVersionCache,
  getClaudeCliVersion,
} from "../../src/providers/operations/client-versions";
import type { CanonicalRequest, GenerationControls } from "../../src/protocol/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../src/providers/provider-contracts";

const PROFILE_ID = "prof_1a2b3c4d5e6f";

function makeRequest(profileId: unknown): CanonicalRequest {
  const generationControls: GenerationControls =
    profileId === undefined ? {} : { "extension:user_profile_id": profileId };
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    stream: false,
    generation_controls: generationControls,
    source_surface: "messages",
  };
}

const candidate: ProviderDispatchTarget = {
  provider_id: "claude",
  model_id: "claude-sonnet-4-6",
  wire_family: "messages",
  endpoint_path: "/v1/messages",
  capabilities: {},
};

function makeContext(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("test-oauth-token"),
      account_id: "00000000-0000-4000-8000-000000000000",
    },
    deadline: Date.now() + 30_000,
    abort_signal: AbortSignal.timeout(30_000),
  };
}

/**
 * Runs one dispatch with a stubbed fetch and returns the outbound headers. The
 * stub answers with a minimal non-streaming Messages response so `dispatch`
 * completes; the assertions read the headers it was called with.
 */
async function dispatchHeaders(profileId: unknown): Promise<Record<string, string>> {
  const seen: Record<string, string>[] = [];
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const adapter = new ClaudeAdapter({ fetch: fetchStub });
  const stream = adapter.dispatch(makeRequest(profileId), candidate, makeContext());
  const iterator = stream[Symbol.asyncIterator]();
  const result = await iterator.next();
  await iterator.return?.(undefined);
  expect(result.done).not.toBe(true);
  expect(seen.length).toBeGreaterThan(0);
  return seen[0] ?? {};
}

async function dispatchVersionRetry(): Promise<readonly { headers: Record<string, string>; body: string }[]> {
  const seen: Array<{ headers: Record<string, string>; body: string }> = [];
  let call = 0;
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    call++;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "claude_code_version_too_old: version 9.9.9 or newer is required",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_retry",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const stream = new ClaudeAdapter({ fetch: fetchStub }).dispatch(makeRequest(PROFILE_ID), candidate, makeContext());
  for await (const _event of stream) void _event;
  return seen;
}

/** Anthropic sends header names lower-cased on the wire; match case-insensitively. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function betaTokens(headers: Record<string, string>): readonly string[] {
  return (headerValue(headers, "anthropic-beta") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

describe("claude anthropic-user-profile-id", () => {
  test("stamps the header when a profile id is present", async () => {
    const headers = await dispatchHeaders(PROFILE_ID);
    expect(headerValue(headers, "anthropic-user-profile-id")).toBe(PROFILE_ID);
  });

  test("still declares the user-profiles beta alongside the header", async () => {
    // The beta unlocks profile scoping; the header names the profile. Both must
    // travel together — one without the other is unaddressable.
    const headers = await dispatchHeaders(PROFILE_ID);
    expect(betaTokens(headers)).toContain(CLAUDE_USER_PROFILES_BETA);
  });

  test("sends neither header nor beta when no profile id is present", async () => {
    const headers = await dispatchHeaders(undefined);
    expect(headerValue(headers, "anthropic-user-profile-id")).toBeUndefined();
    expect(betaTokens(headers)).not.toContain(CLAUDE_USER_PROFILES_BETA);
  });

  test("treats an empty profile id as absent", async () => {
    const headers = await dispatchHeaders("");
    expect(headerValue(headers, "anthropic-user-profile-id")).toBeUndefined();
    expect(betaTokens(headers)).not.toContain(CLAUDE_USER_PROFILES_BETA);
  });

  test("ignores a non-string profile id", async () => {
    const headers = await dispatchHeaders(42);
    expect(headerValue(headers, "anthropic-user-profile-id")).toBeUndefined();
    expect(betaTokens(headers)).not.toContain(CLAUDE_USER_PROFILES_BETA);
  });

  test("drops a profile id carrying a control character", async () => {
    // A caller-supplied newline must never reach the wire as a header value.
    const headers = await dispatchHeaders("prof_abc\r\nX-Injected: 1");
    expect(headerValue(headers, "anthropic-user-profile-id")).toBeUndefined();
    expect(headerValue(headers, "X-Injected")).toBeUndefined();
  });
});

describe("the profile beta is the dated one the donor publishes", () => {
  test("pins the literal, so the constant cannot drift unnoticed", () => {
    // A dated beta must match the donor exactly: an undated or wrongly-dated
    // value is accepted by every layer and silently ignored upstream.
    expect(CLAUDE_USER_PROFILES_BETA).toBe("user-profiles-2026-09-04");
  });
});

describe("Claude server-named version retry", () => {
  test("rebuilds the body from the live payload while preserving request content", async () => {
    _resetClaudeCliVersionCache();
    try {
      expect(getClaudeCliVersion()).toBe("2.1.302");
      const attempts = await dispatchVersionRetry();
      expect(attempts).toHaveLength(2);
      const firstBody = JSON.parse(attempts[0]?.body ?? "{}") as Record<string, unknown>;
      const retryBody = JSON.parse(attempts[1]?.body ?? "{}") as Record<string, unknown>;
      expect(retryBody["messages"]).toEqual(firstBody["messages"]);
      expect(retryBody["system"]).not.toEqual(firstBody["system"]);
      expect(JSON.stringify(retryBody["system"])).toContain("9.9.9");
      expect(attempts[1]?.headers["User-Agent"]).toContain("claude-cli/9.9.9");
    } finally {
      _resetClaudeCliVersionCache();
    }
  });
});
