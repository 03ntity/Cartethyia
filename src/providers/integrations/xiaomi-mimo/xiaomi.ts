import type { ApiKeyProviderSpec } from "../../configured-provider";

const XIAOMIPG_PROVIDER_ID = "xiaomipg" as const;
const XIAOMITP_PROVIDER_ID = "xiaomitp" as const;



import { catalogRows } from "../shared/catalog-rows";
import type { ModelDefinition } from "../../provider-model-definition";

type XiaomiCatalogRow = readonly [
  id: string,
  contextLimit: number,
  outputLimit: number,
  options?: { readonly vision?: boolean },
];

const xiaomiModel = catalogRows<XiaomiCatalogRow>({
  caps: {
    wireFamily: "chat",
    endpoint: "/chat/completions",
    reasoning: true,
    toolCall: true,
  },
  translate: ([, contextLimit, outputLimit, options]) => ({
    ctx: contextLimit,
    out: outputLimit,
    vision: options?.vision ?? false,
  }),
});

export const XIAOMI_MODELS: readonly ModelDefinition[] = ([
  ["mimo-v2.5-pro", 131_072, 16_384],
  ["mimo-v2.5", 131_072, 16_384, { vision: true }],
] as const satisfies readonly XiaomiCatalogRow[]).map(xiaomiModel);


/** Xiaomi MiMo (PAYG) — own upstream origin via `BUNDLED_PROVIDER_METADATA`. */
export const XIAOMIPG_SPEC: ApiKeyProviderSpec = {
  provider_id: XIAOMIPG_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
};

/** Xiaomi MiMo (Token Plan) — separate upstream origin. */
export const XIAOMITP_SPEC: ApiKeyProviderSpec = {
  provider_id: XIAOMITP_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
};
