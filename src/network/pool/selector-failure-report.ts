/**
 * Batched selector reads behind `NetworkPoolSelector`: the admission
 * cooldown pre-check (`providerCooldownStates`), the selection-failure
 * report (`getSelectionFailure`), and the pool-list snapshot
 * (`getPoolListSnapshot`).
 *
 * These are the selector's read/reporting side: they never write a marker
 * or a counter, they only read cooldown/inflight state (through
 * `PoolCooldownBackend`, supplied by the class in `selector.ts`) and shape
 * it for admission, the console, and dispatch. Cooldown/block-marker
 * accounting itself lives in `selector-cooldowns.ts`.
 */
import {
  proxyCooldownKey,
  proxyCooldownProvidersKey,
  proxyInflightKey,
  proxyProviderInflightKey,
} from "./scripts";
import {
  enforceCooldownLimit,
  parseCooldownEntry,
  type ProxyCooldownEntry,
} from "./state";
import {
  effectiveConcurrency,
  normalizedWeight,
  poolCooldownKey,
} from "./selector-shared";
import { parsePoolInflightCounter } from "./selector-inflight";
import { type PoolCooldownBackend, type PoolCooldownState, readIsProviderCooldown } from "./selector-cooldowns";

type PoolSelectionFailureReason =
  | "at_capacity"
  | "provider_at_capacity"
  | "cooldown"
  /** Every eligible pool was retired by the upstream for this provider. */
  | "blocked"
  | "coordination_unavailable"
  | "no_active_pool";

interface PoolCapacitySnapshot {
  readonly poolId: string;
  readonly maxInflight: number;
  readonly currentInflight: number;
  readonly available: number;
  readonly weight: number;
  readonly retryAt?: number;
  /** This provider's ceiling on this pool, when one is configured. */
  readonly providerMaxInflight?: number;
  /** This provider's current share of this pool, when a ceiling is configured. */
  readonly providerInflight?: number;
  /** True when the upstream refused this egress for this provider outright,
   * as opposed to throttling it for a window. */
  readonly blocked?: boolean;
}

export interface PoolSelectionFailure {
  readonly reason: PoolSelectionFailureReason;
  readonly pools: readonly PoolCapacitySnapshot[];
  readonly retryAt?: number;
}

/**
 * Per-pool cooldown resolution with the same semantics as
 * `isProviderCooldown`: the local cooldown map wins when it has a live
 * entry; otherwise a non-expired Redis row is admitted (bounded) and an
 * expired Redis row is cleared. Used by the batched reads — admission's
 * cooldown pre-check and the failure report — which read all cooldown keys
 * in one `MGET` and resolve each row here.
 */
function cooldownFromBatchState(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
  raw: string | null,
): PoolCooldownState {
  const k = poolCooldownKey(poolId, providerId);
  const local = backend.state.cooldowns.get(k);
  if (local) {
    if (Date.now() < local.until) {
      return {
        inCooldown: true,
        resetsAt: new Date(local.until),
        reason: local.reason,
        blocked: local.blocked === true,
      };
    }
    backend.state.cooldowns.delete(k);
  }
  const parsed = raw ? parseCooldownEntry(raw) : undefined;
  if (parsed && Date.now() < parsed.until) {
    enforceCooldownLimit(backend.state.cooldowns);
    backend.state.cooldowns.set(k, parsed);
    return {
      inCooldown: true,
      resetsAt: new Date(parsed.until),
      reason: parsed.reason,
      blocked: parsed.blocked === true,
    };
  }
  if (raw) {
    void backend.clearRedisCooldown(poolId, providerId);
  }
  return { inCooldown: false, resetsAt: null, reason: null, blocked: false };
}

/**
 * The one capacity-snapshot shape shared by the per-pool and batched
 * selection checks. Both paths read the same facts (cooldown, limits,
 * inflight, weights) and must report them identically — the failure
 * report's pools array is what the console renders and what dispatch
 * decides on — so the literal lives here, not in each reader.
 */
function capacitySnapshot(
  poolId: string,
  cooldown: PoolCooldownState,
  maxInflight: number,
  currentInflight: number,
  weight: number,
  providerCapacity: number | undefined,
  providerInflight: number | undefined,
): PoolCapacitySnapshot {
  return {
    poolId,
    maxInflight,
    currentInflight,
    available: Math.max(0, maxInflight - currentInflight),
    weight,
    ...(cooldown.resetsAt ? { retryAt: cooldown.resetsAt.getTime() } : {}),
    ...(cooldown.blocked ? { blocked: true } : {}),
    ...(providerCapacity === undefined
      ? {}
      : { providerMaxInflight: providerCapacity, providerInflight: providerInflight ?? 0 }),
  };
}

/**
 * Cooldown state for every eligible pool in admission order.
 *
 * With Redis this is one `MGET` over the cooldown keys — one round trip per
 * admission instead of one `GET` per pool — resolved through the same
 * `cooldownFromBatchState` path `batchSelectionChecks` uses. A failed batch
 * read falls back to per-pool `isProviderCooldown` calls, which keeps the
 * "cooldown store unavailable" per-pool detail and costs no more than the
 * serial path this replaced. Without Redis the rows resolve from the local
 * cooldown map alone (`raw` is always null).
 */
export async function providerCooldownStates(
  backend: PoolCooldownBackend,
  eligiblePoolIds: readonly string[],
  providerId: string,
): Promise<Array<{ poolId: string; inCooldown: boolean }>> {
  const redis = backend.redis;
  if (!redis) {
    return eligiblePoolIds.map((poolId) => ({
      poolId,
      inCooldown: cooldownFromBatchState(backend, poolId, providerId, null).inCooldown,
    }));
  }
  let raws: Array<string | null>;
  try {
    raws = (await redis.mget(
      ...eligiblePoolIds.map((poolId) => proxyCooldownKey(poolId, providerId)),
    )) as Array<string | null>;
  } catch {
    return Promise.all(
      eligiblePoolIds.map(async (poolId) => ({
        poolId,
        inCooldown: (await readIsProviderCooldown(backend, poolId, providerId)).inCooldown,
      })),
    );
  }
  return eligiblePoolIds.map((poolId, index) => ({
    poolId,
    inCooldown: cooldownFromBatchState(backend, poolId, providerId, raws[index] ?? null).inCooldown,
  }));
}

/**
 * The original per-pool failure check: one Redis read per pool for each of
 * cooldown, pool inflight, and provider inflight. Retained as the fallback
 * for the non-Redis path and for a Redis outage during the batched read.
 */
async function perPoolSelectionChecks(
  backend: PoolCooldownBackend,
  eligiblePoolIds: readonly string[],
  providerId: string,
  limitsByPool?: Record<string, number>,
  weightsByPool?: Record<string, number>,
  providerCapacity?: number,
): Promise<Array<{ cooldown: PoolCooldownState; pool: PoolCapacitySnapshot }>> {
  return Promise.all(
    eligiblePoolIds.map(async (poolId) => {
      const cooldown = await readIsProviderCooldown(backend, poolId, providerId);
      const maxInflight = effectiveConcurrency(
        limitsByPool?.[poolId] ?? 10,
      );
      const weight = normalizedWeight(weightsByPool?.[poolId]);
      const currentInflight = await backend.getInflightAuthoritative(poolId);
      const providerInflight =
        providerCapacity === undefined
          ? undefined
          : await backend.getProviderInflightAuthoritative(poolId, providerId);
      return {
        cooldown,
        pool: capacitySnapshot(
          poolId,
          cooldown,
          maxInflight,
          currentInflight,
          weight,
          providerCapacity,
          providerInflight,
        ),
      };
    }),
  );
}

/**
 * Batched failure check: one `MGET` per key family (cooldowns, pool
 * inflight, provider inflight) instead of three serial GETs per pool. On a
 * Redis error the whole read falls back to per-pool reads so the failure
 * report keeps the "cooldown store unavailable" per-pool detail.
 */
async function batchSelectionChecks(
  backend: PoolCooldownBackend,
  eligiblePoolIds: readonly string[],
  providerId: string,
  limitsByPool?: Record<string, number>,
  weightsByPool?: Record<string, number>,
  providerCapacity?: number,
): Promise<Array<{ cooldown: PoolCooldownState; pool: PoolCapacitySnapshot }>> {
  const redis = backend.redis!;
  const cooldownKeys = eligiblePoolIds.map((poolId) => proxyCooldownKey(poolId, providerId));
  const inflightKeys = eligiblePoolIds.map((poolId) => proxyInflightKey(poolId));
  const providerInflightKeys =
    providerCapacity === undefined
      ? []
      : eligiblePoolIds.map((poolId) => proxyProviderInflightKey(poolId, providerId));
  try {
    const [cooldownRaws, inflightRaws, providerRaws] = await Promise.all([
      redis.mget(...cooldownKeys),
      redis.mget(...inflightKeys),
      providerInflightKeys.length === 0
        ? Promise.resolve([] as Array<string | null>)
        : redis.mget(...providerInflightKeys),
    ]);
    return eligiblePoolIds.map((poolId, index) => {
      const cooldown = cooldownFromBatchState(backend, poolId, providerId, cooldownRaws[index] ?? null);
      const maxInflight = effectiveConcurrency(
        limitsByPool?.[poolId] ?? 10,
      );
      const weight = normalizedWeight(weightsByPool?.[poolId]);
      const currentInflight = parsePoolInflightCounter(inflightRaws[index] ?? null, poolId);
      const providerInflight =
        providerCapacity === undefined
          ? undefined
          : parsePoolInflightCounter(providerRaws[index] ?? null, `${poolId}/${providerId}`);
      return {
        cooldown,
        pool: capacitySnapshot(
          poolId,
          cooldown,
          maxInflight,
          currentInflight,
          weight,
          providerCapacity,
          providerInflight,
        ),
      };
    });
  } catch {
    return perPoolSelectionChecks(
      backend,
      eligiblePoolIds,
      providerId,
      limitsByPool,
      weightsByPool,
      providerCapacity,
    );
  }
}

export async function readGetSelectionFailure(
  backend: PoolCooldownBackend,
  eligiblePoolIds: readonly string[],
  providerId: string,
  limitsByPool?: Record<string, number>,
  weightsByPool?: Record<string, number>,
  providerMaxInflight?: number,
): Promise<PoolSelectionFailure> {
  if (eligiblePoolIds.length === 0) return { reason: "no_active_pool", pools: [] };
  const providerCapacity =
    providerMaxInflight === undefined ? undefined : effectiveConcurrency(providerMaxInflight);
  try {
    // One batch pass instead of per-pool Redis reads: cooldowns and inflight
    // counters are read in one `MGET` per key family (three total), not
    // three serial GETs per pool. The per-pool resolution below consumes the
    // raw rows with the same semantics `isProviderCooldown` /
    // `getInflightAuthoritative` / `getProviderInflightAuthoritative` apply.
    const checks =
      backend.redis === undefined
        ? await perPoolSelectionChecks(backend, eligiblePoolIds, providerId, limitsByPool, weightsByPool, providerCapacity)
        : await batchSelectionChecks(backend, eligiblePoolIds, providerId, limitsByPool, weightsByPool, providerCapacity);
    const pools = checks.map((check) => check.pool);
    const cooldowns = checks.map((check) => check.cooldown);
    if (cooldowns.some((entry) => entry.reason === "cooldown store unavailable")) {
      return { reason: "coordination_unavailable", pools };
    }
    const active = pools.filter((pool) => pool.maxInflight > 0 && pool.weight > 0);
    if (active.length === 0) return { reason: "no_active_pool", pools };
    const allCooling = cooldowns.every((entry) => entry.inCooldown);
    if (allCooling) {
      // A retired egress is not a cooldown: nothing clears it on a timer, so
      // telling the operator to "retry once the cooldown resets" would be a
      // lie they could wait on indefinitely. Report the stronger fact.
      if (cooldowns.every((entry) => entry.blocked)) {
        return { reason: "blocked", pools };
      }
      const retryAt = Math.min(
        ...cooldowns
          .map((entry) => entry.resetsAt?.getTime())
          .filter((value): value is number => value !== undefined),
      );
      return {
        reason: "cooldown",
        pools,
        ...(Number.isFinite(retryAt) ? { retryAt } : {}),
      };
    }
    // Distinguish "every pool is full" from "every pool has room, but not
    // for this provider" — the operator's fix differs (add capacity vs.
    // raise this provider's share).
    if (
      providerCapacity !== undefined &&
      active.every((pool) => (pool.providerInflight ?? 0) >= providerCapacity)
    ) {
      return { reason: "provider_at_capacity", pools };
    }
    return { reason: "at_capacity", pools };
  } catch {
    return { reason: "coordination_unavailable", pools: [] };
  }
}

/**
 * Inflight + active cooldowns for every named pool, batched.
 *
 * The pool list used to issue two Redis round trips per pool — one
 * `GET`/`MGET` for the inflight counter and one `SMEMBERS`+`MGET` for the
 * cooldown index — so a tenant with dozens of pools paid that fan-out on
 * every dashboard load. This reads the same data in a constant number of
 * round trips: one local cooldown scan, one `SMEMBERS` per pool (the index
 * is per-pool by design), one `MGET` for every cooldown marker, and one
 * `MGET` for every inflight counter.
 *
 * Semantics match the per-pool reads: the local cooldown map wins, a
 * non-expired Redis marker counts, and expired markers are cleaned from the
 * index exactly like `getPoolCooldowns`. A failed Redis read degrades to the
 * local state rather than failing the list — the same posture the console
 * enrichment already takes when the selector is absent.
 */
export async function readGetPoolListSnapshot(
  backend: PoolCooldownBackend,
  poolIds: readonly string[],
): Promise<ReadonlyMap<string, { inflight: number; cooldowns: readonly ProxyCooldownEntry[] }>> {
  const out = new Map<string, { inflight: number; cooldowns: readonly ProxyCooldownEntry[] }>();
  if (poolIds.length === 0) return out;

  // One pass over the local cooldown map seeds every pool's local entries;
  // expired local rows are dropped on sight, matching `getPoolCooldowns`.
  const now = Date.now();
  const localByPool = new Map<string, Map<string, ProxyCooldownEntry>>();
  for (const poolId of poolIds) localByPool.set(poolId, new Map());
  for (const [key, entry] of backend.state.cooldowns.entries()) {
    if (now >= entry.until) {
      backend.state.cooldowns.delete(key);
      continue;
    }
    const bucket = localByPool.get(entry.poolId);
    if (bucket !== undefined) bucket.set(entry.providerId, entry);
  }

  const redis = backend.redis;
  if (!redis) {
    for (const poolId of poolIds) {
      out.set(poolId, { inflight: backend.getInflight(poolId), cooldowns: [...(localByPool.get(poolId)?.values() ?? [])] });
    }
    return out;
  }

  // The index sets are per-pool; fetch them concurrently, then read every
  // marker in one MGET keyed by (poolId, providerId) order.
  const providerIdsByPool = await Promise.all(
    poolIds.map((poolId) => redis.smembers(proxyCooldownProvidersKey(poolId)).catch(() => [] as string[])),
  );
  const markerKeys: string[] = [];
  const markerOwner: Array<{ poolId: string; providerId: string }> = [];
  for (let i = 0; i < poolIds.length; i += 1) {
    const poolId = poolIds[i]!;
    const seen = new Set<string>();
    for (const providerId of providerIdsByPool[i] ?? []) {
      if (seen.has(providerId)) continue;
      seen.add(providerId);
      markerKeys.push(proxyCooldownKey(poolId, providerId));
      markerOwner.push({ poolId, providerId });
    }
  }
  // `undefined` (not `[]`) on a failed read: an unknown marker set must not
  // be mistaken for "every marker is gone", which would SREM live cooldowns
  // out of the index. `null` entries mean "key absent", which is safe to
  // clean up.
  const [markerRaws, inflightRaws] = await Promise.all([
    markerKeys.length === 0
      ? Promise.resolve([] as Array<string | null>)
      : redis.mget(...markerKeys).catch(() => undefined),
    redis
      .mget(...poolIds.map((poolId) => proxyInflightKey(poolId)))
      .catch(() => undefined),
  ]);
  const markersKnown = markerRaws !== undefined;
  const inflightKnown = inflightRaws !== undefined;

  // Resolve markers per pool. Expired or unparseable markers leave the active
  // set and are collected for the same batched index cleanup
  // `getPoolCooldowns` performs.
  const cooldownsByPool = new Map<string, ProxyCooldownEntry[]>();
  const staleMarkerKeys: string[] = [];
  const staleSrem: Array<{ poolId: string; providerId: string }> = [];
  for (let index = 0; index < markerOwner.length; index += 1) {
    const owner = markerOwner[index]!;
    const raw = markersKnown ? (markerRaws[index] ?? null) : null;
    const entry = raw ? parseCooldownEntry(raw) : undefined;
    const local = localByPool.get(owner.poolId);
    // The local map already contributed this provider's entry when it had a
    // live one; a Redis row for the same provider only fills the gap.
    if (local?.has(owner.providerId)) continue;
    if (entry && entry.poolId === owner.poolId && now < entry.until) {
      let bucket = cooldownsByPool.get(owner.poolId);
      if (bucket === undefined) {
        bucket = [];
        cooldownsByPool.set(owner.poolId, bucket);
      }
      bucket.push(entry);
      continue;
    }
    // Only a known-absent or expired marker is stale; an unknown read
    // (`markersKnown === false`) leaves the index untouched.
    if (markersKnown) {
      if (raw) staleMarkerKeys.push(proxyCooldownKey(owner.poolId, owner.providerId));
      staleSrem.push(owner);
    }
  }
  if (staleMarkerKeys.length > 0 || staleSrem.length > 0) {
    void Promise.all([
      ...(staleMarkerKeys.length > 0 ? [redis.del(...staleMarkerKeys)] : []),
      ...staleSrem.map((owner) => redis.srem(proxyCooldownProvidersKey(owner.poolId), owner.providerId)),
    ]).catch(() => undefined);
  }

  for (let i = 0; i < poolIds.length; i += 1) {
    const poolId = poolIds[i]!;
    let inflight = backend.getInflight(poolId);
    if (inflightKnown) {
      try {
        inflight = parsePoolInflightCounter(inflightRaws[i] ?? null, poolId);
      } catch {
        // A corrupt counter is the same hard error the single-pool read
        // raises; for a list read the local count is the honest fallback.
      }
    }
    const merged = new Map<string, ProxyCooldownEntry>();
    for (const entry of localByPool.get(poolId)?.values() ?? []) merged.set(entry.providerId, entry);
    for (const entry of cooldownsByPool.get(poolId) ?? []) merged.set(entry.providerId, entry);
    out.set(poolId, { inflight, cooldowns: [...merged.values()] });
  }
  return out;
}
