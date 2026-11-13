/**
 * Cooldown accounting behind `NetworkPoolSelector`: per-provider cooldown
 * markers (local map + Redis index), provider block flags, and the batched
 * failure-report reads (`getSelectionFailure`, `getPoolListSnapshot`).
 *
 * `PoolCooldownBackend` is the slice of the selector these functions need —
 * the class in `selector.ts` supplies it, so the state maps, the Redis
 * client, and the marker-clear write stay encapsulated.
 */
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { providerRateLimitIsIpScoped } from "../../providers/provider-metadata";
import { log } from "../../observability/logger";
import {
  COOLDOWN_CLEAR_SCRIPT,
  COOLDOWN_FLAG_SCRIPT,
  proxyCooldownKey,
  proxyCooldownProvidersKey,
  proxyInflightKey,
  proxyProviderInflightKey,
} from "./scripts";
import {
  enforceCooldownLimit,
  parseCooldownEntry,
  type PoolLocalState,
  type ProxyCooldownEntry,
} from "./state";
import {
  effectiveConcurrency,
  normalizedWeight,
  poolCooldownKey,
} from "./selector-shared";
import { parsePoolInflightCounter } from "./selector-inflight";

/**
 * How long a flagged egress stays out of rotation.
 *
 * This is not a cooldown: a free-tier refusal means the upstream has retired
 * the address, and the only thing that clears it is the operator replacing the
 * proxy. Ten years is "until someone intervenes" — long enough that no request
 * spends itself rediscovering the refusal, short enough to stay a bounded
 * timestamp instead of a nullable flag every reader would have to branch on.
 */
export const PROVIDER_BLOCK_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface PoolCooldownState {
  readonly inCooldown: boolean;
  readonly resetsAt: Date | null;
  readonly reason: string | null;
  readonly blocked: boolean;
}

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

/** The selector surface cooldown accounting and failure reporting read. */
export interface PoolCooldownBackend {
  readonly state: PoolLocalState;
  readonly redis: RedisClient | undefined;
  getInflight(poolId: string): number;
  getInflightAuthoritative(poolId: string): Promise<number>;
  getProviderInflightAuthoritative(poolId: string, providerId: string): Promise<number>;
  getPoolCooldowns(poolId: string): Promise<readonly ProxyCooldownEntry[]>;
  clearRedisCooldown(poolId: string, providerId: string): Promise<void>;
}

/**
 * Removes one cooldown marker and its index entry in one atomic step.
 *
 * The two writes must not be separate `DEL` + `SREM`: a crash between them
 * would leave the index listing a provider whose marker is gone — a pool
 * would report a cooldown that no longer applies until the index entry
 * expires.
 */
export async function readClearRedisCooldown(
  redis: RedisClient | undefined,
  poolId: string,
  providerId: string,
): Promise<void> {
  if (!redis) return;
  await redisEvalNumber(
    redis,
    COOLDOWN_CLEAR_SCRIPT,
    2,
    proxyCooldownKey(poolId, providerId),
    proxyCooldownProvidersKey(poolId),
    providerId.toLowerCase(),
  );
}

/**
 * Whether this pool is out of rotation for this provider, and why.
 *
 * `blocked` separates the two facts the caller must not conflate: a 429 is a
 * window that ends, while a free-tier refusal retires the address for good.
 * The rejection message says which one the operator is looking at, because
 * the fix differs — wait, or replace the proxy.
 */
export async function readIsProviderCooldown(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
): Promise<PoolCooldownState> {
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
  const redis = backend.redis;
  if (redis) {
    try {
      const raw = await redis.get(proxyCooldownKey(poolId, providerId));
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
        await backend.clearRedisCooldown(poolId, providerId);
      }
    } catch {
      return {
        inCooldown: true,
        resetsAt: null,
        reason: "cooldown store unavailable",
        blocked: false,
      };
    }
  }
  return { inCooldown: false, resetsAt: null, reason: null, blocked: false };
}

export async function readGetPoolCooldowns(
  backend: PoolCooldownBackend,
  poolId: string,
): Promise<readonly ProxyCooldownEntry[]> {
  const now = Date.now();
  const active = new Map<string, ProxyCooldownEntry>();

  for (const [key, entry] of backend.state.cooldowns.entries()) {
    if (entry.poolId !== poolId) continue;
    if (now < entry.until) active.set(entry.providerId, entry);
    else backend.state.cooldowns.delete(key);
  }

  const redis = backend.redis;
  if (redis) {
    const providerIds = await redis.smembers(proxyCooldownProvidersKey(poolId));
    // A pool with no cooling providers — the common case, and every pool when
    // nothing is throttled — lists no members. `MGET` requires at least one
    // key, so calling it with an empty spread makes Redis reject the command
    // and the whole pool read fail; a healthy pool must report zero cooldowns,
    // not an error. The loop below is a no-op for an empty list, so returning
    // early is the same result without the round trip.
    if (providerIds.length === 0) return [...active.values()];
    // One MGET for every listed member instead of a GET per member: this is
    // the pool overview's hot read, so a serial scan made its latency scale
    // with the pool's provider count.
    const raws = (await redis.mget(
      ...providerIds.map((providerId) => proxyCooldownKey(poolId, providerId)),
    )) as Array<string | null>;
    const staleMarkerKeys: string[] = [];
    const staleMembers: string[] = [];
    for (let index = 0; index < providerIds.length; index += 1) {
      const providerId = providerIds[index];
      if (providerId === undefined) continue;
      const raw = raws[index] ?? null;
      const entry = raw ? parseCooldownEntry(raw) : undefined;
      if (!entry) {
        if (raw) staleMarkerKeys.push(proxyCooldownKey(poolId, providerId));
        staleMembers.push(providerId);
        continue;
      }
      if (entry.poolId === poolId && now < entry.until) active.set(entry.providerId, entry);
      else staleMembers.push(providerId);
    }
    // One batched cleanup instead of serial del/srem per stale member.
    await Promise.all([
      ...(staleMarkerKeys.length > 0 ? [redis.del(...staleMarkerKeys)] : []),
      ...(staleMembers.length > 0
        ? staleMembers.map((member) => redis!.srem(proxyCooldownProvidersKey(poolId), member))
        : []),
    ]);
  }

  return [...active.values()];
}

export async function readClearProviderCooldown(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
): Promise<void> {
  backend.state.cooldowns.delete(poolCooldownKey(poolId, providerId));
  if (!backend.redis) return;
  await backend.clearRedisCooldown(poolId, providerId);
}

/**
 * Releases a *retired* egress only, leaving a cooldown intact.
 *
 * The two are one key, so `clearProviderCooldown` cannot be reused: it would
 * also drop a live 429 cooldown and hand a spent address back to dispatch.
 * This is the correction a 429 probe is entitled to make — the address is
 * answering its own rate limiter, so it was never retired — and nothing more.
 *
 * No-op when the marker is a cooldown, and no-op when there is no marker.
 */
export async function readClearProviderBlockedOnly(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
): Promise<void> {
  const key = poolCooldownKey(poolId, providerId);
  const local = backend.state.cooldowns.get(key);
  if (local !== undefined) {
    if (local.blocked !== true) return;
    backend.state.cooldowns.delete(key);
  }
  const redis = backend.redis;
  if (!redis) return;
  try {
    const raw = await redis.get(proxyCooldownKey(poolId, providerId));
    const entry = raw ? parseCooldownEntry(raw) : undefined;
    // A missing or unparseable marker says nothing about the address, and
    // deleting a key we cannot read would drop a cooldown this is forbidden
    // from touching. Only a marker that names itself a block is released.
    if (entry?.blocked !== true) return;
    await backend.clearRedisCooldown(poolId, providerId);
  } catch {
    // The local copy is already corrected; the Redis mirror stays until its
    // TTL or the next write.
  }
}

/**
 * Drops every cooldown this pool holds, marker and index together.
 *
 * Called when a pool is deleted: without it the index set and its markers
 * outlive the pool row, so a later pool reusing the id inherits cooldowns it
 * never earned.
 */
export async function readClearPoolCooldowns(
  backend: PoolCooldownBackend,
  poolId: string,
): Promise<void> {
  for (const key of [...backend.state.cooldowns.keys()]) {
    if (key.startsWith(`${poolId}::`)) backend.state.cooldowns.delete(key);
  }
  const redis = backend.redis;
  if (!redis) return;
  const indexKey = proxyCooldownProvidersKey(poolId);
  const providerIds = await redis.smembers(indexKey);
  for (const providerId of providerIds) {
    await redis.del(proxyCooldownKey(poolId, providerId));
  }
  await redis.del(indexKey);
}

/**
 * Seeds one cooldown entry into the local map without touching Redis.
 *
 * Boot restore is the only writer: it replays the durable markers the
 * previous process recorded (`network_pools.provider_cooldowns`, see
 * `pool-cooldown-store.ts`) so dispatch starts remembering the egresses the
 * upstream is still refusing. Anything whose window already passed is
 * dropped by `restore…` before this is reached.
 */
export function readHydrateProviderCooldown(
  backend: PoolCooldownBackend,
  entry: ProxyCooldownEntry,
): void {
  enforceCooldownLimit(backend.state.cooldowns);
  backend.state.cooldowns.set(poolCooldownKey(entry.poolId, entry.providerId), entry);
}

export async function readFlagProviderCooldown(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
  durationMs: number = 15 * 60 * 1000,
  reason = "Rate limited by upstream provider (429)",
): Promise<ProxyCooldownEntry> {
  const until = Date.now() + durationMs;
  const entry: ProxyCooldownEntry = {
    poolId,
    providerId: providerId.toLowerCase(),
    until,
    reason: reason.slice(0, 200),
  };
  enforceCooldownLimit(backend.state.cooldowns);
  backend.state.cooldowns.set(poolCooldownKey(poolId, providerId), entry);
  const redis = backend.redis;
  if (redis) {
    try {
      const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));
      // One script, not `SET` then `SADD`: a crash between the two left the
      // marker unindexed (invisible to the pool listing) or the index
      // pointing at a marker that expired. The script also arms the index
      // set's own TTL, which must be armed or the index grows without bound.
      await redisEvalNumber(
        redis,
        COOLDOWN_FLAG_SCRIPT,
        2,
        proxyCooldownKey(poolId, providerId),
        proxyCooldownProvidersKey(poolId),
        JSON.stringify(entry),
        ttlSec,
        entry.providerId,
      );
    } catch {
      // The local entry remains conservative for this process.
    }
  }
  return entry;
}

/**
 * Retires an egress permanently for one provider.
 *
 * A free-tier refusal means the upstream flagged this address, and the
 * request was never read — so the address stays flagged for as long as the
 * upstream remembers it. A timed cooldown would put it back into rotation and
 * spend a real request discovering it is still refused, which is why this is
 * a far-future `until` rather than a short window.
 *
 * The entry uses the same storage as a cooldown so every reader that already
 * skips a cooling pool skips this one too; `reason` is what the console
 * renders to tell an operator-blocked proxy from a throttled one.
 *
 * Refuses to retire an egress for a provider whose limits belong to a
 * credential. An address-scoped verdict only exists for providers that count
 * requests by egress (`ipScopedRateLimit` — opencode); for everyone else a
 * refusal belongs to the account that was dialed, so retiring the pool would
 * sideline an address that is still serving every sibling account. Callers
 * keep their own guard, and this one is the backstop that makes the rule
 * impossible to route around from a new call site.
 */
export async function readFlagProviderBlocked(
  backend: PoolCooldownBackend,
  poolId: string,
  providerId: string,
  reason = "Upstream refused this egress address",
): Promise<ProxyCooldownEntry> {
  if (!providerRateLimitIsIpScoped(providerId)) {
    log.warn("[pool-selector] refused to block an egress for a non-IP-scoped provider", {
      networkPoolId: poolId,
      providerId,
    });
    return {
      poolId,
      providerId: providerId.toLowerCase(),
      until: Date.now(),
      reason,
    };
  }
  const entry = await readFlagProviderCooldown(backend, poolId, providerId, PROVIDER_BLOCK_MS, reason);
  const blocked: ProxyCooldownEntry = { ...entry, blocked: true };
  // Rewrite both copies with the flag: the cooldown write above is shared
  // with the 429 path, so the marker has to be re-stamped rather than
  // threaded through a second parameter that only this caller sets.
  backend.state.cooldowns.set(poolCooldownKey(poolId, providerId), blocked);
  const redis = backend.redis;
  if (redis) {
    try {
      await redisEvalNumber(
        redis,
        COOLDOWN_FLAG_SCRIPT,
        2,
        proxyCooldownKey(poolId, providerId),
        proxyCooldownProvidersKey(poolId),
        JSON.stringify(blocked),
        Math.max(1, Math.ceil(PROVIDER_BLOCK_MS / 1000)),
        blocked.providerId,
      );
    } catch {
      // The local entry stays authoritative for this process.
    }
  }
  return blocked;
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
        pool: {
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
        } satisfies PoolCapacitySnapshot,
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
        pool: {
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
        } satisfies PoolCapacitySnapshot,
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
