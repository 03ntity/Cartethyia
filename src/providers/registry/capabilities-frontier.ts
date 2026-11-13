// dynamic-import-ok: capability rows for the frontier labs: OpenAI, Anthropic, Claude, Codex, Grok, xAI, Antigravity.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryCapability, type ModelDiscoveryRequest } from "../configured-provider";
import { defineModel } from "../provider-model-definition";
import { oauthCapability, quotaCapability } from "../provider-registry";
import { openAIModelDiscovery } from "./capability-helpers";

export const FRONTIER_CAPABILITIES = {
  openai: {
    endpointPathsByWireFamily: { chat: "/v1/chat/completions", responses: "/v1/responses" },
    loadAdapter: async () => createApiKeyAdapter((await import("../integrations/openai")).OPENAI_SPEC),
    loadModels: async () => (await import("../integrations/openai")).OPENAI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("openai", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  anthropic: {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("../integrations/anthropic")).createAnthropicAdapter(),
    loadModels: async () => (await import("../integrations/anthropic")).ANTHROPIC_MODELS,
    loadModelDiscovery: openAIModelDiscovery("anthropic", { headers: (credential) => ({ "x-api-key": credential, "anthropic-version": "2023-06-01" }) }),
  },
  claude: {
    loadAdapter: async () => (await import("../integrations/claude/claude")).claudeAdapter,
    loadModels: async () => (await import("../integrations/claude/claude")).CLAUDE_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/claude/claude-oauth"), "claudeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/claude/claude-quota"), "fetchClaudeQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/claude/claude-oauth"),
      (module) => async ({ credential, fetchFn }: { credential: string; fetchFn: typeof fetch }) => {
        const { modelIds } = await module.discoverClaudeModels(credential, fetchFn);
        // `defineModel` resolves limits/pricing by model name: an exact catalog
        // row first, then the bare id, then the most-agreed row for that name
        // (date suffixes stripped). The live listing carries dated ids
        // (`claude-sonnet-4-5-20250929`) the catalog files undated, so a name
        // match is what fills their limits — a hardcoded `null` here is what
        // rendered "n/a ctx · n/a out".
        return modelIds.map((modelId) =>
          defineModel({
            id: modelId,
            providerId: "claude",
            wireFamily: "messages",
            endpoint: "/v1/messages",
            vision: true,
            reasoning: true,
            toolCall: true,
          }),
        );
      },
      ({ credential, fetcher }: ModelDiscoveryRequest) => ({
        credential,
        fetchFn: fetcher ?? globalThis.fetch,
      }),
    ),
  },
  codex: {
    loadAdapter: async () => (await import("../integrations/codex/codex")).createCodexAdapter({ provider_id: "codex" }),
    loadModels: async () => {
      const { CODEX_MODELS, CODEX_SEARCH_MODELS } = await import("../integrations/codex/codex");
      return [...CODEX_MODELS, ...CODEX_SEARCH_MODELS];
    },
    loadAuthentication: oauthCapability(() => import("../integrations/codex/codex-oauth"), "codexOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/codex/codex-quota"), "fetchCodexQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/codex/codex"),
      (module) => module.discoverCodexModels,
    ),
  },
  grok: {
    loadAdapter: async () => (await import("../integrations/grok/grok")).grokAdapter,
    loadModels: async () => (await import("../integrations/grok/grok")).GROK_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/grok/grok-oauth"), "grokOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/grok/grok-quota"), "fetchGrokQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/grok/grok"),
      (module) => module.fetchGrokModels,
    ),
  },
  xai: {
    endpointPathsByWireFamily: { responses: "/responses" },
    loadAdapter: async () => (await import("../integrations/xai/xai")).xaiAdapter,
    loadModels: async () => (await import("../integrations/xai/xai")).XAI_MODELS,
    loadAuthentication: oauthCapability(() => import("../integrations/xai/xai-oauth"), "xaiOAuthClient", { withRefresher: true }),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/xai/xai-discovery"),
      (module) => module.discoverXaiModels,
    ),
  },
  antigravity: {
    loadAdapter: async () => (await import("../integrations/antigravity/antigravity")).antigravityAdapter,
    loadModels: async () => {
      const { ANTIGRAVITY_MODELS, ANTIGRAVITY_SEARCH_MODELS } = await import("../integrations/antigravity/antigravity");
      return [...ANTIGRAVITY_MODELS, ...ANTIGRAVITY_SEARCH_MODELS];
    },
    loadAuthentication: oauthCapability(() => import("../integrations/antigravity/antigravity-oauth"), "antigravityOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("../integrations/antigravity/antigravity-quota"), "fetchAntigravityQuota"),
    loadModelDiscovery: discoveryCapability(
      () => import("../integrations/antigravity/antigravity-protocol"),
      (module) => async ({ credential, baseUrl, fetcher }: ModelDiscoveryRequest) => {
        // The reference client resolves the project before catalog calls; the
        // live backend accepts both, but sending it matches the captured wire.
        const projectId = await module.loadAntigravityProject(credential, {
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(fetcher ? { fetcher } : {}),
        }).catch(() => undefined);
        return module.discoverAntigravityModels(credential, {
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(fetcher ? { fetcher } : {}),
          ...(projectId === undefined ? {} : { projectId }),
        });
      },
    ),
  },
};
