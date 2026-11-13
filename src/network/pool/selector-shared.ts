/**
 * Shared constants and small helpers for `NetworkPoolSelector` and its
 * cooldown/inflight sibling modules. Nothing here touches Redis or class
 * state — pure derivation only.
 */
import { resolveInflightTtlSeconds } from "../../config/timeouts";

export const DEFAULT_PROXY_CONCURRENCY = 10;
const DEFAULT_PROXY_WEIGHT = 100;
const MAX_PROXY_WEIGHT = 1000;
// Crash-recovery bound, not a lease duration: normal releases DECR/DEL the
// key immediately, so the TTL only matters when a holder dies mid-request.
// Derived by `resolveInflightTtlSeconds` from the same resolvers the dispatch
// path uses, so raising either timeout keeps the invariant — and so this
// selector and the routing admission controller expire their slots on the same
// bound, since both hold one for the same request duration.
export function poolInflightTtlSeconds(): number {
  return resolveInflightTtlSeconds();
}
export function effectiveConcurrency(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 0;
  return limit;
}
export function normalizedWeight(weight: number | undefined): number {
  if (weight === undefined) return DEFAULT_PROXY_WEIGHT;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_PROXY_WEIGHT) return 0;
  return weight;
}

/** Local-map key for a provider's share of a pool. NUL cannot appear in either id. */
export function providerInflightStateKey(poolId: string, providerId: string): string {
  return `${poolId}\u0000${providerId.toLowerCase()}`;
}

/** Local-map key for a provider's cooldown entry on a pool. */
export function poolCooldownKey(poolId: string, providerId: string): string {
  return `${poolId}::${providerId.toLowerCase()}`;
}

export function decrementLocal(counter: Map<string, number>, key: string): void {
  const value = counter.get(key) ?? 1;
  if (value <= 1) counter.delete(key);
  else counter.set(key, value - 1);
}
