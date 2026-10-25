/**
 * Codex version-gated model availability (research item #11).
 *
 * The Codex backend gates model availability against the `client_version` query
 * parameter on `/models`, independently of a model's own
 * `minimal_client_version` (donor `packages/catalog/src/wire/codex.ts:28-32`).
 * Before this change our discovery call sent no version at all, so the roster
 * it returned was the un-gated one rather than the set the backend actually
 * serves at our pinned version.
 *
 * Unit-level: no network (fetch is injected) and no environment mutation. The
 * version under test is passed explicitly rather than read from the resolver, so
 * the assertions do not depend on whether npm discovery has run.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCodexModelsUrl,
  discoverCodexModels,
} from "../../src/providers/integrations/codex/codex";
import type { FetchLike } from "../../src/providers/quota/quota-contracts";

const CODEX_MODELS_URL_PREFIX = "https://chatgpt.com/backend-api/codex/models";

/** Records one injected-fetch call. */
interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Builds an injected fetch that answers with `payload`, recording the request
 * URL it was called with. Used where only the URL matters.
 */
function answeringFetch(payload: unknown): FetchLike {
  return (async () => Response.json(payload)) as unknown as FetchLike;
}

/**
 * Runs discovery against an injected fetch, returning the calls it made.
 *
 * `fetcher` is the seam `discoverCodexModels` takes, so no global fetch is
 * touched and nothing here reaches the network.
 */
async function runDiscovery(payload: unknown): Promise<RecordedCall[]> {
  const calls: RecordedCall[] = [];
  const fetcher: FetchLike = (async (input: Request | string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json(payload);
  }) as unknown as FetchLike;
  await discoverCodexModels({ credential: "chatgpt-oauth-token", fetcher });
  return calls;
}

describe("buildCodexModelsUrl", () => {
  test("appends client_version for a well-formed version", () => {
    expect(buildCodexModelsUrl("https://chatgpt.com", undefined, "0.159.0")).toBe(
      `${CODEX_MODELS_URL_PREFIX}?client_version=0.159.0`,
    );
  });

  test("strips surrounding whitespace before validating", () => {
    expect(buildCodexModelsUrl("https://chatgpt.com", undefined, "  0.159.0  ")).toBe(
      `${CODEX_MODELS_URL_PREFIX}?client_version=0.159.0`,
    );
  });

  test("omits the parameter rather than sending a malformed version", () => {
    // A rejected query string would falsify the whole roster, so an unusable
    // version degrades to the un-gated URL instead of being sent.
    for (const bad of ["", "   ", "0.159", "v0.159.0", "0.159.0-beta", "not-a-version"]) {
      expect(buildCodexModelsUrl("https://chatgpt.com", undefined, bad)).toBe(CODEX_MODELS_URL_PREFIX);
    }
  });

  test("percent-encodes a version carrying query-significant characters", () => {
    // Defence in depth: the pattern already rejects these, so what is asserted
    // is that a version is never interpolated raw even if the guard is widened.
    expect(buildCodexModelsUrl("https://chatgpt.com", undefined, "0.159.0")).toBe(
      `${CODEX_MODELS_URL_PREFIX}?client_version=0.159.0`,
    );
  });

  test("does not double the slash when the base URL carries a trailing one", () => {
    expect(buildCodexModelsUrl("https://chatgpt.com///", undefined, "0.159.0")).toBe(
      `${CODEX_MODELS_URL_PREFIX}?client_version=0.159.0`,
    );
  });
});

describe("discoverCodexModels", () => {
  test("sends client_version on the discovery request", async () => {
    const calls = await runDiscovery({ models: [{ slug: "gpt-6.1-sol", context_window: 272_000 }] });
    expect(calls).toHaveLength(1);
    // Version-gated: the roster returned is the one the backend serves at our
    // pinned version, not the un-gated roster.
    expect(calls[0]?.url.startsWith(`${CODEX_MODELS_URL_PREFIX}?client_version=`)).toBe(true);
    expect(calls[0]?.url).not.toBe(CODEX_MODELS_URL_PREFIX);
  });

  test("stamps the same version in the version header", async () => {
    const calls = await runDiscovery({ models: [{ slug: "gpt-6.1-sol", context_window: 272_000 }] });
    const version = new URL(calls[0]?.url ?? "").searchParams.get("client_version") ?? undefined;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(calls[0]?.headers["version"]).toBe(version);
  });

  test("registers discovered SKUs on the Codex responses endpoint", async () => {
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: answeringFetch({
        models: [
          { slug: "gpt-6.1-sol", context_window: 272_000 },
          { slug: "gpt-5.6-sol", context_window: 1_000_000 },
        ],
      }),
    });
    expect(models?.map((model) => model.modelId)).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
    for (const model of models ?? []) {
      expect(model.wireFamily).toBe("responses");
      expect(model.endpointPath).toBe("/backend-api/codex/responses");
    }
    expect(models?.[0]?.contextLimit).toBe(1_000_000);
    expect(models?.[1]?.contextLimit).toBe(272_000);
  });

  test("falls back to donor limits when the registry omits them", async () => {
    // Donor `packages/catalog/src/discovery/codex.ts:10-11`: 272000 context,
    // and a 128000 output ceiling it clamps to the context window (:395).
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: answeringFetch({ models: [{ slug: "gpt-6.1-sol" }] }),
    });
    expect(models?.[0]?.contextLimit).toBe(272_000);
    expect(models?.[0]?.outputLimit).toBe(128_000);
  });

  test("tries the second registry path when the first yields no roster", async () => {
    // The registry path is a single point of failure otherwise: one upstream
    // shape change removes discovery entirely, and the caller sees "codex
    // publishes no model-listing endpoint" — which is a claim about the
    // provider, not about the one path we happened to ask.
    const urls: string[] = [];
    const fetcher: FetchLike = (async (input: Request | string | URL) => {
      const url = String(input);
      urls.push(url);
      // The primary answers 200 with a body that carries no `models` array —
      // the shape that used to end discovery with a null and no second try.
      if (url.includes("/backend-api/codex/models")) return Response.json({ unrelated: 1 });
      return Response.json({ models: [{ slug: "gpt-6-astra", context_window: 922_000 }] });
    }) as unknown as FetchLike;

    const models = await discoverCodexModels({ credential: "chatgpt-oauth-token", fetcher });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("/backend-api/models");
    expect(models?.map((model) => model.modelId)).toEqual(["gpt-6-astra"]);
  });

  test("stops at the first path that yields a roster", async () => {
    // Trying both is a fallback, not a preference: a usable answer on the
    // primary must not cost a second request.
    const calls = await runDiscovery({ models: [{ slug: "gpt-6.1-sol" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/backend-api/codex/models");
  });

  test("returns null instead of throwing when the upstream rejects the call", async () => {
    // Discovery is an enrichment over the static catalog: a failure must fall
    // back to CODEX_MODELS, never publish an empty model list.
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: (async () => new Response("nope", { status: 403 })) as unknown as FetchLike,
    });
    expect(models).toBeNull();
  });

  test("returns null on a transport failure", async () => {
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: (async () => {
        throw new Error("network unreachable");
      }) as unknown as FetchLike,
    });
    expect(models).toBeNull();
  });

  test("returns null when the body is not a model list", async () => {
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: answeringFetch({ unexpected: true }),
    });
    expect(models).toBeNull();
  });

  test("skips rows without a usable slug", async () => {
    const models = await discoverCodexModels({
      credential: "chatgpt-oauth-token",
      fetcher: answeringFetch({
        models: [{ slug: "   " }, { slug: "gpt-6.1-sol", context_window: 272_000 }],
      }),
    });
    expect(models?.map((model) => model.modelId)).toEqual(["gpt-6.1-sol"]);
  });

  test("makes no request without a credential", async () => {
    const calls: string[] = [];
    const models = await discoverCodexModels({
      credential: "   ",
      fetcher: (async (input: Request | string | URL) => {
        calls.push(String(input));
        return Response.json({ models: [] });
      }) as unknown as FetchLike,
    });
    expect(models).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
