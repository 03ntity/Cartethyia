// dynamic-import-ok: lazy per-realm capability map. Each buddy regional
// product (cb/cbcn) imports its adapter + oauth + discovery on first use so a
// deployment that only serves one realm never drags the others into memory.
import type { ProviderModuleCapabilities } from "../../provider-registry";
import { oauthCapability, quotaCapability } from "../../provider-registry";
import {
  discoveryCapability,
  type ModelDiscoveryRequest,
} from "../../configured-provider";

type BuddyProviderId = "cb" | "cbcn";

/**
 * Maps the orchestration context onto the `DiscoveryInput` the buddy
 * `discover*Models` exports declare. `signal` is not part of the context, so
 * only the credential and the optional fetcher cross over.
 */
function discoveryInput({ credential, fetcher }: ModelDiscoveryRequest) {
  return {
    credential,
    ...(fetcher === undefined ? {} : { fetcher }),
  };
}

/**
 * Lazy capability declarations for Buddy's two independently identified
 * regional products.
 */
export const BUDDY_PROVIDER_CAPABILITIES = {
  cb: {
    loadAdapter: async () => (await import("./codebuddy/index")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./codebuddy/index")).CODEBUDDY_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("./codebuddy/index"),
      (module) => module.discoverCodeBuddyModels,
      discoveryInput,
    ),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/index"),
      "codeBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/index"),
      "fetchCodeBuddyIntlQuota",
    ),
  },
  cbcn: {
    loadAdapter: async () => (await import("./codebuddy/index")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./codebuddy/index")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: discoveryCapability(
      () => import("./codebuddy/index"),
      (module) => module.discoverCodeBuddyCnModels,
      discoveryInput,
    ),
    loadAuthentication: oauthCapability(
      () => import("./codebuddy/index"),
      "codeBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./codebuddy/index"),
      "fetchCodeBuddyCnQuota",
    ),
  },
} satisfies Readonly<Record<BuddyProviderId, ProviderModuleCapabilities>>;
