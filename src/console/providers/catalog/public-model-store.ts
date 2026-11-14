/**
 * Public model catalog: the read-only `/v1/models` surface an API key sees.
 *
 * Answers "which models may this key use, and what are they?" by intersecting
 * the enabled catalog with the key's model allow/deny lists, then applying the
 * key's `model_prefix`. Kept separate from the operator-facing
 * `DrizzleProviderCatalogStore` because the two have different trust levels:
 * this one is driven entirely by untrusted caller input plus one frozen
 * authorization snapshot.
 *
 * Split on clean seams: the cache lives in `public-model-cache.ts` and the
 * pure projections in `public-model-projections.ts`; this file keeps the
 * store class and the catalog queries.
 */
import { globalOrOwnedBy } from "../../../persistence/tenant-scope";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { modelAliases, modelCombos, models, providerAccounts, providers } from "../../../persistence/schema";
import { isModelAllowed, type ApiKeyAuthorizationSnapshot } from "../../../security/api-key-auth";
import { modelsDevCatalog } from "../../../providers/discovery/models-dev-catalog";
import { FALLBACK_CONTEXT_LIMIT, FALLBACK_OUTPUT_LIMIT } from "../../../providers/provider-model-definition";
import {
  PUBLIC_MODEL_CACHE_MAX_ENTRIES,
  PUBLIC_MODEL_CACHE_TTL_MS,
  ensurePublicModelInvalidationSubscription,
  publicModelCache,
  publicModelCacheKey,
  publicModelInFlight,
} from "./public-model-cache";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
  advertisedMetadata,
  commonCost,
  intersectModalities,
  normalizeModalities,
  resolveTargetIds,
  shadowsAliasOrCombo,
  type AllowedModelEntry,
  type ModelMetadata,
} from "./public-model-projections";

export {
  invalidatePublicModelCache,
  invalidatePublicModels,
  publicModelCacheSize,
} from "./public-model-cache";
export {
  advertisedMetadata,
  resolveTargetIds,
} from "./public-model-projections";
export type { AllowedModelEntry, ModelMetadata } from "./public-model-projections";

export class PublicModelCatalogStore {
  constructor(private readonly db: CartethyiaDatabase) {
    // Peer mutations: a write handled by one process must drop the cached
    // listing in the others, or `reusePort` serves stale model lists from
    // whichever process did not handle the write. Subscribed once - a
    // subscription per instance would leak one Redis connection per store.
    ensurePublicModelInvalidationSubscription();
  }

  async metadataForNames(
    tenantId: string,
    names: readonly string[],
  ): Promise<Map<string, ModelMetadata>> {
    const [aliasRows, comboRows] = await Promise.all([
      this.db.select().from(modelAliases).where(eq(modelAliases.tenantId, tenantId)),
      this.db.select().from(modelCombos).where(eq(modelCombos.tenantId, tenantId)),
    ]);
    const aliases = new Map(aliasRows.map((row) => [row.alias, row.targetModel]));
    const combos = new Map(
      comboRows.map((row) => [
        row.name,
        Array.isArray(row.members) ? row.members.filter((member): member is string => typeof member === "string") : [],
      ]),
    );
    const targetIds = names.flatMap((name) => resolveTargetIds(name, aliases, combos));
    const targetMeta = await this.modelMetadataById(tenantId, targetIds);
    const result = new Map<string, ModelMetadata>();
    for (const name of names) {
      result.set(name, advertisedMetadata(resolveTargetIds(name, aliases, combos), targetMeta));
    }
    return result;
  }

  /**
   * Lists the models this key may see.
   *
   * `modelPrefix` is accepted and has NO effect on the result - a prefix
   * disjunct fed into `isModelAllowed(...)` on its own could never add a row.
   * The parameter is kept so the call sites and the auth shape stay stable; if a
   * real prefix filter is wanted later it needs to be an AND, not the OR it
   * was written as.
   */
  async listPublicModels(
    tenantId: string | null,
    snapshot: ApiKeyAuthorizationSnapshot,
    _modelPrefix?: string,
  ): Promise<AllowedModelEntry[]> {
    const key = publicModelCacheKey(tenantId, snapshot, _modelPrefix);
    const now = Date.now();
    const hit = publicModelCache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      // Refresh recency: a Map deletes its FIRST key on eviction, so
      // re-inserting is what makes this an LRU rather than a FIFO.
      publicModelCache.delete(key);
      publicModelCache.set(key, hit);
      // Copied, not shared: the caller may sort or mutate the array, and a
      // cached value that changed under the next caller would be a cache that
      // serves someone else's edits.
      return [...hit.value];
    }
    if (hit !== undefined) publicModelCache.delete(key);

    // One build per key. Without this, N concurrent misses for the same key
    // run N full catalog reads - the stampede the cache exists to prevent,
    // and worst exactly when the cache is cold.
    const pending = publicModelInFlight.get(key);
    if (pending !== undefined) return pending;
    const build: Promise<AllowedModelEntry[]> = this.queryPublicModels(tenantId, snapshot, _modelPrefix)
      .then((value) => {
        // Only a successful, fully-materialized array is cached: a partial or
        // rejected build must not be served as if it were complete.
        publicModelCache.set(key, { expiresAt: Date.now() + PUBLIC_MODEL_CACHE_TTL_MS, value });
        if (publicModelCache.size > PUBLIC_MODEL_CACHE_MAX_ENTRIES) {
          const oldest = publicModelCache.keys().next().value;
          if (oldest !== undefined) publicModelCache.delete(oldest);
        }
        return [...value];
      })
      .finally(() => {
        publicModelInFlight.delete(key);
      });
    publicModelInFlight.set(key, build);
    return build;
  }

  /** The uncached listing. Renamed from `listPublicModels`; see that method. */
  private async queryPublicModels(
    tenantId: string | null,
    snapshot: ApiKeyAuthorizationSnapshot,
    _modelPrefix?: string,
  ): Promise<AllowedModelEntry[]> {
    const providerScope =
      tenantId === null
        ? isNull(providers.tenantId)
        : globalOrOwnedBy(providers.tenantId, tenantId);
    const rows = await this.db
      .select({
        providerId: models.providerId,
        contextLimit: models.contextLimit,
        modelId: models.modelId,
        serviceKind: models.serviceKind,
        outputLimit: models.outputLimit,
        modalities: models.modalities,
        reasoning: models.reasoning,
        toolCall: models.toolCall,
        cost: models.cost,
        providerRequiresAccount: providers.requiresAccount,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));

    // A model is exposed only when its provider has an active account for this
    // tenant. This matches the console model picker, so an API key never
    // advertises a provider the operator has not configured.
    const activeProviderIds = new Set<string>();
    if (tenantId !== null) {
      const activeAccounts = await this.db
        .select({ providerId: providerAccounts.providerId })
        .from(providerAccounts)
        .where(and(eq(providerAccounts.tenantId, tenantId), eq(providerAccounts.status, "active")));
      for (const row of activeAccounts) activeProviderIds.add(row.providerId);
    }

    // Alias and combo rows are loaded up front because they change what a bare
    // allowlist entry is allowed to expose (see the shadow filter below).
    const aliasRows = tenantId === null
      ? []
      : await this.db.select().from(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    const comboRows = tenantId === null
      ? []
      : await this.db.select().from(modelCombos).where(eq(modelCombos.tenantId, tenantId));

    /**
     * Alias name -> the qualified id it resolves to.
     *
     * A bare allowlist entry matches *every* provider whose model id shares
     * that bare name, which would silently expose siblings the operator never
     * named: allowing the alias `glm-5.3-flash` would also surface
     * `cb/glm-5.3-flash` and `cbcn/glm-5.3-flash` alongside the alias's
     * real target. When the allowlisted name is an alias, only its own target
     * stays visible; a sibling needs an explicit qualified entry.
     */
    const aliasTargets = new Map<string, string>();
    for (const alias of aliasRows) {
      if (typeof alias.alias === "string" && typeof alias.targetModel === "string") {
        aliasTargets.set(alias.alias, alias.targetModel);
      }
    }
    const comboNames = new Set<string>();
    for (const combo of comboRows) {
      if (typeof combo.name === "string") comboNames.add(combo.name);
    }

    // One clock reading for the whole response: `created` is the same
    // timestamp for every entry, and reading it per row made the field vary
    // across a single listing.
    const now = Math.floor(Date.now() / 1000);
    const modelEntries: AllowedModelEntry[] = [];
    for (const row of rows) {
      // A provider is listed only when the tenant has an active account for
      // it - the same rule the console model picker applies. A no-auth
      // provider with nothing configured is not "set", so it stays hidden
      // until the operator adds an account.
      //
      // Exception: a credential-less provider (`requires_account = false`) is
      // routable for every tenant without an account, so a key whose allowlist
      // names its models explicitly must see them listed. `isModelAllowed`
      // below still restricts the listing to the named models.
      const explicitlyAllowlisted =
        row.providerRequiresAccount === false &&
        snapshot.model_access_mode !== "blacklist" &&
        snapshot.model_list != null &&
        (Array.isArray(snapshot.model_list) ? snapshot.model_list.length : (snapshot.model_list as ReadonlySet<string>).size) > 0;
      const listed =
        tenantId === null
          ? row.providerRequiresAccount === false
          : activeProviderIds.has(row.providerId) || explicitlyAllowlisted;
      if (!listed) continue;
      const qualified = `${row.providerId}/${row.modelId}`;
      // The prefix test is deliberately gone from this path: `(prefixMatch ||
      // isAllowed)` followed by `isAllowed` reduces to `isAllowed` alone - the
      // prefix disjunct could never change the outcome, only cost a second full
      // pass over the catalog. Collapsing the four chained filters into one loop
      // also drops the three intermediate arrays they materialized.
      if (!isModelAllowed(snapshot, row.modelId, row.providerId)) continue;
      if (shadowsAliasOrCombo(row, aliasTargets, comboNames, snapshot)) continue;
      const capabilities = normalizeModalities(row.modalities);
      modelEntries.push({
        id: qualified,
        object: "model" as const,
        created: now,
        owned_by: row.providerId,
        ...(row.contextLimit != null ? { context_length: row.contextLimit } : {}),
        ...(row.outputLimit != null ? { max_completion_tokens: row.outputLimit } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(row.reasoning ? { reasoning: true } : {}),
        ...(row.toolCall ? { tool_call: true } : {}),
        ...(row.cost != null ? { cost: row.cost } : {}),
        // Only a non-`llm` row is labelled: absence already means "chat wire".
        ...(row.serviceKind && row.serviceKind !== "llm"
          ? { service_kind: row.serviceKind }
          : {}),
      });
    }

    // Expose tenant model aliases and combos as first-class public models.
    // `aliasRows`/`comboRows` were loaded above for the shadow filter.
    if (tenantId !== null) {

      // Capability mirroring reads the *catalog*, not the key-filtered list
      // above: an alias/combo should describe what its target can do even
      // when the key's allowlist names only the alias. Authorization is still
      // enforced per-request by admission, never widened here.
      const comboMembers = new Map<string, readonly string[]>();
      for (const combo of comboRows) {
        if (typeof combo.name === "string" && Array.isArray(combo.members)) {
          comboMembers.set(combo.name, combo.members.filter((m): m is string => typeof m === "string"));
        }
      }
      // Walk alias  combo  member so a target that is a pool name resolves
      // to the catalog rows that describe it; otherwise its limits would be
      // invented defaults rather than what the route can actually serve.
      const targetIds = [
        ...aliasRows.map((a) => resolveTargetIds(a.targetModel, aliasTargets, comboMembers)),
        ...comboRows.flatMap((c) => resolveTargetIds(c.name, aliasTargets, comboMembers)),
      ].flat();
      const targetMeta = await this.modelMetadataById(tenantId, targetIds);


      for (const a of aliasRows) {
        // `!A && !B` followed by `!B` - the second subsumes the first, so the
        // prefix test never changed the outcome. Collapsed to the real gate.
        if (!isModelAllowed(snapshot, a.alias)) continue;
        const target = advertisedMetadata(resolveTargetIds(a.targetModel, aliasTargets, comboMembers), targetMeta);
        const capabilities = normalizeModalities(target.modalities);
        modelEntries.push({
          id: a.alias,
          object: "model" as const,
          created: now,
          owned_by: "cartethyia",
          context_length: target.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
          max_completion_tokens: target.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
          ...(capabilities ? { capabilities } : {}),
          ...(target.reasoning ? { reasoning: true } : {}),
          ...(target.toolCall ? { tool_call: true } : {}),
          ...(target.cost != null ? { cost: target.cost } : {}),
        });
      }

      for (const c of comboRows) {
        if (!isModelAllowed(snapshot, c.name)) continue;
        const target = advertisedMetadata(resolveTargetIds(c.name, aliasTargets, comboMembers), targetMeta);
        const capabilities = normalizeModalities(target.modalities);
        modelEntries.push({
          id: c.name,
          object: "model" as const,
          created: now,
          owned_by: "cartethyia",
          context_length: target.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
          max_completion_tokens: target.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
          ...(capabilities ? { capabilities } : {}),
          ...(target.reasoning ? { reasoning: true } : {}),
          ...(target.toolCall ? { tool_call: true } : {}),
          ...(target.cost != null ? { cost: target.cost } : {}),
        });
      }
    }
    return modelEntries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Catalog metadata for qualified (`provider/model`) ids, independent of
   * the key's allowlist so capabilities mirror even when only the alias is
   * allowed.
   */
  async modelMetadataById(
    tenantId: string,
    ids: readonly string[],
  ): Promise<Map<string, ModelMetadata>> {
    const qualified = new Set<string>();
    const bare = new Set<string>();
    for (const id of ids) {
      const normalized = id.trim();
      const slash = normalized.indexOf("/");
      if (slash > 0) qualified.add(normalized);
      else if (normalized.length > 0) bare.add(normalized);
    }
    const out = new Map<string, ModelMetadata>();
    if (qualified.size === 0 && bare.size === 0) return out;
    const providerScope = globalOrOwnedBy(providers.tenantId, tenantId);
    const rows = await this.db
      .select({
        providerId: models.providerId,
        modelId: models.modelId,
        contextLimit: models.contextLimit,
        outputLimit: models.outputLimit,
        modalities: models.modalities,
        reasoning: models.reasoning,
        toolCall: models.toolCall,
        cost: models.cost,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.enabled, true),
          eq(providers.enabled, true),
          providerScope,
          or(
            ...(qualified.size > 0
              ? [...qualified].map((id) => {
                  const slash = id.indexOf("/");
                  return and(eq(models.providerId, id.slice(0, slash)), eq(models.modelId, id.slice(slash + 1)));
                })
              : []),
            ...(bare.size > 0 ? [...bare].map((id) => eq(models.modelId, id)) : []),
          ),
        ),
      );
    for (const row of rows) {
      const filed =
        row.contextLimit !== null ||
        modelsDevCatalog.resolve(row.providerId, row.modelId) !== undefined ||
        modelsDevCatalog.majorityFor(row.modelId) !== undefined;
      const metadata = {
        // An unfiled model gets the shared fallback rather than `null`, so a
        // routable model is not advertised as having no window at all. Matches
        // the console catalog projection, which substitutes the same pair.
        contextLimit: filed ? row.contextLimit : FALLBACK_CONTEXT_LIMIT,
        outputLimit: filed ? row.outputLimit : FALLBACK_OUTPUT_LIMIT,
        ...(filed ? {} : { limitsEstimated: true }),
        modalities: row.modalities,
        reasoning: row.reasoning,
        toolCall: row.toolCall,
        // No model advertises search: a `websearch` row answers
        // `POST /v1/search`. See the note in provider-metadata.ts.
        webSearch: false,
        cost: row.cost,
      } satisfies ModelMetadata;
      out.set(`${row.providerId}/${row.modelId}`, metadata);
    }
    for (const id of bare) {
      const matches = rows.filter((row) => row.modelId === id).map((row) => out.get(`${row.providerId}/${row.modelId}`));
      if (matches.length > 0 && matches.every((entry) => entry !== undefined)) {
        const found = matches.filter((entry): entry is ModelMetadata => entry !== undefined);
        // Same intent as `advertisedMetadata`: describe the id by a row that
        // states its own limits, not by the weakest provider carrying it. The
        // tie-break differs because a bare id has no member order to defer to -
        // there is no declared list, only whichever rows the query happened to
        // return - so "first" would be whichever the database yielded. The
        // largest filed window is chosen instead: among interchangeable
        // providers it is the one the route can actually serve, and it is
        // deterministic.
        const filed = found.filter((entry) => entry.limitsEstimated !== true && entry.contextLimit !== null);
        if (filed.length > 0) {
          const best = filed.reduce((a, b) =>
            (b.contextLimit ?? 0) > (a.contextLimit ?? 0) ? b : a,
          );
          out.set(id, best);
          continue;
        }
        out.set(id, {
          contextLimit: Math.min(...found.map((entry) => entry.contextLimit ?? DEFAULT_CONTEXT_LIMIT)),
          outputLimit: Math.min(...found.map((entry) => entry.outputLimit ?? DEFAULT_OUTPUT_LIMIT)),
          // Estimated only when no member brought a filed limit: one measured
          // member is enough to describe the pool.
          ...(found.every((entry) => entry.limitsEstimated === true) ? { limitsEstimated: true } : {}),
          modalities: intersectModalities(found.map((entry) => entry.modalities).filter((value) => value != null)),
          reasoning: found.every((entry) => entry.reasoning),
          toolCall: found.every((entry) => entry.toolCall),
          webSearch: found.every((entry) => entry.webSearch),
          cost: commonCost(found.map((entry) => entry.cost)),
        });
      }
    }
    return out;
  }

  async getPublicModelDetail(
    targetId: string,
    tenantId: string | null,
    snapshot: ApiKeyAuthorizationSnapshot,
    modelPrefix?: string,
  ): Promise<AllowedModelEntry | undefined> {
    if (targetId.includes("/")) {
      const slashIndex = targetId.indexOf("/");
      const targetProvider = targetId.slice(0, slashIndex);
      const targetModel = targetId.slice(slashIndex + 1);
      const rows = await this.db
        .select({
          providerId: models.providerId,
          modelId: models.modelId,
          contextLimit: models.contextLimit,
          outputLimit: models.outputLimit,
          modalities: models.modalities,
          reasoning: models.reasoning,
          toolCall: models.toolCall,
          cost: models.cost,
        })
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            eq(models.enabled, true),
            eq(providers.enabled, true),
            eq(models.providerId, targetProvider),
            eq(models.modelId, targetModel),
          ),
        )
        .limit(1);
      const row = rows[0];
      // Same reduction as the listing path: `(prefix || allowed) && allowed`
      // is just `allowed`, and the prefix disjunct cost a redundant call.
      if (row && isModelAllowed(snapshot, row.modelId, row.providerId)) {
        const capabilities = normalizeModalities(row.modalities);
        return {
          id: `${row.providerId}/${row.modelId}`,
          object: "model" as const,
          created: Math.floor(Date.now() / 1000),
          owned_by: row.providerId,
          ...(row.contextLimit != null ? { context_length: row.contextLimit } : {}),
          ...(row.outputLimit != null ? { max_completion_tokens: row.outputLimit } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(row.reasoning ? { reasoning: true } : {}),
          ...(row.toolCall ? { tool_call: true } : {}),
          ...(row.cost != null ? { cost: row.cost } : {}),
        };
      }
      return undefined;
    }
    const data = await this.listPublicModels(tenantId, snapshot, modelPrefix);
    return data.find((m) => m.id === targetId);
  }
}
