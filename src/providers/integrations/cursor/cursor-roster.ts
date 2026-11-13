// Per-account Cursor model-roster cache. A Run needs the model's declared
// default parameter tuple, but the roster is per-account and moves rarely, so
// it is fetched once and reused rather than on every dispatch.
import { fnv1a32 } from "../shared/hash";
import { TtlCache } from "../../../persistence/ttl-cache";
import type { CursorModelInfo } from "./cursor-catalog";

/**
 * How long one account's model roster is reused for `parameters` lookups.
 *
 * A Run needs the model's declared default parameter tuple, but the roster is
 * per-account and moves rarely, so it is fetched once and cached rather than on
 * every dispatch.
 */
const CURSOR_ROSTER_TTL_MS = 300_000;
/**
 * credential → roster for the parameter lookup.
 *
 * Keyed by an FNV-1a digest of the credential rather than the raw token so a
 * long-lived map does not hold live credentials as keys. Bounded by
 * `ROSTER_CACHE_MAX` with LRU eviction: the TTL is only checked on read, so
 * without a cap rotated tokens would grow the map without bound. Implemented
 * by the canonical `TtlCache` in LRU mode — re-setting moves the entry to the
 * newest position, and the cap evicts the least-recently-used entry.
 */
const ROSTER_CACHE_MAX = 1024;
const rosterCache = new TtlCache<{ roster: readonly CursorModelInfo[] }>({
  ttlMs: CURSOR_ROSTER_TTL_MS,
  maxEntries: ROSTER_CACHE_MAX,
  lru: true,
});

export function rosterCacheGet(
  credential: string,
): { roster: readonly CursorModelInfo[] } | undefined {
  return rosterCache.get(String(fnv1a32(credential)));
}

/** Peek without expiring: the stale roster is the refetch-failure fallback. */
export function rosterCachePeek(
  credential: string,
): { roster: readonly CursorModelInfo[] } | undefined {
  return rosterCache.peek(String(fnv1a32(credential)));
}

export function rosterCacheSet(
  credential: string,
  roster: readonly CursorModelInfo[],
): void {
  const key = String(fnv1a32(credential));
  rosterCache.set(key, { roster });
}

/**
 * Test-only access to the roster cache (cap/eviction/TTL behavior is covered
 * by `test/providers/cursor-roster-cache.test.ts` without a full dispatch).
 */
export const rosterCacheForTests = {
  size: (): number => rosterCache.size,
  set: rosterCacheSet,
  get: (credential: string): { roster: readonly CursorModelInfo[] } | undefined =>
    rosterCache.get(String(fnv1a32(credential))),
};
