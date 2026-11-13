/**
 * Pure projections for the public model catalog: the published entry and
 * metadata shapes, the alias/combo resolution walk, the modality/cost
 * normalization, and the allowlist shadow filter. Extracted from
 * `public-model-store.ts`; the cache and the store class live in
 * `public-model-cache.ts` and `public-model-store.ts`.
 */
import { listIncludes, type ApiKeyAuthorizationSnapshot } from "../../../security/api-key-auth";

export interface AllowedModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: unknown;
  reasoning?: boolean;
  tool_call?: boolean;
  cost?: unknown;
  /**
   * Protocol shape of the model. Absent means `llm` (the canonical chat wire);
   * a non-`llm` value (System One) tells a chat client that this id is served
   * by a native route, not by `/v1/chat/completions` - so a picker can label it
   * instead of offering a route that only answers `capability_unsupported`.
   */
  service_kind?: string;
}

/**
 * The closed input/output modality vocabulary this surface publishes.
 *
 * The catalog stores provider-native spellings (`document`, `file`), and
 * models.dev files a different set (`pdf`, `video`). A client parsing
 * `/v1/models` needs one vocabulary, so the emitted `capabilities` is
 * normalized to this set: synonyms are folded (`document`/`file`  `pdf`) and
 * any token outside it is dropped rather than leaked verbatim.
 */
const MODALITY_SYNONYMS: Readonly<Record<string, string>> = {
  document: "pdf",
  file: "pdf",
};
const KNOWN_MODALITIES: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "pdf"]);

function normalizeModalityList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const token = MODALITY_SYNONYMS[raw] ?? raw;
    if (!KNOWN_MODALITIES.has(token) || out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Projects a stored `modalities` jsonb value into the published vocabulary.
 * `undefined` when nothing survives - an entry with no describable modality
 * omits `capabilities` rather than advertising an empty one.
 */
export function normalizeModalities(value: unknown): { input?: string[]; output?: string[] } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { input?: unknown; output?: unknown };
  const pick = (candidate: unknown): string[] =>
    Array.isArray(candidate) ? normalizeModalityList(candidate.filter((v): v is string => typeof v === "string")) : [];
  const input = pick(record.input);
  const output = pick(record.output);
  if (input.length === 0 && output.length === 0) return undefined;
  return {
    ...(input.length > 0 ? { input } : {}),
    ...(output.length > 0 ? { output } : {}),
  };
}

/** A cost value's comparable rate signature; `undefined` when it states none. */
function costSignature(cost: unknown): string | undefined {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const c = cost as { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
  return [c.input, c.output, c.cache_read, c.cache_write]
    .map((value) => (typeof value === "number" ? value : "x"))
    .join("/");
}

/**
 * The rate every member agrees on, or `undefined` when they differ.
 *
 * A pool may route to any member, so a single price is only honest when all of
 * them bill the same; quoting one member's rate would misprice the rest.
 */
export function commonCost(entries: readonly unknown[]): unknown {
  const present = entries.filter((entry) => entry != null);
  if (present.length === 0) return undefined;
  const signature = costSignature(present[0]);
  if (signature === undefined) return undefined;
  return present.every((entry) => costSignature(entry) === signature) ? present[0] : undefined;
}

/** Catalog metadata mirrored onto an alias or combo entry. */
export interface ModelMetadata {
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  /**
   * True when the limits above are a placeholder because no catalog row filed
   * this model. The surface marks them so an operator can tell a measured
   * window from a stand-in.
   */
  readonly limitsEstimated?: boolean;
  readonly modalities: unknown;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  /** Provider-level: the provider's adapter drives a hosted web-search tool. */
  readonly webSearch: boolean;
  readonly cost: unknown;
}

/** Defaults advertised when a target has no catalog row to describe it. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const DEFAULT_OUTPUT_LIMIT = 64_192;

/** Bound on the alias/combo walk; matches the engine's `resolveAlias` depth. */
const MAX_TARGET_DEPTH = 16;

/**
 * Resolves a routing name to the catalog ids it can actually reach.
 *
 * An alias may target a combo rather than a model (`muse-spark-1.3` 
 * `muse-pool`), and a combo member may itself be an alias or combo, exactly as
 * dispatch resolves them. Reading only the immediate target would miss the
 * catalog rows that describe the route and fall back to invented limits. A
 * name that resolves to nothing concrete is returned as-is so the lookup can
 * still match a bare catalog id.
 */
export function resolveTargetIds(
  name: string,
  aliasTargets: ReadonlyMap<string, string>,
  comboMembers: ReadonlyMap<string, readonly string[]>,
  seen: Set<string> = new Set(),
): string[] {
  return collectTargetIds(name, aliasTargets, comboMembers, seen);
}

/**
 * Walks alias  combo  member with one mutable visited set.
 *
 * The previous form copied the whole set per edge (`new Set(seen).add(name)`),
 * which is called per alias and per combo row over the whole catalog. Adding
 * and removing on one set keeps the same cycle protection - each branch still
 * sees its own ancestors - without an allocation per step.
 */
function collectTargetIds(
  name: string,
  aliasTargets: ReadonlyMap<string, string>,
  comboMembers: ReadonlyMap<string, readonly string[]>,
  seen: Set<string>,
): string[] {
  if (seen.has(name) || seen.size >= MAX_TARGET_DEPTH) return [];
  seen.add(name);
  try {
    const members = comboMembers.get(name);
    if (members) {
      return members.flatMap((m) => collectTargetIds(m, aliasTargets, comboMembers, seen));
    }
    const target = aliasTargets.get(name);
    if (target !== undefined) {
      return collectTargetIds(target, aliasTargets, comboMembers, seen);
    }
    return [name];
  } finally {
    // Removing on the way out keeps `seen` meaning "ancestors on this path",
    // so a name reachable by two sibling branches still resolves in both.
    seen.delete(name);
  }
}

/**
 * The metadata a routing name advertises, given the ids it can reach.
 *
 * The first member that states its own metadata wins, wholesale - limits,
 * capabilities, and cost together. Averaging across members made a pool read
 * as its weakest member: an alias over a 1M/384k row and a 200k/64k row
 * advertised 200k/64k and dropped vision, because the conservative rule
 * (minimum limits, only capabilities every member shares) describes the worst
 * route rather than the one the pool exists to serve.
 *
 * "States its own" carries as much weight as "first". A member whose limits are
 * the estimated fallback is skipped, so a placeholder never outranks a real
 * measurement merely by coming first in the member list.
 *
 * When no member states its own, the conservative aggregate is still the honest
 * answer: every candidate is a placeholder, so there is no better one to prefer.
 */
export function advertisedMetadata(
  ids: readonly string[],
  meta: ReadonlyMap<string, ModelMetadata>,
): ModelMetadata {
  const found = ids
    .map((id) => meta.get(id))
    .filter((entry): entry is ModelMetadata => entry !== undefined);
  if (found.length === 0) {
    return {
      contextLimit: null,
      outputLimit: null,
      modalities: undefined,
      reasoning: false,
      toolCall: false,
      webSearch: false,
      cost: undefined,
    };
  }
  const filed = found.find((m) => m.limitsEstimated !== true && m.contextLimit !== null);
  if (filed !== undefined) {
    return {
      contextLimit: filed.contextLimit,
      outputLimit: filed.outputLimit,
      modalities: filed.modalities,
      reasoning: filed.reasoning,
      toolCall: filed.toolCall,
      webSearch: filed.webSearch,
      cost: filed.cost,
    };
  }
  return {
    contextLimit: Math.min(...found.map((m) => m.contextLimit ?? DEFAULT_CONTEXT_LIMIT)),
    outputLimit: Math.min(...found.map((m) => m.outputLimit ?? DEFAULT_OUTPUT_LIMIT)),
    // Estimated only when every target is unfiled: one measured target is
    // enough to describe the alias.
    ...(found.every((m) => m.limitsEstimated === true) ? { limitsEstimated: true } : {}),
    modalities: intersectModalities(found.map((m) => m.modalities).filter((m) => m != null)),
    // Every candidate here is a placeholder, so none is preferable: a
    // capability is claimed only when all of them carry it, and a rate is
    // quoted only when all bill alike.
    reasoning: found.every((m) => m.reasoning),
    toolCall: found.every((m) => m.toolCall),
    webSearch: found.every((m) => m.webSearch),
    cost: commonCost(found.map((m) => m.cost)),
  };
}

/** Input/output modalities every member shares; `undefined` when none do. */
export function intersectModalities(entries: readonly unknown[]): unknown {
  if (entries.length === 0) return undefined;
  const normalize = (entry: unknown): { input?: readonly string[]; output?: readonly string[] } =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { input?: readonly string[]; output?: readonly string[] })
      : {};
  const first = normalize(entries[0]);
  const input = new Set(first.input ?? []);
  const output = new Set(first.output ?? []);
  for (const entry of entries.slice(1)) {
    const next = normalize(entry);
    for (const value of [...input]) {
      if (!(next.input ?? []).includes(value)) input.delete(value);
    }
    for (const value of [...output]) {
      if (!(next.output ?? []).includes(value)) output.delete(value);
    }
  }
  if (input.size === 0 && output.size === 0) return undefined;
  return {
    ...(input.size > 0 ? { input: [...input] } : {}),
    ...(output.size > 0 ? { output: [...output] } : {}),
  };
}

/** Last `/`-separated segment of a model id: the bare name a client types. */
function lastSegment(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * True when a catalog row should stay hidden because its visibility comes only
 * from a bare allowlist entry that is really an alias or combo name.
 *
 * `isModelAllowed` deliberately matches a bare entry against every qualified
 * form, so `glm-5.3-flash` in the allowlist also clears
 * `cline/z-ai/glm-5.3-flash` and `cb/glm-5.3-flash`. That is correct
 * for dispatch (the operator's intent is "this model, any provider") but wrong
 * for discovery: the operator published *one* name - the alias - and every
 * qualified form of it is the same route wearing a different label. So when an
 * alias is allowlisted, its bare name is the single public entry and every
 * qualified form is hidden. An explicitly qualified allowlist entry
 * (`cb/glm-5.3-flash`) is an unambiguous grant of that exact row and is
 * never shadowed. The alias carries the target's real capabilities, so nothing
 * is lost.
 *
 * Both the row and the alias target are judged by their bare name as well as
 * their full id. A catalog row may nest its own path (`cline-free/gpt-5`), so
 * comparing only `row.modelId` let a nested retired free-tier model survive
 * beside the allowlisted `deepseek-v4.1-flash` alias and reappear on whichever
 * provider happened to nest it - the exact leak this filter exists to stop.
 */
export function shadowsAliasOrCombo(
  row: { readonly providerId: string; readonly modelId: string },
  aliasTargets: ReadonlyMap<string, string>,
  comboNames: ReadonlySet<string>,
  snapshot: ApiKeyAuthorizationSnapshot,
): boolean {
  // Shadowing exists only to collapse a bare whitelist entry that is really an
  // alias/combo into a single public row. A blacklist grants nothing, so every
  // catalog row stays visible unless it is explicitly denied - nothing to hide.
  if (snapshot.model_access_mode !== "whitelist") return false;
  const qualified = `${row.providerId}/${row.modelId}`;
  // An explicit qualified entry is an unambiguous grant - never shadow it.
  if (listIncludes(snapshot.model_list, qualified)) return false;
  const bare = lastSegment(row.modelId);
  for (const [alias, target] of aliasTargets) {
    if (!listIncludes(snapshot.model_list, alias)) continue;
    // Hide every qualified form the alias covers: the alias itself already
    // represents the route, with the target's real limits and capabilities.
    if (target === qualified || target === row.modelId) return true;
    const bareTarget = lastSegment(target);
    if (row.modelId === alias || row.modelId === bareTarget) return true;
    if (bare === alias || bare === bareTarget) return true;
  }
  for (const name of comboNames) {
    if (!listIncludes(snapshot.model_list, name)) continue;
    if (row.modelId === name || bare === name) return true;
  }
  return false;
}
