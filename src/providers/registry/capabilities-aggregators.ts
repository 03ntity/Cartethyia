// dynamic-import-ok: capability rows for the aggregator and shared-catalog providers.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryCapability, type ModelDiscoveryRequest } from "../configured-provider";
import { quotaCapability } from "../provider-registry";
import { configuredProvider, openAIModelDiscovery } from "./capability-helpers";

export const AGGREGATOR_CAPABILITIES = {
  cerebras: {
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/cerebras")).CEREBRAS_SPEC),
    loadModels: async () => (await import("../integrations/cerebras")).CEREBRAS_MODELS,
    loadQuotaCollector: quotaCapability(() => import("../integrations/cerebras"), "fetchCerebrasQuota"),
    loadModelDiscovery: openAIModelDiscovery("cerebras", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  mistral: configuredProvider(
    "mistral",
    async () => (await import("../integrations/mistral")).MISTRAL_MODELS,
  ),
  fireworks: configuredProvider("fireworks"),
  nvidia: configuredProvider("nvidia"),
  deepseek: {
    // DeepSeek dispatches on its Anthropic Messages wire at the `/anthropic`
    // root (the provider id is `deepseek`, so provider-keyed quirks resolve
    // against DeepSeek, not the Anthropic builtin), while `/v1/models`
    // discovery stays on the OpenAI-compatible host. The two surfaces are
    // separate upstreams on one provider.
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("../integrations/anthropic")).createDeepseekAnthropicAdapter(),
    loadModels: async () => (await import("../integrations/deepseek")).DEEPSEEK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("deepseek", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  gmi: configuredProvider("gmi"),
  opencode: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
    // Dispatch base, not the catalog base: `/zen/v1/models` publishes the
    // listing while `/inference/v1/models` answers 404, and a byte-exact replay
    // against `/inference/v1` returned 200 where `/zen/v1` did not. The wire
    // paths are the 2.1 family-segment shapes on the `/inference` origin.
    endpointPathsByWireFamily: {
      chat: "/inference/openai/v1/chat/completions",
      responses: "/inference/openai/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/opencode/provider")).OPENCODE_FREE_SPEC),
    loadModels: async () => (await import("../integrations/opencode/provider")).OPENCODE_FREE_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/opencode/provider"),
      (module) => module.discoverOpenCodeFreeModels,
      ({ baseUrl, fetcher }: ModelDiscoveryRequest) => ({
        // Free-tier filtered, unlike the generic OpenAI discovery: this
        // provider serves the free tier only, and the shared Zen listing
        // publishes the whole billed catalog alongside it.
        baseUrl: `${baseUrl.replace(/\/+$/, "")}/zen/v1`,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    ),
  },
  "opencode-zen": {
    endpointPathsByWireFamily: {
      chat: "/inference/openai/v1/chat/completions",
      responses: "/inference/openai/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/opencode/provider")).OPENCODE_ZEN_SPEC),
    loadModels: async () => (await import("../integrations/opencode/provider")).OPENCODE_ZEN_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencode-zen", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "opencode-go": {
    // The billed Go tier serves the same two wire families as the shared Zen
    // base, under its own `/zen/go/v1` prefix. Declaring them here is what the
    // endpoint-parity test guards against the catalog's own rows: without the
    // map this provider declared no paths at all, so its gate was a no-op.
    endpointPathsByWireFamily: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/opencode/provider")).OPENCODE_GO_SPEC),
    loadModels: async () => (await import("../integrations/opencode/provider")).OPENCODE_GO_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencode-go", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/go/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
    // The Go plan publishes a real usage surface; the anonymous free tier has
    // none (it is rate-limited by egress IP, not by a balance), so this is
    // deliberately registered on the keyed tier only.
    loadQuotaCollector: async () => (await import("../integrations/opencode/opencode-go-quota")).fetchOpenCodeGoQuota,
  },
  agentrouter: {
    loadAdapter: async () => (await import("../integrations/agentrouter/agentrouter")).createAgentRouterAdapter(),
    loadModels: async () => (await import("../integrations/agentrouter/agentrouter")).AGENTROUTER_MODELS,
  },
  gemini: {
    loadAdapter: async () => (await import("../integrations/gemini")).createGeminiAdapter(),
    loadModels: async () => {
      const gemini = await import("../integrations/gemini");
      // One module, two catalog halves: the chat rows and the Google Search
      // grounding rows are the same Gemini models on two service kinds, and
      // importing the module twice would load it twice.
      return [...gemini.GEMINI_MODELS, ...gemini.GEMINI_SEARCH_MODELS];
    },
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/gemini"),
      (module) => module.discoverGeminiModels,
    ),
  },
  aihubmix: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/aihubmix")).AIHUBMIX_SPEC),
    loadModels: async () => (await import("../integrations/aihubmix")).AIHUBMIX_FALLBACK_MODELS,
  },
  bai: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/bai")).BAI_SPEC),
    loadModels: async () => (await import("../integrations/bai")).BAI_FALLBACK_MODELS,
  },
  tokenharbor: {
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/tokenharbor")).TOKENHARBOR_SPEC),
    loadModels: async () => (await import("../integrations/tokenharbor")).TOKENHARBOR_FALLBACK_MODELS,
  },
};
