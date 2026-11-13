import { SERVICE_KINDS, type ServiceKind, type WireFamily } from "../protocol/canonical-model";
import {
  BUNDLED_PROVIDER_METADATA,
  type BundledProviderId,
  type BundledProviderMetadata,
  type ProviderJwtVerification,
} from "./bundled-provider-manifest";

/** OpenAI-compatible wire overrides persisted for bundled and BYOK providers. */
export interface CompatibilityProfile {
  readonly extra_headers?: Readonly<Record<string, string>>;
  readonly extra_query_params?: Readonly<Record<string, string>>;
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  readonly streaming_usage_mode?: "include_usage" | "none";
  readonly structured_output?: { readonly mode: "json_object" | "json_schema"; readonly enabled: boolean; readonly schema?: Record<string, unknown> };
  readonly model_wire_families?: ReadonlyArray<{
    readonly pattern: string;
    readonly wire_family: WireFamily;
  }>;
  /** Whether requests to OpenAI/Anthropic-compatible upstream should send official CLI headers. Defaults to true. */
  readonly cli_identity?: boolean;
  /**
   * Direct egress for this provider uses the runtime-native fetch instead of
   * the Node-stack pinned agent. Some upstreams meter per client transport
   * fingerprint — OpenCode's anonymous free tier refuses the Node agent with
   * 429 FreeUsageLimitError while accepting the native fetch byte-for-byte
   * (verified live). The SSRF resolve/validate pass still runs for every hop;
   * only the socket-level address pin is traded away.
   */
  readonly preferNativeFetch?: boolean;
  /**
   * Opts this provider into the gateway identity (`user-agent:
   * `Cartethyia/<version>`) instead of official CLI cloaking. Explicit only:
   * Codex/Claude-Code-shaped traffic can never take this path, and unsetting
   * it restores CLI headers. Persisted on the provider row for BYOK rows;
   * bundled specs declare it on `ApiKeyProviderSpec.gatewayUserAgent`.
   */
  readonly gateway_user_agent?: boolean;
  /**
   * Which service surfaces this custom provider may serve. Absent means every
   * kind is enabled (the historical default). The operator narrows this by
   * checking only the capabilities their upstream actually answers — agentic
   * (LLM) is always on when the list is present, and a kind the upstream
   * cannot serve stays out of the provider's tab set.
   */
  readonly service_kinds?: readonly ServiceKind[];
}
export { BUNDLED_PROVIDER_METADATA } from "./bundled-provider-manifest";
export type {
  BundledProviderId,
  BundledProviderMetadata,
  ProviderJwtVerification,
} from "./bundled-provider-manifest";

/**
 * The Buddy family: CodeBuddy and its China tenant.
 *
 * They share one billing and credit system, so several layers need to ask "is
 * this a Buddy provider" — the health recorder, the request preparer, and the
 * daily check-in. Each had its own list, which is how a fourth sibling would
 * get added in one place and silently missed in the others. Declared here
 * beside the identities it names; the layers keep their own *policies*.
 */
export const BUDDY_PROVIDER_IDS: ReadonlySet<string> = new Set(["cb", "cbcn"]);


const ADAPTER_USER_AGENT_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((provider) => provider.hasAdapterUserAgent).map((provider) => provider.id),
);

/** Bundled metadata keyed by provider id for O(1) lookups. */
const BUNDLED_PROVIDER_BY_ID: ReadonlyMap<BundledProviderId, BundledProviderMetadata> = new Map(
  BUNDLED_PROVIDER_METADATA.map((definition) => [definition.id, definition]),
);

/** Whether the bundled adapter provides its own upstream User-Agent. */
export function providerHasAdapterUserAgent(providerId: string): boolean {
  return ADAPTER_USER_AGENT_PROVIDER_IDS.has(providerId);
}

/**
 * Where an operator obtains this provider's credential, or `undefined` when the
 * provider publishes no such page (a BYOK provider, or one whose credential is
 * minted inside a device/browser flow with no dedicated key page).
 */
export function providerCredentialUrl(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.credentialUrl;
}

/**
 * Short guidance for a provider whose sign-in is not a plain paste-a-key flow.
 * `undefined` where the link alone is self-explanatory.
 */
export function providerCredentialHint(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.credentialHint;
}

/** Presentation-only limitation for the provider detail page. */
export function providerOperatorNotice(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.operatorNotice;
}

/** Canonical builtin display name; falls back to the provider id for unknowns. */
export function providerDisplayName(providerId: string): string {
  return (
    BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.displayName ??
    providerId
  );
}

/**
 * Canonical service surfaces a provider can serve.
 *
 * A bundled provider gets exactly what its manifest declares. A custom/BYOK
 * provider has no manifest row, and this is where its capability comes from:
 * `llm` alone is read as "every media surface this gateway knows", so a
 * third-party provider can serve image, video, embeddings, and audio without
 * the gateway having to be taught its id.
 *
 * That widening is deliberate rather than a default of `["llm"]`, because a
 * BYOK provider points at an operator-chosen base URL — the operator already
 * decided what it is, and the alternative silently locked every custom provider
 * out of the generation routes no matter what its upstream actually answers.
 * The upstream still decides: a request for a capability the remote does not
 * have comes back as that remote's own error, not a gateway-side refusal.
 *
 * A custom provider is read as able to serve **every** kind, taken straight
 * from `SERVICE_KINDS` rather than a second list that can drift from it. A
 * surface added to the tuple is reachable by custom providers immediately, and
 * one that is not there cannot be served by anyone.
 *
 * `systemone` and `websearch` are included even though a base URL alone rarely
 * answers them: the upstream still decides, and an operator who points a custom
 * provider at a host that does speak those shapes should not be blocked by the
 * gateway guessing it will not.
 */
export function providerServiceKinds(providerId: string): readonly ServiceKind[] {
  const declared = BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)
    ?.serviceKinds;
  // Bundled providers are explicit: they say which surfaces they serve, and a
  // bundled provider without the declaration serves LLM only.
  if (declared !== undefined) return declared;
  return SERVICE_KINDS;
}

/**
 * Resolves the service kinds for a custom (BYOK) provider row.
 *
 * The operator may narrow the surface set via `compatibilityProfile.service_kinds`
 * (the Advanced Capabilities checkboxes in the Add Custom Provider modal). Absent,
 * every kind is allowed — the historical default. A present list never drops
 * `llm` (agentic is the floor of a custom provider).
 */
export function customProviderServiceKinds(
  compatibilityProfile: CompatibilityProfile | null | undefined,
): readonly ServiceKind[] {
  const kinds = compatibilityProfile?.service_kinds;
  if (kinds === undefined || kinds.length === 0) return SERVICE_KINDS;
  const set = new Set<ServiceKind>(SERVICE_KINDS.filter((kind) => kinds.includes(kind)));
  set.add("llm");
  return SERVICE_KINDS.filter((kind) => set.has(kind));
}


/** Canonical builtin base URL used by adapters, discovery, and quota clients. */
export function providerBaseUrl(providerId: string): string {
  const entry = BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId);
  if (!entry) throw new Error(`Unknown builtin provider "${providerId}"`);
  return entry.baseUrl.replace(/\/+$/, "");
}

/** Wire-path compatibility overrides owned by the canonical provider registry. */
export const PROVIDER_COMPATIBILITY_PROFILES: Record<string, CompatibilityProfile> = {
  opencode: {
    endpoint_paths_by_wire_family: {
      chat: "/inference/openai/v1/chat/completions",
      responses: "/inference/openai/v1/responses",
    },
    // Direct egress must use the native fetch: the anonymous free tier refuses
    // the Node-stack agent with 429 FreeUsageLimitError (verified live).
    preferNativeFetch: true,
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
  "opencode-zen": {
    endpoint_paths_by_wire_family: {
      chat: "/inference/openai/v1/chat/completions",
      responses: "/inference/openai/v1/responses",
    },
    preferNativeFetch: true,
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
  "opencode-go": {
    endpoint_paths_by_wire_family: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
};

/** Default wire family for a builtin provider. */
export function providerDefaultWireFamily(providerId: string): WireFamily {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.wireFamilyDefault ?? "chat";
}

/**
 * Whether a builtin provider's adapter frames its own wire protocol, so no
 * canonical codec serves its rows. Unknown ids answer `false`: only a bundled
 * module can declare this, and a BYOK row always uses the shared
 * OpenAI-compatible adapter.
 */
export function providerUsesBespokeWire(providerId: string): boolean {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.bespokeWire ?? false;
}

/** Whether a builtin provider requires a persisted account row. */
export function providerRequiresAccount(providerId: string): boolean {
  return BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.requiresAccount ?? true;
}

/**
 * JWT verification defaults for a builtin provider. Providers without a
 * published JWKS/issuer return `{}`, so their tokens get registered-claim
 * validation only.
 */
export function providerJwtVerification(providerId: string): ProviderJwtVerification {
  return (
    BUNDLED_PROVIDER_BY_ID.get(providerId as BundledProviderId)?.jwtVerification ?? {}
  );
}

/** Static upstream host derived from the canonical base URL. */
export function providerUpstreamHost(providerId: string): { readonly hostname: string; readonly port: number } {
  const url = new URL(providerBaseUrl(providerId));
  return { hostname: url.hostname, port: url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443 };
}

/** Default proxy-skip providers. */
export const DEFAULT_PROXY_SKIP_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((entry) => entry.defaultSkipProxy === true).map((entry) => entry.id),
);

/** Providers whose rate limits follow the egress address, not a credential. */
const IP_SCOPED_RATE_LIMIT_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((entry) => entry.ipScopedRateLimit === true).map((entry) => entry.id),
);

/**
 * Whether a provider-scoped 429 should cool the proxy pool down.
 *
 * Only an IP-keyed provider warrants it: the pool is the resource that ran out
 * of allowance, so backing it off is the fix. For every other provider the 429
 * belongs to the account that was dialed — the account health machine already
 * records it, and cooling the pool as well would sideline every healthy sibling
 * sharing that egress. Unknown ids (a BYOK provider) are account-keyed: a
 * configurable upstream states nothing about IP scoping, so the pool is left
 * alone.
 */
export function providerRateLimitIsIpScoped(providerId: string | undefined): boolean {
  return providerId !== undefined && IP_SCOPED_RATE_LIMIT_PROVIDER_IDS.has(providerId);
}

