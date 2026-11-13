/**
 * Cooldown accounting behind `NetworkPoolSelector`: per-provider cooldown
 * markers (local map + Redis index) and provider block flags. The batched
 * reads that consume this state — the selection-failure report and the
 * pool-list snapshot — live in `selector-failure-report.ts`.
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
} from "./scripts";
import {
  enforceCooldownLimit,
  parseCooldownEntry,
  type PoolLocalState,
  type ProxyCooldownEntry,
} from "./state";
import { poolCooldownKey } from "./selector-shared";

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
