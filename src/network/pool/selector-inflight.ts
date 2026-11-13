/**
 * Inflight accounting behind `NetworkPoolSelector`: local counters, the
 * distributed Redis admit/release scripts, and the weighted/round-robin/
 * random pool selection scan. Cooldown reads live in `selector-cooldowns.ts`,
 * the batched cooldown pre-check in `selector-failure-report.ts`; shared
 * constants and key helpers in `selector-shared.ts`.
 *
 * `PoolInflightBackend` is the slice of the selector these functions need —
 * the class in `selector.ts` supplies it, so the state maps and the
 * pool-usage listener fan-out stay encapsulated.
 */
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";
import {
  POOL_ADMIT_SCRIPT,
  POOL_PROVIDER_ADMIT_SCRIPT,
  POOL_PROVIDER_RELEASE_SCRIPT,
  POOL_RELEASE_SCRIPT,
  proxyInflightKey,
  proxyProviderInflightKey,
} from "./scripts";
import {
  advanceRotation,
  enforceInflightLimit,
  rotationStart,
  type PoolLocalState,
  type PoolRotation,
  type PoolUsageSnapshot,
} from "./state";
import {
  DEFAULT_PROXY_CONCURRENCY,
  decrementLocal,
  effectiveConcurrency,
  normalizedWeight,
  poolInflightTtlSeconds,
  providerInflightStateKey,
} from "./selector-shared";
import { type PoolCooldownBackend } from "./selector-cooldowns";
import { providerCooldownStates } from "./selector-failure-report";

/** The selector surface inflight accounting and selection read. */
export interface PoolInflightBackend {
  readonly state: PoolLocalState;
  readonly redis: RedisClient | undefined;
  getInflight(poolId: string): number;
  getProviderInflight(poolId: string, providerId: string): number;
  getInflightAuthoritative(poolId: string): Promise<number>;
  getProviderInflightAuthoritative(poolId: string, providerId: string): Promise<number>;
}

/** Everything pool admission and selection need from the selector. */
export type PoolSelectionBackend = PoolInflightBackend & PoolCooldownBackend;

export function readGetInflight(backend: PoolSelectionBackend, poolId: string): number {
  return backend.state.inflight.get(poolId) ?? 0;
}

export async function readGetInflightAuthoritative(
  backend: PoolSelectionBackend,
  poolId: string,
): Promise<number> {
  if (!backend.redis) return readGetInflight(backend, poolId);
  const raw = await backend.redis.get(proxyInflightKey(poolId));
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid pool inflight counter: ${poolId}`);
  }
  return value;
}

/**
 * This provider's inflight share of one pool. Zero when the provider has no
 * ceiling configured, because nothing ever records a count for it.
 */
export function readGetProviderInflight(
  backend: PoolSelectionBackend,
  poolId: string,
  providerId: string,
): number {
  return backend.state.providerInflight.get(providerInflightStateKey(poolId, providerId)) ?? 0;
}

export async function readGetProviderInflightAuthoritative(
  backend: PoolSelectionBackend,
  poolId: string,
  providerId: string,
): Promise<number> {
  if (!backend.redis) return readGetProviderInflight(backend, poolId, providerId);
  const raw = await backend.redis.get(proxyProviderInflightKey(poolId, providerId));
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid provider inflight counter: ${poolId}/${providerId}`);
  }
  return value;
}

/**
 * Live usage across every locally tracked pool: one `{poolId, inflight}`
 * row per pool the selector has admitted since boot. Zero-count pools drop
 * out of the map on release, so an idle pool reads as absent (i.e. zero)
 * rather than as a stale row. Process-local like `getInflight` — the Usage
 * page's pool card renders its own instance's view.
 */
export function readSnapshotPoolUsage(backend: PoolSelectionBackend): readonly PoolUsageSnapshot[] {
  const out: PoolUsageSnapshot[] = [];
  for (const [poolId, currentInflight] of backend.state.inflight) {
    out.push({ poolId, currentInflight });
  }
  return out;
}

/**
 * One local slot acquisition: checks every map's ceiling, bumps each counter,
 * and returns a release that decrements all of them exactly once. Shared by
 * `acquire` (single pool counter) and `acquireProvider` (pool + provider
 * share) so the release closure and the local bookkeeping live in one place.
 */
function acquireLocalSlot(
  notifyPoolUsage: () => void,
  increments: ReadonlyArray<{
    readonly map: Map<string, number>;
    readonly key: string;
    readonly capacity: number;
  }>,
): { acquired: boolean; release: () => void } {
  for (const increment of increments) {
    const current = increment.map.get(increment.key) ?? 0;
    if (current >= increment.capacity) return { acquired: false, release: () => {} };
  }
  for (const increment of increments) {
    enforceInflightLimit(increment.map);
    increment.map.set(increment.key, (increment.map.get(increment.key) ?? 0) + 1);
  }
  notifyPoolUsage();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const increment of increments) decrementLocal(increment.map, increment.key);
    notifyPoolUsage();
  };
  return { acquired: true, release };
}

/**
 * Raise this provider's share of a pool, enforcing both the pool ceiling and
 * the provider ceiling. The pool half is still checked here so a caller that
 * already admitted the pool through `acquire` does not double-count it — use
 * this instead of `acquire` whenever a provider ceiling applies.
 */
export function readAcquireProvider(
  backend: PoolSelectionBackend,
  notifyPoolUsage: () => void,
  poolId: string,
  providerId: string,
  poolCapacity: number,
  providerCapacity: number,
): { acquired: boolean; release: () => void } {
  return acquireLocalSlot(notifyPoolUsage, [
    { map: backend.state.inflight, key: poolId, capacity: poolCapacity },
    {
      map: backend.state.providerInflight,
      key: providerInflightStateKey(poolId, providerId),
      capacity: providerCapacity,
    },
  ]);
}

export function readAcquire(
  backend: PoolSelectionBackend,
  notifyPoolUsage: () => void,
  poolId: string,
  maxInflight = DEFAULT_PROXY_CONCURRENCY,
): { acquired: boolean; release: () => void } {
  return acquireLocalSlot(notifyPoolUsage, [
    { map: backend.state.inflight, key: poolId, capacity: maxInflight },
  ]);
}

/**
 * Tries one local candidate: bump the local counters (pool, and provider
 * share when a ceiling is set) and return its release. `undefined` when the
 * candidate is full or the provider share is exhausted.
 */
function localAcquire(
  backend: PoolSelectionBackend,
  notifyPoolUsage: () => void,
  candidate: { readonly poolId: string; readonly capacity: number },
  providerId: string,
  providerCapacity: number | undefined,
): { poolId: string; release: () => void } | undefined {
  const slot =
    providerCapacity === undefined
      ? readAcquire(backend, notifyPoolUsage, candidate.poolId, candidate.capacity)
      : readAcquireProvider(backend, notifyPoolUsage, candidate.poolId, providerId, candidate.capacity, providerCapacity);
  return slot.acquired ? { poolId: candidate.poolId, release: slot.release } : undefined;
}

/**
 * One atomic Redis admit (the compare-and-increment script) for a candidate:
 * bumps both the remote and local counters on success and returns a release
 * that decrements both. `undefined` when the pool or provider share is full
 * (1 admitted; 0 pool full; 2 provider full — either full result fails over
 * to the next pool, which is the whole point of the ceiling).
 */
async function redisAdmit(
  backend: PoolSelectionBackend,
  notifyPoolUsage: () => void,
  redis: RedisClient,
  candidate: { readonly poolId: string; readonly capacity: number },
  providerId: string,
  providerCapacity: number | undefined,
): Promise<{ poolId: string; release: () => void } | undefined> {
  const providerKey =
    providerCapacity === undefined
      ? undefined
      : proxyProviderInflightKey(candidate.poolId, providerId);
  const result =
    providerKey === undefined
      ? await redisEvalNumber(
          redis,
          POOL_ADMIT_SCRIPT,
          1,
          proxyInflightKey(candidate.poolId),
          String(candidate.capacity),
          String(poolInflightTtlSeconds()),
        )
      : await redisEvalNumber(
          redis,
          POOL_PROVIDER_ADMIT_SCRIPT,
          2,
          proxyInflightKey(candidate.poolId),
          providerKey,
          String(candidate.capacity),
          String(providerCapacity),
          String(poolInflightTtlSeconds()),
        );
  if (result !== 1) return undefined;
  enforceInflightLimit(backend.state.inflight);
  backend.state.inflight.set(candidate.poolId, readGetInflight(backend, candidate.poolId) + 1);
  if (providerKey !== undefined) {
    enforceInflightLimit(backend.state.providerInflight);
    const localProviderKey = providerInflightStateKey(candidate.poolId, providerId);
    backend.state.providerInflight.set(
      localProviderKey,
      readGetProviderInflight(backend, candidate.poolId, providerId) + 1,
    );
  }
  notifyPoolUsage();
  let released = false;
  return {
    poolId: candidate.poolId,
    release: () => {
      if (released) return;
      released = true;
      decrementLocal(backend.state.inflight, candidate.poolId);
      if (providerKey !== undefined) {
        decrementLocal(
          backend.state.providerInflight,
          providerInflightStateKey(candidate.poolId, providerId),
        );
      }
      notifyPoolUsage();
      const script = providerKey === undefined ? POOL_RELEASE_SCRIPT : POOL_PROVIDER_RELEASE_SCRIPT;
      const keys =
        providerKey === undefined
          ? [proxyInflightKey(candidate.poolId)]
          : [proxyInflightKey(candidate.poolId), providerKey];
      void redisEvalNumber(redis, script, keys.length, ...keys).catch((error: unknown) => {
        log.error("[pool-selector] failed to release distributed slot", error as Error);
      });
    },
  };
}

/**
 * Inflight counter from a Redis `MGET` row. `null` (unset counter) is zero;
 * a malformed counter is the same hard error the per-key read raises, so a
 * corrupt key is never silently treated as 0.
 */
export function parsePoolInflightCounter(raw: string | null, what: string): number {
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid pool inflight counter: ${what}`);
  }
  return value;
}

function shuffleArray<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
}

/**
 * Distributed pool admission — the selection algorithm:
 *
 * 1. Eligibility: a pool is skipped while it (or any pool) has an active
 *    provider cooldown (429 from upstream), a non-positive capacity
 *    (`effectiveConcurrency`), or a non-positive weight.
 * 2. Weighted least-loaded scoring: each eligible pool is scored by
 *    `inflight / (capacity × weight)`, so heavy pools carry proportionally
 *    more traffic and a higher `weight` makes a pool proportionally more
 *    attractive. Inflight comes from the local map in single-process mode
 *    or the authoritative Redis counter when coordinated.
 * 3. Fair tie-breaking: a rotating `fairnessCursor` staggers the scan order
 *    so equal-scoring pools are filled round-robin instead of always
 *    favoring the first candidate.
 * 4. Atomic acquisition: with Redis, each candidate is tried in scored
 *    order via the `POOL_ADMIT_SCRIPT` compare-and-increment, so two
 *    processes cannot both grab the last slot. The returned `release()`
 *    decrements both the local map and the Redis counter (fire-and-forget:
 *    a failed release is logged; the 480s TTL bounds crash leakage).
 *
 * Returns `undefined` when every pool is cooling, at capacity, or
 * uncoordinated — callers convert that into a `proxy_pool_unavailable` /
 * `PoolSelectionFailure` response rather than falling back to direct
 * egress.
 *
 * When `rotation` is supplied, scoring is replaced by strict round-robin:
 * the tenant cursor picks the start, one pool serves `rotateCount`
 * successful admissions before the cursor advances by one, and a pool that
 * is full or cooling falls through to the next offset (failover),
 * preserving every gate above.
 */
export async function readTryAcquireAvailablePool(
  backend: PoolSelectionBackend,
  notifyPoolUsage: () => void,
  eligiblePoolIds: readonly string[],
  providerId: string,
  limitsByPool?: Record<string, number>,
  weightsByPool?: Record<string, number>,
  rotation?: PoolRotation,
  /**
   * This provider's per-pool ceiling. `undefined` means unlimited and keeps
   * the original single-counter path exactly: no extra key, no extra call.
   * When set, every candidate must clear it in addition to its pool capacity.
   */
  providerMaxInflight?: number,
): Promise<{ poolId: string; release: () => void } | undefined> {
  if (eligiblePoolIds.length === 0) return undefined;
  const providerCapacity =
    providerMaxInflight === undefined ? undefined : effectiveConcurrency(providerMaxInflight);
  // A ceiling of zero admits nothing; treat it as "no pool is eligible"
  // rather than silently ignoring the operator's choice.
  if (providerCapacity === 0) return undefined;
  const cooldownChecks = await providerCooldownStates(
    backend,
    eligiblePoolIds,
    providerId,
  );
  const scored = cooldownChecks
    .filter((check) => !check.inCooldown)
    .map((check) => {
      const capacity = effectiveConcurrency(
        limitsByPool?.[check.poolId] ?? DEFAULT_PROXY_CONCURRENCY,
      );
      const weight = normalizedWeight(weightsByPool?.[check.poolId]);
      return { poolId: check.poolId, capacity, weight };
    })
    .filter((candidate) => candidate.capacity > 0 && candidate.weight > 0);
  if (scored.length === 0) return undefined;

  if (!backend.redis) {
    if (rotation?.strategy === "random") {
      // Random scatter: shuffle the eligible pools and take the first one
      // with a free slot, falling through like the ordered scans do.
      shuffleArray(scored);
      for (const candidate of scored) {
        if (readGetInflight(backend, candidate.poolId) >= candidate.capacity) continue;
        const slot = localAcquire(backend, notifyPoolUsage, candidate, providerId, providerCapacity);
        if (slot) return slot;
      }
      return undefined;
    }
    if (rotation) {
      // Round robin: scan from the tenant cursor; a pool that is full falls
      // through to the next offset (failover). Only a successful admission
      // counts: the head pool serves `rotateCount` requests, then the
      // position advances by exactly one.
      const start = rotationStart(backend.state.rotationCursors, rotation.key, scored.length);
      for (let offset = 0; offset < scored.length; offset += 1) {
        const absolute = (start + offset) % scored.length;
        const candidate = scored[absolute];
        if (!candidate) continue;
        if (readGetInflight(backend, candidate.poolId) >= candidate.capacity) continue;
        const slot = localAcquire(backend, notifyPoolUsage, candidate, providerId, providerCapacity);
        if (!slot) continue;
        advanceRotation(backend.state.rotationCursors, rotation.key, scored.length, absolute, rotation.rotateCount);
        return slot;
      }
      return undefined;
    }
    let bestPool: (typeof scored)[number] | undefined;
    let minRatio = Number.POSITIVE_INFINITY;
    const start = backend.state.fairnessCursor++ % scored.length;
    for (let offset = 0; offset < scored.length; offset += 1) {
      const candidate = scored[(start + offset) % scored.length];
      if (!candidate) continue;
      const current = readGetInflight(backend, candidate.poolId);
      if (current >= candidate.capacity) continue;
      // A pool this provider has already filled is skipped exactly like a
      // full pool, so the scan fails over to one with headroom instead of
      // stalling on the emptiest pool that cannot serve this provider.
      if (
        providerCapacity !== undefined &&
        readGetProviderInflight(backend, candidate.poolId, providerId) >= providerCapacity
      ) {
        continue;
      }
      const ratio = current / (candidate.capacity * candidate.weight);
      if (ratio < minRatio) {
        minRatio = ratio;
        bestPool = candidate;
      }
    }
    if (!bestPool) return undefined;
    return localAcquire(backend, notifyPoolUsage, bestPool, providerId, providerCapacity);
  }

  const redis = backend.redis;
  // One MGET for every candidate instead of a GET per candidate: the
  // per-pool script below already guarantees capacity atomically, so the
  // pre-read is only a score, but serial GETs made admission latency scale
  // with the candidate count on exactly the path that runs per request.
  const inflightKeys = scored.map((candidate) => proxyInflightKey(candidate.poolId));
  if (providerCapacity !== undefined) {
    for (const candidate of scored) {
      inflightKeys.push(proxyProviderInflightKey(candidate.poolId, providerId));
    }
  }
  const rawCounts = (await redis.mget(...inflightKeys)) as Array<string | null>;
  const withCounts = scored.map((candidate, index) => {
    const raw = rawCounts[index] ?? null;
    const count = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`invalid pool inflight counter: ${candidate.poolId}`);
    }
    // The provider half is read in the same MGET, so scoring a
    // provider-limited pool costs no extra round trip.
    const providerRaw =
      providerCapacity === undefined ? null : (rawCounts[scored.length + index] ?? null);
    const providerCount = providerRaw === null ? 0 : Number(providerRaw);
    if (!Number.isFinite(providerCount) || providerCount < 0) {
      throw new Error(`invalid provider inflight counter: ${candidate.poolId}/${providerId}`);
    }
    return {
      ...candidate,
      count,
      providerCount,
      // A pool with no room for this provider scores as fully loaded, so the
      // least-loaded scan prefers a pool that can actually take the request.
      ratio:
        providerCapacity !== undefined && providerCount >= providerCapacity
          ? Number.POSITIVE_INFINITY
          : count / (candidate.capacity * candidate.weight),
    };
  });
  // Original (pre-sort) index = absolute rotation position and
  // deterministic tie-breaking.
  const absoluteIndex = new Map(withCounts.map((candidate, index) => [candidate.poolId, index]));
  if (rotation?.strategy === "random") {
    // Random scatter: shuffle before the admit loop, which still enforces
    // capacity and fails over to the next pool exactly like the ordered
    // scans — but the order each request tries is fresh, so a burst does
    // not gang up on the first pools in a fixed order.
    shuffleArray(withCounts);
  } else if (rotation) {
    // Round robin orders strictly by the tenant cursor; the CAS admit below
    // still enforces capacity, so a full pool falls through to the next
    // offset exactly like account failover.
    const start = rotationStart(backend.state.rotationCursors, rotation.key, withCounts.length);
    withCounts.sort(
      (left, right) =>
        (((absoluteIndex.get(left.poolId) ?? 0) - start + withCounts.length) %
          withCounts.length) -
        (((absoluteIndex.get(right.poolId) ?? 0) - start + withCounts.length) %
          withCounts.length),
    );
  } else {
    const start = backend.state.fairnessCursor++ % withCounts.length;
    const tieOrder = absoluteIndex;
    withCounts.sort((left, right) => {
      const ratioDifference = left.ratio - right.ratio;
      if (ratioDifference !== 0) return ratioDifference;
      const leftIndex = tieOrder.get(left.poolId) ?? 0;
      const rightIndex = tieOrder.get(right.poolId) ?? 0;
      return ((leftIndex - start + withCounts.length) % withCounts.length) -
        ((rightIndex - start + withCounts.length) % withCounts.length);
    });
  }
  for (const candidate of withCounts) {
    const admitted = await redisAdmit(backend, notifyPoolUsage, redis, candidate, providerId, providerCapacity);
    if (admitted === undefined) continue;
    if (rotation && rotation.strategy !== "random") {
      advanceRotation(
        backend.state.rotationCursors,
        rotation.key,
        withCounts.length,
        absoluteIndex.get(candidate.poolId) ?? 0,
        rotation.rotateCount,
      );
    }
    return admitted;
  }
  return undefined;
}
