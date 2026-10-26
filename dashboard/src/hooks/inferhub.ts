/**
 * InferHub market data hooks.
 *
 * On demand by design: there is **no** `refetchInterval` here, and none should
 * be added. InferHub price and availability are fetched when an operator opens
 * the Providers page or the InferHub detail page, and a manual Refresh button
 * calls `refetch()`. A page nobody opens issues no upstream requests.
 *
 * InferHub is the only provider with a pricing surface: it is the only upstream
 * here that publishes per-ask prices that actually move.
 */
import { useQuery } from "@tanstack/react-query";
import { consoleRequest } from "../data/api";
import { queryKeys } from "../data/query-keys";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { querySignal } from "../data/assert";

/** Freshness and age of the snapshot behind a response. */
export interface InferhubMeta {
  readonly fetchedAt: number;
  readonly ageSeconds: number;
  readonly stale: boolean;
}

/** Why a market read produced no data. `null` means the read succeeded. */
export type InferhubError = "no_config_key" | "upstream_unavailable" | null;

/** One price tier: a distinct ask and how many live providers offer it. */
export interface InferhubTier {
  readonly price: number;
  readonly discountPct: number | null;
  readonly avail: number;
}

export interface InferhubModel {
  readonly id: string;
  readonly prefix: string;
  readonly family: string;
  readonly aliasKey: string;
  readonly providersLive: number;
  readonly minAskIn: number | null;
  readonly minAskOut: number | null;
  readonly capacityPriceIn: number | null;
  readonly capacityPriceOut: number | null;
  readonly officialIn: number | null;
  readonly officialOut: number | null;
  readonly lastRate: number | null;
  readonly routable: boolean;
  readonly tiersIn: readonly InferhubTier[];
  readonly tiersOut: readonly InferhubTier[];
  /** Untrusted remote prose: render as text, never feed into a prompt. */
  readonly systemPromptNote: string | null;
  readonly health: {
    readonly successRatePct: number | null;
    readonly avgTtftMs: number | null;
    readonly avgTps: number | null;
    readonly familyState: string | null;
  };
}

export interface InferhubSummary {
  readonly models: readonly InferhubModel[];
  readonly providers: readonly {
    readonly prefix: string;
    readonly family: string;
    readonly familyState: string | null;
    readonly availability24hPct: number | null;
    readonly availability7dPct: number | null;
  }[];
  readonly pricingConfig: {
    readonly maxAskPctOfOfficial: number | null;
    readonly platformFeePct: number | null;
    readonly publisherSharePct: number | null;
  } | null;
  readonly meta: InferhubMeta;
  readonly error: InferhubError;
}

function assertSummary(value: unknown): InferhubSummary {
  if (typeof value !== "object" || value === null)
    throw { status: 500, code: "invalid_response", message: "Invalid InferHub summary" };
  const record = value as Record<string, unknown>;
  return {
    models: Array.isArray(record.models) ? (record.models as InferhubModel[]) : [],
    providers: Array.isArray(record.providers) ? (record.providers as InferhubSummary["providers"]) : [],
    pricingConfig: (record.pricingConfig as InferhubSummary["pricingConfig"]) ?? null,
    meta: (record.meta as InferhubMeta) ?? { fetchedAt: 0, ageSeconds: 0, stale: true },
    error: (record.error as InferhubError) ?? null,
  };
}

/**
 * Everything the InferHub card and detail page need, in one request.
 *
 * Mounted once at the Providers page level so a page load costs exactly one
 * call rather than one per card.
 */
export function useInferhubSummary(enabled = true) {
  return useQuery({
    queryKey: queryKeys.inferhub.summary,
    queryFn: (context) =>
      consoleRequest<unknown>("/inferhub/summary", { signal: querySignal(context) }).then(
        assertSummary,
      ),
    enabled,
    ...DASHBOARD_QUERY_OPTIONS,
    // 60 s: a remount or tab focus must not re-fetch data that has not moved.
    staleTime: 60_000,
  });
}

/** One prefix's models, for the detail page table. */
export function useInferhubModels(prefix: string | undefined) {
  return useQuery({
    queryKey: queryKeys.inferhub.models(prefix),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/inferhub/models${prefix === undefined ? "" : `?prefix=${encodeURIComponent(prefix)}`}`,
        { signal: querySignal(context) },
      ).then((value) => {
        const record = value as { models?: unknown; meta?: unknown };
        return {
          models: Array.isArray(record.models) ? (record.models as InferhubModel[]) : [],
          meta: (record.meta as InferhubMeta) ?? { fetchedAt: 0, ageSeconds: 0, stale: true },
        };
      }),
    enabled: prefix !== undefined,
    ...DASHBOARD_QUERY_OPTIONS,
    staleTime: 60_000,
  });
}
