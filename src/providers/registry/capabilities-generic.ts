// dynamic-import-ok: capability rows built from the shared generic API-key specs and the Anthropic-wire helper.
// Each loader is an `async () => (await import("<integration module>"))` closure so a
// provider pays only when the first request routes to it; a static import here would
// drag the integration into memory at process start.
import { createApiKeyAdapter, discoveryBackedCapabilities, GENERIC_API_KEY_SPECS } from "../configured-provider";
import {
  anthropicWireProvider,
  coalesceSystemParts,
  endpointPathsOf,
  openAIModelDiscovery,
  readCoreWeaveProject,
} from "./capability-helpers";

export const GENERIC_SPEC_CAPABILITIES = {
  coreweave: {
    // Same OpenAI-compatible bearer wire as every other aggregator, plus one
    // requirement none of the shared shapes express: CoreWeave refuses every
    // request that lacks `OpenAI-Project: <team>/<project>`.
    //
    // The value is per-account — one deployment may hold accounts on different
    // teams — so it lives in the account's `auth_state` and is injected per
    // dispatch through the adapter's `buildExtraHeaders` hook. A static
    // `extra_headers` value would pin every account to one team.
    ...endpointPathsOf(GENERIC_API_KEY_SPECS.coreweave),
    loadAdapter: async () =>
      createApiKeyAdapter({
        ...GENERIC_API_KEY_SPECS.coreweave,
        // `OpenAI-Project` is not in `BASE_PROTECTED_HEADERS`, so an operator
        // may also set it as a per-account custom header. Reading both means an
        // account configured either way dispatches.
        buildExtraHeaders: (context) => {
          const project = readCoreWeaveProject(context);
          return project === undefined ? {} : { "OpenAI-Project": project };
        },
      }),
    loadModelDiscovery: openAIModelDiscovery("coreweave", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },

  // Qwen Portal rejects more than one system message with a 500 from its default
  // chat template, so its system parts are coalesced before serialization rather
  // than emitted as separate blocks.
  "qwen-portal": {
    ...endpointPathsOf(GENERIC_API_KEY_SPECS["qwen-portal"]),
    loadAdapter: async () =>
      createApiKeyAdapter({
        ...GENERIC_API_KEY_SPECS["qwen-portal"],
        prepareRequest: coalesceSystemParts,
      }),
    loadModelDiscovery: openAIModelDiscovery("qwen-portal", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  // Live discovery over a static floor: `/v1/models` answers on this host, so a
  // synced account sees whatever the plan currently serves. The catalog keeps
  // the provider usable before anyone syncs.
  dashscope: {
    ...discoveryBackedCapabilities("dashscope", GENERIC_API_KEY_SPECS.dashscope, openAIModelDiscovery),
    loadModels: async () => (await import("../integrations/alibabacp/dashscope-models")).DASHSCOPE_MODELS,
  },

// Anthropic-Messages providers reached with a plain key. The wire path is
  // appended to the base, so each base URL already carries the surface's root
  // (`/anthropic`, or the bare host for Umans) exactly as DeepSeek's does.
  minimax: anthropicWireProvider("minimax"),
  minimaxcode: anthropicWireProvider("minimaxcode"),
  minimaxcodecn: anthropicWireProvider("minimaxcodecn"),
  umans: anthropicWireProvider("umans"),
};
