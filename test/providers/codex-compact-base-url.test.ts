/**
 * `compact()` must honor the adapter's `chatgpt_base_url` override.
 *
 * The URL was hardcoded to https://chatgpt.com while dispatch and image
 * generation resolve against the configured base, so a custom-endpoint
 * deployment sent its compaction traffic to production. This pins the
 * configured base on the compaction path.
 */
import { describe, expect, test } from "bun:test";
import { createCodexAdapter } from "../../src/providers/integrations/codex/codex";
import type {
  ProviderDispatchContext,
  ValidatedOutboundFetch,
} from "../../src/providers/provider-contracts";

/** Fake JWT with a non-empty payload — Codex identity reads claims from it. */
const TOKEN = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
).toString("base64url")}.sig`;

function context(fetcher: ValidatedOutboundFetch): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "codex",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(TOKEN),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
    outbound_fetch: fetcher,
  } as unknown as ProviderDispatchContext;
}

/** Runs one compaction and returns the URL it posted to. */
async function compactTargetUrl(baseUrl?: string): Promise<string> {
  let captured = "";
  const fetcher = (async (url: string | URL | Request): Promise<Response> => {
    captured = String(url);
    return Response.json({ ok: true }, { status: 200 });
  }) as unknown as ValidatedOutboundFetch;
  const adapter = createCodexAdapter({
    provider_id: "codex",
    installation_id_override: "inst-test",
    ...(baseUrl === undefined ? {} : { chatgpt_base_url: baseUrl }),
  });
  await adapter.compact({ model: "gpt-5.6-luna", input: [] }, context(fetcher));
  return captured;
}

describe("Codex compaction endpoint base", () => {
  test("defaults to the ChatGPT backend", async () => {
    expect(await compactTargetUrl()).toBe(
      "https://chatgpt.com/backend-api/codex/responses/compact",
    );
  });

  test("honors the chatgpt_base_url override", async () => {
    expect(await compactTargetUrl("https://codex.example")).toBe(
      "https://codex.example/backend-api/codex/responses/compact",
    );
  });
});
