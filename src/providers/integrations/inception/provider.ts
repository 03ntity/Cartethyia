import type { ApiKeyProviderSpec } from "../../configured-provider";
import { fetchOpenAICompatibleModels } from "../../discovery/openai-model-discovery";
import { defineModel, type ModelDefinition } from "../../provider-model-definition";

const INCEPTION_PROVIDER_ID = "inception" as const;

/**
 * Inception Labs (Mercury) — bearer-authenticated OpenAI-compatible chat.
 *
 * The upstream is a plain `POST /v1/chat/completions` service (SSE streaming,
 * tool calling, structured outputs, `reasoning_effort`). Base URL comes from
 * `BUNDLED_PROVIDER_METADATA`; the chat path is declared below the `/v1`
 * root, exactly like every other version-rooted OpenAI-compatible provider.
 */
export const INCEPTION_SPEC: ApiKeyProviderSpec = {
  provider_id: INCEPTION_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
};

/**
 * Offline floor: the Mercury chat model this provider serves, pinned to the
 * free-tier allowance (100M free tokens at signup).
 *
 * The roster intentionally carries only `mercury-3` — the operator's choice.
 * Mercury Voice is enterprise-gated, Mercury Decide is a native decisions
 * endpoint, and Mercury Edit 2 is FIM/edit; none of them is a chat model, and
 * a chat wire would not serve them.
 *
 * `freeTier` is the catalog flag the console groups on; `free: true` zeroes
 * the cost the way every other free-allowance provider models its rows — the
 * allowance does not bill, so the row must not show a price. Limits are
 * mercury-3's own chat-completions numbers: 1M context, 131072 max output,
 * reasoning (instant/low/medium/high), tool calling.
 */
export const INCEPTION_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "mercury-3",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 1_000_000,
    out: 131_072,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
];

/**
 * Live `/v1/models` listing, pinned to the free tier.
 *
 * The listing requires the API key (matches the chat endpoint's bearer), so
 * the credential is forwarded when present; an unauthenticated fetch fails
 * cleanly and the static roster stays authoritative.
 *
 * Every fetched row is stamped `freeTier` and zero-priced, the same rule the
 * static roster declares: this provider is pinned to its free allowance, so a
 * model upstream adds must not land in the billed tail.
 *
 * A fetched id that the static roster already knows keeps the roster row
 * whole, not the listing's fields: upstream publishes `max_output_length` and
 * no `reasoning`/`tool_call` keys, so the shared OpenAI-compatible reader
 * would otherwise overwrite mercury-3's advertised 131072 output and reasoning
 * flag with its 64k/not-reasoning defaults. The roster is the canonical
 * metadata for the models we know; the listing only adds genuinely new ids.
 */
export async function discoverInceptionFreeModels(options: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const listed = await fetchOpenAICompatibleModels({
    baseUrl: options.baseUrl,
    providerId: "inception",
    ...(typeof options.credential === "string" && options.credential.trim().length > 0
      ? { headers: { authorization: `Bearer ${options.credential}` } }
      : {}),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (listed === null) return null;
  const known = new Map(INCEPTION_MODELS.map((model) => [model.modelId, model]));
  return listed.map((model) => {
    const roster = known.get(model.modelId);
    if (roster !== undefined) return roster;
    return {
      ...model,
      freeTier: true,
      cost: { input: 0, output: 0, pricing_model: "pay-per-use" },
    };
  });
}
