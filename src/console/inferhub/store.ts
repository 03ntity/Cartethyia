/**
 * InferHub market snapshot store.
 *
 * A read-through cache with a freshness window — deliberately **not** a poller.
 * There is no timer, no interval, and no scheduler registration: a request
 * either finds a fresh snapshot and returns it, or reports a miss and the route
 * triggers one fetch. A page nobody opens causes no upstream traffic.
 *
 * A failed refresh never overwrites good data. The previous snapshot stays
 * readable and the route reports it as stale, so an operator sees the age of
 * what they are looking at rather than an empty table.
 */
import type {
  InferhubSource,
  ModelMarket,
  PricingConfig,
  ProviderMarket,
  SnapshotMeta,
} from "./types";

/**
 * How long a snapshot is served before a route re-fetches.
 *
 * `/status` and `/catalog` are server-cached for about a minute upstream, so
 * polling them faster would return the same bytes; the catalog is heavy, so it
 * gets a longer window.
 */
const FRESHNESS_MS: Readonly<Record<InferhubSource, number>> = {
  market: 60_000,
  status: 60_000,
  catalog: 300_000,
  pricingConfig: 3_600_000,
};

interface Entry<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

const market = { current: undefined as Entry<readonly ModelMarket[]> | undefined };
const status = { current: undefined as Entry<{ models: readonly ModelMarket[]; providers: readonly ProviderMarket[] }> | undefined };
const pricingConfig = { current: undefined as Entry<PricingConfig> | undefined };

/** Freshness and age of one snapshot, as the API reports it. */
export function metaFor(fetchedAt: number | undefined, source: InferhubSource, now: number): SnapshotMeta {
  if (fetchedAt === undefined) return { fetchedAt: 0, ageSeconds: 0, stale: true };
  const ageSeconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  return { fetchedAt, ageSeconds, stale: now - fetchedAt > FRESHNESS_MS[source] };
}

/**
 * Returns the cached value when it is still inside its freshness window.
 *
 * A miss returns `undefined` **without** fetching — the fetch decision belongs
 * to the caller, which is what keeps this module free of background work.
 */
export function getFreshModels(now: number = Date.now()): readonly ModelMarket[] | undefined {
  const entry = market.current;
  if (entry === undefined) return undefined;
  return now - entry.fetchedAt <= FRESHNESS_MS.market ? entry.value : undefined;
}

export function getFreshStatus(
  now: number = Date.now(),
): { models: readonly ModelMarket[]; providers: readonly ProviderMarket[] } | undefined {
  const entry = status.current;
  if (entry === undefined) return undefined;
  return now - entry.fetchedAt <= FRESHNESS_MS.status ? entry.value : undefined;
}

export function getFreshPricingConfig(now: number = Date.now()): PricingConfig | undefined {
  const entry = pricingConfig.current;
  if (entry === undefined) return undefined;
  return now - entry.fetchedAt <= FRESHNESS_MS.pricingConfig ? entry.value : undefined;
}

/** Last-known value regardless of age, for serving a stale-but-real view. */
export function getStaleModels(): Entry<readonly ModelMarket[]> | undefined {
  return market.current;
}

export function getStaleStatus(): Entry<{
  models: readonly ModelMarket[];
  providers: readonly ProviderMarket[];
}> | undefined {
  return status.current;
}

export function setModels(value: readonly ModelMarket[], fetchedAt: number): void {
  market.current = { value, fetchedAt };
}

export function setStatus(
  value: { models: readonly ModelMarket[]; providers: readonly ProviderMarket[] },
  fetchedAt: number,
): void {
  status.current = { value, fetchedAt };
}

export function setPricingConfig(value: PricingConfig, fetchedAt: number): void {
  pricingConfig.current = { value, fetchedAt };
}

/** Test seam: clears every snapshot. */
export function __resetStore(): void {
  market.current = undefined;
  status.current = undefined;
  pricingConfig.current = undefined;
}
