/**
 * Inception Labs (Mercury) is a bearer-authenticated OpenAI-compatible chat
 * provider pinned to its free-tier allowance.
 *
 * The two things this guards: the static roster never accidentally loses its
 * free-tier pin (a priced row would bill the operator's allowance), and live
 * discovery never lands a fetched model in the billed tail instead of the free
 * section the console groups on.
 */
import { describe, expect, test } from "bun:test";
import { discoverInceptionFreeModels, INCEPTION_MODELS } from "../../src/providers/integrations/inception/provider";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { providerBaseUrl } from "../../src/providers/provider-metadata";
import { joinUrl } from "../../src/protocol/codecs";

const LISTING = {
  data: [
    {
      id: "mercury-3",
      object: "model",
      created: 1,
      owned_by: "inception",
      context_window: 1_000_000,
      max_completion_tokens: 131_072,
      reasoning: true,
    },
    {
      id: "mercury-2.5",
      object: "model",
      created: 1,
      owned_by: "inception",
      context_window: 260_000,
      max_completion_tokens: 65_536,
    },
  ],
};

function stubFetcher(captured?: { headers?: Record<string, string> }): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    if (captured !== undefined) {
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
    }
    return new Response(JSON.stringify(LISTING), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("Inception static roster", () => {
  test("carries only mercury-3", () => {
    expect(INCEPTION_MODELS.map((model) => model.modelId)).toEqual(["mercury-3"]);
  });

  test("mercury-3 is chat wire, free-tier, zero-priced, reasoning, tool-enabled", () => {
    const [model] = INCEPTION_MODELS;
    expect(model).toBeDefined();
    expect(model?.wireFamily).toBe("chat");
    expect(model?.endpointPath).toBe("/chat/completions");
    expect(model?.freeTier).toBe(true);
    expect(model?.cost?.input).toBe(0);
    expect(model?.cost?.output).toBe(0);
    expect(model?.reasoning).toBe(true);
    expect(model?.toolCall).toBe(true);
  });

  test("mercury-3 carries its published 1M / 131072 window", () => {
    const mercury3 = INCEPTION_MODELS.find((model) => model.modelId === "mercury-3");
    expect(mercury3?.contextLimit).toBe(1_000_000);
    expect(mercury3?.outputLimit).toBe(131_072);
  });
});

describe("Inception free discovery", () => {
  test("fetched rows are stamped free-tier and zero-priced", async () => {
    const rows = await discoverInceptionFreeModels({
      baseUrl: "https://api.inceptionlabs.ai/v1",
      fetcher: stubFetcher(),
    });
    expect(rows).not.toBeNull();
    expect(rows?.length).toBe(2);
    for (const row of rows ?? []) {
      expect(row.freeTier).toBe(true);
      expect(row.cost?.input).toBe(0);
      expect(row.cost?.output).toBe(0);
      expect(row.wireFamily).toBe("chat");
    }
  });

  test("the listing read the upstream's own window fields", async () => {
    const rows = await discoverInceptionFreeModels({
      baseUrl: "https://api.inceptionlabs.ai/v1",
      fetcher: stubFetcher(),
    });
    const mercury3 = rows?.find((row) => row.modelId === "mercury-3");
    expect(mercury3?.contextLimit).toBe(1_000_000);
    expect(mercury3?.outputLimit).toBe(131_072);
    expect(mercury3?.reasoning).toBe(true);
  });

  test("the credential is forwarded as the bearer", async () => {
    const captured: { headers?: Record<string, string> } = {};
    await discoverInceptionFreeModels({
      baseUrl: "https://api.inceptionlabs.ai/v1",
      credential: "sk-inception-test",
      fetcher: stubFetcher(captured),
    });
    expect(captured.headers?.["authorization"]).toBe("Bearer sk-inception-test");
  });

  test("a failed fetch returns null and keeps the static roster authoritative", async () => {
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const rows = await discoverInceptionFreeModels({
      baseUrl: "https://api.inceptionlabs.ai/v1",
      fetcher: failing,
    });
    expect(rows).toBeNull();
  });
});

describe("Inception registry wiring", () => {
  test("the bundled module resolves an adapter and discovery", async () => {
    const registry = createDefaultProviderRegistry();
    const adapter = await registry.resolve("inception");
    expect(adapter?.provider_id).toBe("inception");
    expect(registry.hasModelDiscovery("inception")).toBe(true);
  });

  test("the chat path is declared below the /v1 root without doubling", async () => {
    const registry = createDefaultProviderRegistry();
    const registration = registry.registrations().find((row) => row.provider_id === "inception");
    expect(registration?.endpoint_paths_by_wire_family?.chat).toBe("/chat/completions");
    const finalUrl = joinUrl(providerBaseUrl("inception"), "/chat/completions");
    expect(finalUrl).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
  });
});
