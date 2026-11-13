// Provider-scoped routing overrides: per-tenant/per-provider routing settings
// and rotation within same-rank candidate runs. Extracted from router.ts —
// the plan engine supplies its round-robin map so rotation state stays owned
// by RoutingEngine.
import type {
  ProviderRoutingSetting,
  RouteCandidate,
  RouteSnapshot,
  RoutingDecision,
} from "./route-model";
import { ROUTING_RANK } from "./route-model";
import type { RoundRobinState } from "./round-robin";

/**
 * Resolves the effective provider routing setting for a (tenant, provider)
 * pair: tenant bucket first, then the `__global__` bucket.
 */
export function resolveProviderRouting(
  snapshot: RouteSnapshot,
  providerId: string,
  tenantId: string | null,
): ProviderRoutingSetting | undefined {
  const routing = snapshot.providerRouting;
  if (!routing) return undefined;
  const tenantKey = tenantId ?? "__global__";
  const tenantBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
    tenantKey
  ];
  if (tenantBucket?.[providerId]) return tenantBucket[providerId];
  const globalBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
    "__global__"
  ];
  if (globalBucket?.[providerId]) return globalBucket[providerId];
  return undefined;
}

/**
 * Rotates one same-rank run according to the provider routing strategy.
 * `roundRobinFor` supplies the per-key rotation state owned by the engine.
 */
function reorderRun(
  run: RouteCandidate[],
  settings: ProviderRoutingSetting | undefined,
  tid: string | null,
  roundRobinFor: (key: string) => RoundRobinState,
): RouteCandidate[] {
  if (!settings || !settings.enabled || settings.strategy === "fallback") {
    return [...run];
  }
  const rrKey = `${tid ?? "__global__"}::${run[0]!.provider_id}`;
  const rr = roundRobinFor(rrKey);
  const chosen = rr.next(run, settings.rotateCount);
  if (!chosen) return [...run];
  const idx = run.indexOf(chosen);
  if (idx <= 0) return [...run];
  return [...run.slice(idx), ...run.slice(0, idx)];
}

/**
 * Rotates accounts within the same rank group only. The rank is the primary
 * sort key, so rotation can never float a cooling/saturated account ahead of
 * a fresh one — the old double-sort is gone by construction.
 */
export function applyProviderRoutingSorted(
  eligible: readonly RouteCandidate[],
  decisions: ReadonlyMap<RouteCandidate, RoutingDecision>,
  snapshot: RouteSnapshot,
  tid: string | null,
  roundRobinFor: (key: string) => RoundRobinState,
): RouteCandidate[] {
  if (eligible.length <= 1) return [...eligible];
  const result: RouteCandidate[] = [];
  let i = 0;
  while (i < eligible.length) {
    const cur = eligible[i]!;
    const rank = decisions.get(cur)?.rank ?? ROUTING_RANK.FRESH_KNOWN;
    let j = i + 1;
    while (j < eligible.length) {
      const next = eligible[j]!;
      const nextRank = decisions.get(next)?.rank ?? ROUTING_RANK.FRESH_KNOWN;
      if (
        next.provider_id !== cur.provider_id ||
        next.model_id !== cur.model_id ||
        nextRank !== rank
      ) {
        break;
      }
      j += 1;
    }
    const run = eligible.slice(i, j);
    if (run.length > 1) {
      const settings = resolveProviderRouting(snapshot, cur.provider_id, tid);
      result.push(...reorderRun([...run], settings, tid, roundRobinFor));
    } else {
      result.push(...run);
    }
    i = j;
  }
  return result;
}
