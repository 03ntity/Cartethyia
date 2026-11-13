// Alias/combo target resolution for routing.
import {
  ambiguousModelError,
  modelNotFoundError,
  type ComboDefinition,
  type RouteCandidate,
  type RouteSnapshot,
} from "./route-model";
import {
  lookupRouteCandidates,
  parseModelReference,
  routeCandidateIndex,
} from "./candidate-index";
import type { RoundRobinState } from "./round-robin";

/**
 * Normalizes a requested model name before alias lookup. Coding-agent CLIs
 * version their model ids with variant suffixes (`claude-opus-5[1m]`,
 * effort tags, …) that must never each become a mapping row. Normalization
 * is a pure lookup fallback — verbatim match always wins, and an
 * unrecognized name still resolves to itself (then fails downstream as
 * `model_not_found`, exactly like today).
 */
function normalizeAliasKey(requested: string, aliasMap: Record<string, string> | undefined): string {
  if (!aliasMap || aliasMap[requested] !== undefined) return requested;
  // 1. Strip a trailing `[...]` variant (`claude-opus-5[1m]` → `claude-opus-5`).
  let base = requested;
  const bracket = requested.indexOf("[");
  if (bracket > 0) {
    base = requested.slice(0, bracket);
    if (aliasMap[base] !== undefined) return base;
  }
  // 2. Family-slot fallback: `claude-<slot>-…` resolves through the slot
  // alias (`claude-opus-5` → `opus`, `claude-opus` → `opus`) so a full model
  // id honors the same mapping as the short slot name without per-variant
  // rows. Only fires when the full name has no mapping of its own.
  if (base.startsWith("claude-")) {
    const rest = base.slice("claude-".length);
    if (aliasMap[rest] !== undefined) return rest;
    const dash = rest.indexOf("-");
    if (dash > 0) {
      const slot = rest.slice(0, dash);
      if (aliasMap[slot] !== undefined) return slot;
    }
  }
  return base;
}

/**
 * Resolves one requested name to its alias target for pre-routing policy
 * checks. CLI mappings are opt-in per API key; ordinary tenant aliases always
 * remain available. `keyId` is required to read the key's own CLI routes —
 * without it CLI mappings are silently skipped even when `allowCliMappings`
 * is true.
 */
export function resolveAliasTarget(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  requested: string,
  allowCliMappings = false,
  keyId?: string,
): string {
  try {
    return resolveAlias(requested, snapshot, tenantId, allowCliMappings, keyId).model;
  } catch {
    return requested;
  }
}

/**
 * Merged alias maps cached per snapshot object. `plan()` resolves the requested
 * model plus every combo member through `resolveAlias`, and each call used to
 * re-merge the tenant and CLI alias records — O(members × aliases) per plan.
 * Snapshots are immutable per revision, so the merge is cached on the snapshot
 * itself; the returned record is read-only by contract (resolvers only index
 * it, never write).
 */
const aliasMapCache = new WeakMap<
  RouteSnapshot,
  Map<string, Record<string, string> | undefined>
>();

function aliasMapFor(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings: boolean,
  keyId?: string,
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const cacheKey = JSON.stringify([tenantId, allowCliMappings, keyId ?? null]);
  let perSnapshot = aliasMapCache.get(snapshot);
  if (perSnapshot === undefined) {
    perSnapshot = new Map();
    aliasMapCache.set(snapshot, perSnapshot);
  }
  if (perSnapshot.has(cacheKey)) return perSnapshot.get(cacheKey);
  const aliases = snapshot.aliases?.[tenantId];
  const cliAliases = allowCliMappings
    ? keyId
      ? snapshot.cli_aliases?.[`${tenantId}:${keyId}`] ?? snapshot.cli_aliases?.[tenantId]
      : snapshot.cli_aliases?.[tenantId]
    : undefined;
  const merged =
    !aliases && !cliAliases ? undefined : { ...(aliases ?? {}), ...(cliAliases ?? {}) };
  perSnapshot.set(cacheKey, merged);
  return merged;
}

function resolveAlias(
  requested: string,
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings = false,
  keyId?: string,
): { model: string; chain: readonly string[] } {
  const aliasMap = aliasMapFor(snapshot, tenantId, allowCliMappings, keyId);
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizeAliasKey(requested, aliasMap);
  while (aliasMap?.[current] !== undefined) {
    if (seen.has(current))
      throw new Error(`routing alias cycle: ${[...chain, current].join(" -> ")}`);
    if (chain.length >= 16)
      throw new Error(`routing alias depth exceeded: ${[...chain, current].join(" -> ")}`);
    const target = aliasMap[current];
    if (target === undefined) break;
    seen.add(current);
    chain.push(current);
    current = target;
  }
  return { model: current, chain };
}

/**
 * Resolves the requested name to a bare target, expands a combo into its
 * member models, and returns the candidates serving them in plan order.
 *
 * Both alias resolution and the ambiguity check judge the *resolved* bare
 * target, never the originally requested name: an alias resolving to a bare
 * model that multiple providers serve must be rejected exactly like
 * requesting that bare model directly, so resolving through an alias is
 * never a silent way to bypass ambiguity protection.
 *
 * `roundRobinByCombo` is the accessor for the combo round-robin state owned
 * by the caller, so the `round_robin` strategy rotation stays stateful
 * while this module remains a pure function of its inputs plus that accessor.
 */
export function resolveMatchingCandidates(
  requestedModel: string,
  snapshot: RouteSnapshot,
  tid: string | null,
  allowCliMappings: boolean,
  keyId: string | undefined,
  roundRobinByCombo: (key: string) => RoundRobinState,
): {
  resolved: ReturnType<typeof resolveAlias>;
  combo: ComboDefinition | undefined;
  matching: RouteCandidate[];
  /** Combo members that matched zero candidates — misconfigured or
   * connection-less members the operator should fix, surfaced on errors
   * instead of failing opaquely on whichever member happened to route. */
  unmatchedMembers: readonly string[];
} {
  const safeResolve = (name: string) => {
    try {
      return resolveAlias(name, snapshot, tid, allowCliMappings, keyId);
    } catch {
      throw modelNotFoundError(requestedModel);
    }
  };
  const resolved = safeResolve(requestedModel);
  const comboMap = tid ? snapshot.combos[tid] : undefined;
  const combo = comboMap?.[resolved.model];
  // Combo members may themselves be aliases or combos (an alias may target
  // a combo, and a combo may nest another combo). Resolve recursively with
  // the same depth bound as the alias walk so a member that names a combo
  // expands to its models instead of matching no candidate and reading as
  // "model not found" for a route the operator actually defined.
  const expandMember = (name: string, seen: ReadonlySet<string>): readonly string[] => {
    if (seen.has(name) || seen.size >= 16) return [];
    const next = new Set(seen).add(name);
    const alias = safeResolve(name);
    const nested = comboMap?.[alias.model];
    if (!nested) return [alias.model];
    return nested.members.flatMap((member) => expandMember(member, next));
  };
  const rawModelIds = combo
    ? combo.members.flatMap((name) => expandMember(name, new Set([resolved.model])))
    : [resolved.model];
  const modelIds = [...new Set(rawModelIds)];
  // One index build per snapshot (cached on the immutable snapshot), one
  // lookup per unique resolved model. The previous shape rescanned every
  // candidate per model — O(C×K) string parses per plan — which was the
  // quadratic cost the catalog rebuild had already paid once and the request
  // path was paying again on every plan.
  const index = routeCandidateIndex(snapshot);
  const parsedModels = modelIds.map((id) => ({ id, parsed: parseModelReference(id) }));
  let matching = parsedModels.flatMap((entry) => lookupRouteCandidates(index, entry.parsed, tid));
  // Preserve the resolver's flatten-then-dedupe contract: one candidate can
  // serve two member groups only via a combo listing the same model twice,
  // and the plan must not dial it twice.
  matching = [...new Set(matching)];
  let unmatchedMembers: readonly string[] = [];
  if (combo) {
    const perId = parsedModels.map((entry) => ({
      id: entry.id,
      group: lookupRouteCandidates(index, entry.parsed, tid),
    }));
    unmatchedMembers = perId.filter((entry) => entry.group.length === 0).map((entry) => entry.id);
    const groups = perId.map((entry) => entry.group).filter((g) => g.length > 0);
    if (combo.strategy === "round_robin" && groups.length > 1) {
      const heads = groups.map((g) => g[0] as RouteCandidate);
      const rr = roundRobinByCombo(`${tid}::${resolved.model}`);
      const chosen = rr.next(heads, 1);
      const startIndex = chosen ? heads.indexOf(chosen) : 0;
      matching = [...groups.slice(startIndex), ...groups.slice(0, startIndex)].flat();
    } else {
      matching = groups.flat();
    }
  }
  if (matching.length === 0) {
    // A qualified `provider/model` reference whose model is not in the
    // catalog still routes: clone the provider's first live candidate (any
    // model) and retarget it at the requested model. This is the passthrough
    // contract — a provider that accepts arbitrary model ids (BYOK, custom
    // gateways, or a model the catalog has not fetched yet) must be able to
    // serve them. The clone inherits the provider's endpoint, wire family,
    // dialect, capabilities, tenant scoping and account/network-pool wiring;
    // only the model id changes. A provider with zero candidates cannot be
    // synthesized, so bare-model misses and empty providers still 404.
    if (parsedModels.length === 1 && parsedModels[0]!.parsed.providerId !== null) {
      const providerId = parsedModels[0]!.parsed.providerId;
      const sibling = [...index.qualified.entries()]
        .filter(([key]) => key.startsWith(`${providerId}/`))
        .flatMap(([, group]) => group)
        .find((candidate) => candidate.tenant_id == null || candidate.tenant_id === tid);
      if (sibling !== undefined) {
        matching = [{
          ...sibling,
          model_id: parsedModels[0]!.parsed.modelId,
        }];
      }
    }
    if (matching.length === 0) throw modelNotFoundError(requestedModel, modelIds);
  }
  const owners = [...new Set(matching.map((candidate) => candidate.provider_id))];
  if (owners.length > 1 && !resolved.model.includes("/") && !combo)
    throw ambiguousModelError(requestedModel, owners);
  return { resolved, combo, matching, unmatchedMembers };
}
