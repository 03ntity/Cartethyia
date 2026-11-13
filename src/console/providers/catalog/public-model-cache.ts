/**
 * The `/v1/models` listing cache: keying, the bounded LRU, and cross-process
 * invalidation. Extracted from `public-model-store.ts`; the store class and
 * the catalog queries live in `public-model-store.ts`.
 *
 * `/v1/models` is the most-polled endpoint a client has: SDKs and CLIs list
 * models on startup, and several of them do it per request. Uncached it is
 * four or five Postgres round-trips plus a full materialization of the
 * catalog, per call - on a 1-core box that is the single cheapest thing to
 * remove from the hot path.
 *
 * The cache is keyed by everything that can change the answer, including the
 * key's own allow/deny list, so a change to any of it produces a different key
 * rather than a stale hit.
 */
import { publishInvalidation, subscribeInvalidation } from "../../../persistence/shared-cache";
import type { ApiKeyAuthorizationSnapshot } from "../../../security/api-key-auth";
import type { AllowedModelEntry } from "./public-model-projections";
import { pickDefined } from "../../shared/object";

export const PUBLIC_MODEL_CACHE_MAX_ENTRIES = 256;
/**
 * Short on purpose. Correctness does not depend on it - every mutation
 * invalidates explicitly - so this is only the backstop for a peer that missed
 * a broadcast notice. Three seconds means a missed notice costs seconds of
 * staleness, not until the next restart.
 */
export const PUBLIC_MODEL_CACHE_TTL_MS = 3_000;

export interface PublicModelCacheEntry {
  readonly expiresAt: number;
  readonly value: readonly AllowedModelEntry[];
}

/**
 * Insertion-ordered Map used as an LRU: `get` re-inserts to refresh recency,
 * and eviction deletes the first key, which is the least recently used. A Map
 * preserves insertion order, so this is O(1) without a second structure.
 */
export const publicModelCache = new Map<string, PublicModelCacheEntry>();
/**
 * One in-flight build per key, so concurrent misses do not duplicate the work.
 *
 * Typed to the method's own return shape (`AllowedModelEntry[]`): the promise
 * is returned directly to callers, so it must match the public signature.
 */
export const publicModelInFlight = new Map<string, Promise<AllowedModelEntry[]>>();

let publicModelInvalidationUnsubscribe: (() => void) | undefined;

/**
 * Subscribes to peer invalidation notices. Idempotent: the first store
 * instance subscribes, later instances share the one subscription so a
 * subscription per instance does not leak one Redis connection per store.
 */
export function ensurePublicModelInvalidationSubscription(): void {
  publicModelInvalidationUnsubscribe ??= subscribeInvalidation((notice) => {
    if (notice.namespace === "public-models") {
      invalidatePublicModelCache(notice.key);
      return;
    }
    // A routing invalidation means the catalog changed - a provider, model,
    // or account write - and every model listing is derived from it. Every
    // such mutation already funnels through `snapshotService.invalidate()`,
    // so this covers provider/model/account/alias/combo writes without the
    // console having to know each call site, and without the transport layer
    // importing this console module.
    if (notice.namespace === "routing") invalidatePublicModelCache();
  });
}

/** Builds the cache key: every input that can change the answer. */
export function publicModelCacheKey(
  tenantId: string | null,
  snapshot: ApiKeyAuthorizationSnapshot,
  modelPrefix: string | undefined,
): string {
  // `model_list` is canonicalized: the same list in a different order, or as a
  // Set rather than an array, is the same authorization and must hit the same
  // entry.
  const list = snapshot.model_list ? [...snapshot.model_list] : [];
  list.sort();
  return [
    tenantId ?? "",
    snapshot.api_key_id,
    snapshot.model_access_mode ?? "",
    JSON.stringify(list),
    modelPrefix ?? "",
  ].join("\u0000");
}

/**
 * Drops cached listings.
 *
 * `tenantId` omitted clears everything; a mutation that only affects one
 * tenant should not evict another tenant's entries.
 */
export function invalidatePublicModelCache(tenantId?: string): number {
  let dropped = 0;
  for (const key of [...publicModelCache.keys()]) {
    if (tenantId !== undefined && !key.startsWith(`${tenantId}\u0000`)) continue;
    if (publicModelCache.delete(key)) dropped += 1;
  }
  return dropped;
}

/** Test/observability accessor: how many listings are cached. */
export function publicModelCacheSize(): number {
  return publicModelCache.size;
}

/**
 * Broadcasts "this tenant's model listing changed" to peer processes.
 *
 * Fire-and-forget, like the routing notice: this process has already dropped
 * its own copy, and a peer that misses the notice still converges when the
 * entry's 3 s TTL lapses.
 */
function publishPublicModelInvalidation(tenantId?: string): void {
  publishInvalidation({
    namespace: "public-models",
    ...pickDefined({ key: tenantId }),
  });
}

/**
 * Invalidates after a mutation that can change a model listing.
 *
 * Local drop first, then the broadcast: if the order were reversed a peer's
 * rebuild could race this process's own cache clear.
 */
export function invalidatePublicModels(tenantId?: string): void {
  invalidatePublicModelCache(tenantId);
  publishPublicModelInvalidation(tenantId);
}
