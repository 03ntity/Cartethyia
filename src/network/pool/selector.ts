/**
 * `NetworkPoolSelector` — distributed pool admission: weighted, cooldown-aware
 * selection plus inflight accounting (local map + Redis counters for
 * multi-process correctness).
 *
 * This file keeps the `NetworkPoolSelector` public surface; the work lives in
 * sibling modules:
 * - `selector-shared.ts` — constants, key helpers, capacity/weight derivation.
 * - `selector-inflight.ts` — local/Redis inflight counters and the selection
 *   scan (`tryAcquireAvailablePool`).
 * - `selector-cooldowns.ts` — provider cooldown/block markers and the batched
 *   failure-report reads (`getSelectionFailure`, `getPoolListSnapshot`).
 * - `scripts.ts` — Redis scripts + key builders.
 * - `state.ts` — local inflight/rotation/cooldown state.
 */
import { createPoolLocalState, type PoolLocalState, type PoolRotation, type PoolUsageSnapshot, type ProxyCooldownEntry } from "./state";
import type { RedisClient } from "../../persistence/redis";
import {
  readAcquire,
  readAcquireProvider,
  readGetInflight,
  readGetInflightAuthoritative,
  readGetProviderInflight,
  readGetProviderInflightAuthoritative,
  readSnapshotPoolUsage,
  readTryAcquireAvailablePool,
  type PoolSelectionBackend,
} from "./selector-inflight";
import {
  PROVIDER_BLOCK_MS,
  readClearPoolCooldowns,
  readClearProviderBlockedOnly,
  readClearProviderCooldown,
  readClearRedisCooldown,
  readFlagProviderBlocked,
  readFlagProviderCooldown,
  readGetPoolCooldowns,
  readGetPoolListSnapshot,
  readGetSelectionFailure,
  readHydrateProviderCooldown,
  readIsProviderCooldown,
  type PoolCooldownState,
  type PoolSelectionFailure,
} from "./selector-cooldowns";

export { PROVIDER_BLOCK_MS };
export type { PoolRotation, ProxyCooldownEntry, PoolSelectionFailure };

export class NetworkPoolSelector implements PoolSelectionBackend {
  /** Local inflight/rotation/cooldown state — read by the extracted modules. */
  readonly state: PoolLocalState = createPoolLocalState();

  readonly redis: RedisClient | undefined;

  constructor(redis?: RedisClient) {
    this.redis = redis;
  }

  getInflight(poolId: string): number {
    return readGetInflight(this, poolId);
  }

  /**
   * Push-on-change subscription for pool usage, mirroring the in-flight
   * request counter's pub/sub. Emitted on every acquire/release so an SSE
   * stream can forward only real transitions instead of polling.
   */
  private readonly poolUsageListeners = new Set<(usage: readonly PoolUsageSnapshot[]) => void>();

  subscribePoolUsage(listener: (usage: readonly PoolUsageSnapshot[]) => void): () => void {
    this.poolUsageListeners.add(listener);
    return () => {
      this.poolUsageListeners.delete(listener);
    };
  }

  private notifyPoolUsage(): void {
    if (this.poolUsageListeners.size === 0) return;
    const snapshot = readSnapshotPoolUsage(this);
    for (const listener of this.poolUsageListeners) listener(snapshot);
  }

  snapshotPoolUsage(): readonly PoolUsageSnapshot[] {
    return readSnapshotPoolUsage(this);
  }

  async getInflightAuthoritative(poolId: string): Promise<number> {
    return readGetInflightAuthoritative(this, poolId);
  }

  /**
   * This provider's inflight share of one pool. Zero when the provider has no
   * ceiling configured, because nothing ever records a count for it.
   */
  getProviderInflight(poolId: string, providerId: string): number {
    return readGetProviderInflight(this, poolId, providerId);
  }

  async getProviderInflightAuthoritative(poolId: string, providerId: string): Promise<number> {
    return readGetProviderInflightAuthoritative(this, poolId, providerId);
  }

  async getPoolListSnapshot(
    poolIds: readonly string[],
  ): Promise<ReadonlyMap<string, { inflight: number; cooldowns: readonly ProxyCooldownEntry[] }>> {
    return readGetPoolListSnapshot(this, poolIds);
  }

  /**
   * Raises this provider's share of a pool, enforcing both the pool ceiling
   * and the provider ceiling — see `selector-inflight.ts` for the semantics.
   */
  acquireProvider(
    poolId: string,
    providerId: string,
    poolCapacity: number,
    providerCapacity: number,
  ): { acquired: boolean; release: () => void } {
    return readAcquireProvider(this, this.notifyPoolUsage.bind(this), poolId, providerId, poolCapacity, providerCapacity);
  }

  acquire(
    poolId: string,
    maxInflight?: number,
  ): { acquired: boolean; release: () => void } {
    return readAcquire(this, this.notifyPoolUsage.bind(this), poolId, maxInflight);
  }

  /**
   * Seeds one cooldown entry into the local map without touching Redis —
   * see `selector-cooldowns.ts` for the boot-restore contract.
   */
  hydrateProviderCooldown(entry: ProxyCooldownEntry): void {
    readHydrateProviderCooldown(this, entry);
  }

  async flagProviderCooldown(
    poolId: string,
    providerId: string,
    durationMs?: number,
    reason?: string,
  ): Promise<ProxyCooldownEntry> {
    return readFlagProviderCooldown(this, poolId, providerId, durationMs, reason);
  }

  /**
   * Retires an egress permanently for one provider — see
   * `selector-cooldowns.ts` for the block-vs-cooldown contract.
   */
  async flagProviderBlocked(
    poolId: string,
    providerId: string,
    reason?: string,
  ): Promise<ProxyCooldownEntry> {
    return readFlagProviderBlocked(this, poolId, providerId, reason);
  }

  async isProviderCooldown(
    poolId: string,
    providerId: string,
  ): Promise<PoolCooldownState> {
    return readIsProviderCooldown(this, poolId, providerId);
  }

  async getPoolCooldowns(poolId: string): Promise<readonly ProxyCooldownEntry[]> {
    return readGetPoolCooldowns(this, poolId);
  }

  async clearProviderCooldown(poolId: string, providerId: string): Promise<void> {
    return readClearProviderCooldown(this, poolId, providerId);
  }

  /**
   * Releases a *retired* egress only, leaving a cooldown intact — see
   * `selector-cooldowns.ts` for why this is not `clearProviderCooldown`.
   */
  async clearProviderBlockedOnly(poolId: string, providerId: string): Promise<void> {
    return readClearProviderBlockedOnly(this, poolId, providerId);
  }

  /**
   * Removes one cooldown marker and its index entry in one atomic step —
   * see `selector-cooldowns.ts` for the write-pairing contract.
   */
  async clearRedisCooldown(poolId: string, providerId: string): Promise<void> {
    return readClearRedisCooldown(this.redis, poolId, providerId);
  }

  /**
   * Drops every cooldown this pool holds, marker and index together —
   * see `selector-cooldowns.ts`.
   */
  async clearPoolCooldowns(poolId: string): Promise<void> {
    return readClearPoolCooldowns(this, poolId);
  }

  /**
   * Distributed pool admission — the selection algorithm lives in
   * `selector-inflight.ts`; this wrapper supplies state, Redis, and the
   * pool-usage notification hook.
   */
  async tryAcquireAvailablePool(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    rotation?: PoolRotation,
    providerMaxInflight?: number,
  ): Promise<{ poolId: string; release: () => void } | undefined> {
    return readTryAcquireAvailablePool(
      this,
      this.notifyPoolUsage.bind(this),
      eligiblePoolIds,
      providerId,
      limitsByPool,
      weightsByPool,
      rotation,
      providerMaxInflight,
    );
  }

  async getSelectionFailure(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    providerMaxInflight?: number,
  ): Promise<PoolSelectionFailure> {
    return readGetSelectionFailure(this, eligiblePoolIds, providerId, limitsByPool, weightsByPool, providerMaxInflight);
  }
}
