// Drizzle-backed provider, model, and discovery catalog repository.
// Account-persistence methods live in `store-accounts.ts` and the health /
// bulk-action methods in `store-operations.ts`; both are plain function
// modules over the shared `StoreAccountContext` built below.
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { ConsoleDomainError } from "../../shared/errors";
import { parseCustomProviderId, isBundledProviderId } from "../../../providers/provider-contracts";
import type { ModelDefinition } from "../../../providers/provider-model-definition";
import type { ProviderRegistry } from "../../../providers/provider-registry";
import { BUNDLED_PROVIDER_MODULES } from "../../../providers/default-registry";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { models, providers, tenantDisabledModels } from "../../../persistence/schema";
import type { WireFamily } from "../../../protocol/canonical-model";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { RedisClient } from "../../../persistence/redis";
import { bumpCatalogRevision, type BundledProviderCatalog } from "../../../providers/operations/provider-catalog-service";
import type { AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import type { AccountInflightReading, BuddyGrowthTaskLedgerEntry, ByokConnectionTestRequest, ByokConnectionTestResult, CreateProviderAccountBatchResult, CreateProviderAccountRequest, DiscoverModelCandidate, ModelCatalogEntry, OwnedProviderAccountRef, ProbeAllAccountsResult, ProbeAllModelsResult, ProbeModelRequest, ProbeModelResult, ProviderAccountBulkActionResult, ProviderAccountResponse, ProviderCatalogStore, ProviderRecord, SetModelEnabledRequest, UpdateModelMetadataRequest, UpdateProviderAccountRequest, ModelMetadataOverride } from "./contracts";
import { isServiceKind, validateCompatibilityProfile } from "./contracts";
import { ProviderProbingService, type ProbeOutboundResolver } from "../../../providers/discovery/probing-service";
import {
  applyModelMetadataOverride,
  resolveManualModelMetadata,
} from "../../../providers/provider-model-definition";
import { DEFAULT_ENDPOINT_BY_WIRE_FAMILY, endpointPathForProviderModel, mapProviderRow } from "./catalog-projections";
import { asStoredText, mapModelRow, withImageModality } from "./store-helpers";
import type { StoreAccountContext, StoreOperationsContext } from "./store-account-types";
import {
  createAccountBatch,
  createAccountRow,
  getOwnedAccount,
  listAccountAuthStates,
  listAccountIds,
  listAccounts,
  listAllAccountSummaries,
  listAllAccounts,
  ownsAccount as ownsAccountRow,
  providerAccountCounts,
  providerModelCounts,
  reorderAccounts,
  updateAccountRow,
} from "./store-accounts";
import {
  deleteBannedRow,
  disableCooldownsRow,
  listAccountHealthEventsRow,
  listBuddyGrowthTasksRow,
  purgeAccountHealthEventsRow,
  recoverAccountRow,
} from "./store-operations";

export {
  accountLabelKindSegment,
  mapModelRow,
  nextGeneratedAccountLabel,
  withImageModality,
} from "./store-helpers";

export class DrizzleProviderCatalogStore implements ProviderCatalogStore {
  private readonly probing: ProviderProbingService;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly providerRegistry: ProviderRegistry;

  private readonly readAccountInflight:
    | ((
        providerId: string,
        tenantId: string,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;

  private readonly redis: RedisClient | undefined;

  constructor(
    private readonly db: CartethyiaDatabase,
    options: {
      readonly telemetryBuffer: TelemetryBatchBuffer;
      readonly bundledModelCatalog: BundledProviderCatalog;
      readonly providerRegistry: ProviderRegistry;
      readonly outboundFetchFor: ProbeOutboundResolver;
      readonly snapshotInvalidator: { invalidate(): unknown };
      readonly readAccountInflight?:
        | ((
            providerId: string,
            tenantId: string,
          ) => Promise<readonly AccountInflightReading[]>)
        | undefined;
      /** Shared Redis handle for quota-cache invalidation on bulk delete. */
      readonly redis?: RedisClient | undefined;
    },
  ) {
    this.bundledModelCatalog = options.bundledModelCatalog.modelsByProvider;
    this.providerRegistry = options.providerRegistry;
    this.readAccountInflight = options.readAccountInflight;
    this.redis = options.redis;
    this.probing = new ProviderProbingService({
      db,
      telemetryBuffer: options.telemetryBuffer,
      defaultEndpoints: DEFAULT_ENDPOINT_BY_WIRE_FAMILY,
      bundledModelCatalog: this.bundledModelCatalog,
      outboundFetchFor: options.outboundFetchFor,
      snapshotInvalidator: options.snapshotInvalidator,
      providerRegistry: options.providerRegistry,
    });
  }

  /** Context handed to the account-persistence module (`store-accounts.ts`). */
  private get accountCtx(): StoreAccountContext {
    return { db: this.db, readAccountInflight: this.readAccountInflight };
  }

  /** Context handed to the health/bulk-action module (`store-operations.ts`). */
  private get operationsCtx(): StoreOperationsContext {
    return {
      db: this.db,
      redis: this.redis,
      readAccountInflight: this.readAccountInflight,
      ownsAccount: (tenantId, providerId, accountId) =>
        ownsAccountRow(this.accountCtx, tenantId, providerId, accountId),
    };
  }
  async list(tenantId: string): Promise<readonly ProviderRecord[]> {
    const bundledIds = BUNDLED_PROVIDER_MODULES.map((provider) => provider.id);
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        and(
          globalOrOwnedBy(providers.tenantId, tenantId),
          or(inArray(providers.id, bundledIds), eq(providers.tenantId, tenantId)),
        ),
      )
      .orderBy(asc(providers.id));
    return rows.map((row) => mapProviderRow(row, this.providerRegistry));
  }
  async get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined> {
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        and(
          eq(providers.id, providerId),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }
  async create(record: ProviderRecord): Promise<void> {
    if (isBundledProviderId(record.providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be created",
      );
    parseCustomProviderId(record.providerId);
    if (record.compatibilityProfile) validateCompatibilityProfile(record.compatibilityProfile);
    await this.db.insert(providers).values({
      id: record.providerId,
      tenantId: record.tenantId ?? null,
      enabled: record.enabled,
      ...(record.wireFamilyDefault ? { wireFamilyDefault: record.wireFamilyDefault } : {}),
      capabilityProfile: record.capabilityProfile ?? null,
      baseUrl: record.baseUrl ?? null,
      compatibilityProfile: record.compatibilityProfile ?? null,
    });
  }
  async update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be updated",
      );
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined)
      set.compatibilityProfile = patch.compatibilityProfile;
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            )
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            );
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }
  async delete(tenantId: string, providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    // Custom-provider rows own their models, accounts, disabled-model flags,
    // and routing preferences: deleting the parent cascades all of them
    // (models/provider_accounts/provider_oauth_states via provider FK,
    // health_events via account FK, tenant_disabled_models and
    // provider_routing_settings via provider FK) in one atomic DELETE.
    const deleted = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), ownedByOnly(providers.tenantId, tenantId)))
      .returning({ id: providers.id });
    if (deleted.length === 0) return false;
    this.providerRegistry.unregister(providerId);
    // The provider left the registry, so the compiled catalog is now missing it
    // — the snapshot's re-seed is gated on that revision, and a delete that did
    // not bump it would leave the provider's model rows behind.
    bumpCatalogRevision();
    return true;
  }
  async updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    const isBuiltin = isBundledProviderId(providerId);
    if (isBuiltin && Object.keys(patch).some((field) => field !== "enabled")) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in providers only support enable/disable",
      );
    }
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined) {
      set.compatibilityProfile = patch.compatibilityProfile;
    }
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)));
    const row = rows[0];
    return row ? mapProviderRow(row, this.providerRegistry) : undefined;
  }

  async deleteGlobal(providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId)) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    }
    const rows = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
      .returning({ id: providers.id });
    return rows.length > 0;
  }
  async listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]> {
    const byProvider = await this.listModelsForTenant(tenantId, providerId);
    return byProvider.get(providerId) ?? [];
  }

  /**
   * Every enabled-and-disabled model row the tenant can see, grouped by
   * provider. One pair of statements for the whole tenant instead of a pair per
   * provider.
   *
   * The per-provider `listModels` shape costs two queries per call, so a caller
   * that needs every provider's models — the flat catalog the picker renders —
   * issued `2 * providers + 2` statements, growing with the bundled catalog.
   * Grouping here makes it constant: one disabled-model read and one models
   * join, regardless of provider count. `providerId` narrows it to a single
   * provider for callers that already know which one they want.
   */
  async listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>> {
    const disabled = await this.db
      .select({
        providerId: tenantDisabledModels.providerId,
        modelId: tenantDisabledModels.modelId,
        endpointPath: tenantDisabledModels.endpointPath,
      })
      .from(tenantDisabledModels)
      .where(
        providerId === undefined
          ? eq(tenantDisabledModels.tenantId, tenantId)
          : and(
              eq(tenantDisabledModels.tenantId, tenantId),
              eq(tenantDisabledModels.providerId, providerId),
            ),
      );
    const disabledKeys = new Set(
      disabled.map((d) => `${d.providerId}::${d.modelId}::${d.endpointPath}`),
    );
    const dbRows = await this.db
      .select({ model: models })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          ...(providerId === undefined ? [] : [eq(models.providerId, providerId)]),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      );
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const { model: row } of dbRows) {
      const isDisabled = disabledKeys.has(
        `${row.providerId}::${row.modelId}::${row.endpointPath}`,
      );
      const list = grouped.get(row.providerId) ?? [];
      list.push(mapModelRow(row, isDisabled));
      grouped.set(row.providerId, list);
    }
    return grouped;
  }
  async registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
    metadata?: ModelMetadataOverride,
  ): Promise<void> {
    const owner = await this.db
      .select({
        id: providers.id,
        baseUrl: providers.baseUrl,
        compatibilityProfile: providers.compatibilityProfile,
      })
      .from(providers)
      .where(and(eq(providers.id, providerId), globalOrOwnedBy(providers.tenantId, tenantId)))
      .limit(1);
    if (!owner[0]) {
      throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
    }
    const family = (wireFamily ?? "chat") as WireFamily;
    // Static endpoint from the provider's own bundled catalog via the probing
    // service (the same startup-built map this store is constructed with).
    // Without this, bundled providers on versioned bases (cline) get the
    // generic `/v1/…` default, which joins into an unreachable path and every
    // probe/dispatch 404s.
    const staticEndpoint = await this.probing.resolveStaticEndpoint(providerId, family);
    const endpointPath = endpointPathForProviderModel(
      family,
      owner[0].compatibilityProfile,
      staticEndpoint === undefined ? undefined : { [family]: staticEndpoint },
    );
    if (modelIds.length === 0) return;
    // Single multi-row insert and upsert of the capability flags so a
    // re-registration repairs a row whose `tool_call` (and `reasoning`) was
    // seeded false — a manual add persists schema defaults, which capability
    // preflight reads as "route cannot use tools" and silently strips `tools`
    // from every request. `enabled` stays operator-owned; `source` is refreshed
    // to `manual`.
    await this.db
      .insert(models)
      .values(
        modelIds.map((modelId) => ({
          providerId,
          modelId,
          wireFamily: family,
          endpointPath,
          ...applyModelMetadataOverride(
            resolveManualModelMetadata(providerId, modelId),
            metadata,
          ),
          source: "manual",
          sourceUpdatedAt: new Date(),
          enabled: true,
        })),
      )
      .onConflictDoUpdate({
        target: [models.providerId, models.modelId, models.endpointPath],
        set: {
          wireFamily: sql`excluded.wire_family`,
          contextLimit: sql`excluded.context_limit`,
          outputLimit: sql`excluded.output_limit`,
          modalities: sql`excluded.modalities`,
          reasoning: sql`excluded.reasoning`,
          toolCall: sql`excluded.tool_call`,
          source: sql`'manual'`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
        },
      });
  }

  /**
   * One-shot connectivity probe and model discovery live in
   * `services/provider-probing.ts` — the store only forwards so the domain
   * `ProviderCatalogStore` interface is unchanged.
   */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    return this.probing.probeModel(tenantId, providerId, request);
  }

  /** Ad-hoc BYOK connectivity test; delegates to the shared probing service. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return this.probing.testByokConnection(tenantId, request);
  }

  /**
   * Batched provider-wide probe: the first registered model runs sequentially
   * (warms OAuth token / connection pools), the rest run concurrently bounded
   * to 5. Registered model ids come from this store's own catalog read.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    mode?: ProbeModelRequest["mode"],
  ): Promise<ProbeAllModelsResult> {
    const entries = await this.listModels(tenantId, providerId);
    const requests = entries.map((entry) => ({
      modelId: entry.modelId,
      route: entry.route,
      serviceKind: isServiceKind(entry.serviceKind) ? entry.serviceKind : ("llm" as const),
      ...(mode === undefined ? {} : { mode }),
    }));
    const seenRequestKeys = new Set<string>();
    const uniqueRequests = requests.filter((request) => {
      const key = `${request.modelId}\u0000${request.route}\u0000${request.serviceKind}`;
      if (seenRequestKeys.has(key)) return false;
      seenRequestKeys.add(key);
      return true;
    });
    return this.probing.probeAllModels(tenantId, providerId, uniqueRequests);
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
): Promise<ProbeAllAccountsResult> {
    return this.probing.probeAllAccounts(tenantId, providerId, request);
  }
  /** Toggles a persisted model's routing eligibility. */
  async setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    // Tenant-owned (BYOK) model: toggle the shared row directly.
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const ownedTarget = owned[0];
    if (ownedTarget) {
      await this.db
        .update(models)
        .set({ enabled: request.enabled })
        .where(eq(models.id, ownedTarget.id));
      return true;
    }

    // Global/built-in model: tenants cannot mutate the shared row, so record
    // (or clear) a tenant-scoped disable in `tenantDisabledModels`.
    const global = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (global[0] === undefined) return false;
    if (request.enabled) {
      await this.db
        .delete(tenantDisabledModels)
        .where(
          and(
            eq(tenantDisabledModels.tenantId, tenantId),
            eq(tenantDisabledModels.providerId, providerId),
            eq(tenantDisabledModels.modelId, request.modelId),
            eq(tenantDisabledModels.endpointPath, request.route),
          ),
        );
      return true;
    }
    await this.db
      .insert(tenantDisabledModels)
      .values({
        tenantId,
        providerId,
        modelId: request.modelId,
        endpointPath: request.route,
      })
      .onConflictDoNothing({
        target: [
          tenantDisabledModels.tenantId,
          tenantDisabledModels.providerId,
          tenantDisabledModels.modelId,
          tenantDisabledModels.endpointPath,
        ],
      });
    return true;
  }

  /**
   * Updates one model's limits and capability flags.
   *
   * Two row kinds are writable. A tenant-owned (BYOK) row is updated directly.
   * A model belonging to a *global* provider row is also updated directly:
   * bundled providers are seeded once with `tenant_id IS NULL` and `providers.id`
   * is the primary key, so a bundled provider can only ever have that one row —
   * there is no tenant-scoped row to edit instead. Auto-fetched rows
   * (`discovered` / `auto_free`) live on exactly those providers, which is why
   * the previous `ownedByOnly` filter answered `not_found` for every model the
   * operator had just fetched and could not be edited at all.
   *
   * A global `builtin` row is rejected: it is re-seeded from the bundle on every
   * boot, so an edit there would be silently reverted, and `deleteModel` refuses
   * it for the same reason.
   *
   * Absent override fields leave the stored value untouched — an edit that only
   * sets the context ceiling must not reset the capability flags.
   */
  async updateModelMetadata(
    tenantId: string,
    providerId: string,
    request: UpdateModelMetadataRequest,
  ): Promise<boolean> {
    const findRow = (ownership: SQL) =>
      this.db
        .select({ id: models.id, modalities: models.modalities, source: models.source })
        // source is read for both the global builtin guard above and the new
        // non-builtin-only warning edit.
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            eq(models.providerId, providerId),
            eq(models.modelId, request.modelId),
            eq(models.endpointPath, request.route),
            ownership,
          ),
        )
        .limit(1);
    const owned = await findRow(ownedByOnly(providers.tenantId, tenantId));
    let row = owned[0];
    if (row === undefined) {
      const global = await findRow(isNull(providers.tenantId));
      const candidate = global[0];
      if (candidate === undefined) return false;
      if (candidate.source === "builtin") {
        throw new ConsoleDomainError(
          "builtin_model_immutable",
          403,
          `Built-in model ${providerId}/${request.modelId} cannot be edited — the bundle re-seeds it on every boot`,
        );
      }
      row = candidate;
    }

    const override = request.metadata;
    const set: Record<string, unknown> = { sourceUpdatedAt: new Date() };
    if (override?.contextLimit !== undefined) set.contextLimit = override.contextLimit;
    if (override?.outputLimit !== undefined) set.outputLimit = override.outputLimit;
    // Passthrough grants every capability and cannot be partly revoked by a
    // per-flag field: the point of the flag is that the operator does not know
    // which capabilities the model has, so an explicit `false` alongside it is
    // either stale or a mistake.
    // Builtin rows are re-seeded from the static catalog on every boot, so a
    // warning edit there would be reverted. Non-builtin rows (including ones a
    // discovery commit created) are operator-owned and may set or clear them.
    if (override?.warnings !== undefined) {
      if (row.source === "builtin") {
        throw new ConsoleDomainError(
          "builtin_model_immutable",
          403,
          `Built-in model ${providerId}/${request.modelId} warnings cannot be edited — the bundle re-seeds them on every boot`,
        );
      }
      set.warningMetadata =
        override.warnings === null
          ? null
          : {
              warnings: override.warnings.map((warning) => ({
                kind: warning.kind,
                message: warning.message,
                ...(warning.severity === undefined ? {} : { severity: warning.severity }),
                ...(warning.updatedAt === undefined ? {} : { updatedAt: warning.updatedAt }),
              })),
            };
    }
    if (override?.passthrough === true) {
      set.reasoning = true;
      set.toolCall = true;
      set.modalities = withImageModality(asStoredText(row.modalities), true);
    } else {
      if (override?.reasoning !== undefined) set.reasoning = override.reasoning;
      if (override?.toolCall !== undefined) set.toolCall = override.toolCall;
      if (override?.image !== undefined)
        set.modalities = withImageModality(asStoredText(row.modalities), override.image);
    }
    await this.db.update(models).set(set).where(eq(models.id, row.id));
    return true;
  }

  async deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const target = owned[0];
    if (target) {
      const rows = await this.db
        .delete(models)
        .where(eq(models.id, target.id))
        .returning({ id: models.id });
      return rows.length > 0;
    }
    const global = await this.db
      .select({ id: models.id, source: models.source })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (!global[0]) return false;
    // Built-in models are immutable catalog: tenants can only disable them
    // (via tenantDisabledModels), never delete the shared row.
    if (global[0].source === "builtin") {
      throw new ConsoleDomainError(
        "builtin_model_immutable",
        403,
        `Built-in model ${providerId}/${request.modelId} cannot be deleted — disable it instead`,
      );
    }
    const rows = await this.db
      .delete(models)
      .where(eq(models.id, global[0].id))
      .returning({ id: models.id });
    await this.db
      .delete(tenantDisabledModels)
      .where(
        and(
          eq(tenantDisabledModels.tenantId, tenantId),
          eq(tenantDisabledModels.providerId, providerId),
          eq(tenantDisabledModels.modelId, request.modelId),
          eq(tenantDisabledModels.endpointPath, request.route),
        ),
      );
    return rows.length > 0;
  }

  async reorderAccounts(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    return reorderAccounts(this.accountCtx, tenantId, providerId, accountIds);
  }

  async listAccountAuthStates(
    tenantId: string,
    providerId: string,
    accountIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
    return listAccountAuthStates(this.accountCtx, tenantId, providerId, accountIds);
  }

  async listAccounts(
    tenantId: string,
    providerId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    return listAccounts(this.accountCtx, tenantId, providerId);
  }

  async listAccountIds(
    tenantId: string,
    providerId: string,
  ): Promise<readonly string[]> {
    return listAccountIds(this.accountCtx, tenantId, providerId);
  }

  async ownsAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return ownsAccountRow(this.accountCtx, tenantId, providerId, accountId);
  }

  async getOwnedAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<OwnedProviderAccountRef | undefined> {
    return getOwnedAccount(this.accountCtx, tenantId, providerId, accountId);
  }

  async listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]> {
    return listAllAccounts(this.accountCtx, tenantId);
  }

  async listAllAccountSummaries(
    tenantId: string,
  ): Promise<readonly { providerId: string; status: string }[]> {
    return listAllAccountSummaries(this.accountCtx, tenantId);
  }

  async providerAccountCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; total: number; active: number }[]> {
    return providerAccountCounts(this.accountCtx, tenantId);
  }

  async providerModelCounts(
    tenantId: string,
  ): Promise<readonly { providerId: string; count: number }[]> {
    return providerModelCounts(this.accountCtx, tenantId);
  }

  async createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
  ): Promise<ProviderAccountResponse> {
    return createAccountRow(this.accountCtx, tenantId, providerId, request);
  }

  async createAccountBatch(
    tenantId: string,
    providerId: string,
    requests: readonly CreateProviderAccountRequest[],
  ): Promise<CreateProviderAccountBatchResult> {
    return createAccountBatch(this.accountCtx, tenantId, providerId, requests);
  }

  async updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined> {
    return updateAccountRow(this.accountCtx, tenantId, providerId, accountId, patch);
  }

  async listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]> {
    return listAccountHealthEventsRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async purgeAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<number> {
    return purgeAccountHealthEventsRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async listBuddyGrowthTasks(
    tenantId: string,
    providerId: string,
    accountId: string,
    dayKey: string,
  ): Promise<readonly BuddyGrowthTaskLedgerEntry[]> {
    return listBuddyGrowthTasksRow(this.operationsCtx, tenantId, providerId, accountId, dayKey);
  }

  async recoverAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return recoverAccountRow(this.operationsCtx, tenantId, providerId, accountId);
  }

  async disableCooldowns(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    return disableCooldownsRow(this.operationsCtx, tenantId, providerId);
  }

  async deleteBanned(
    tenantId: string,
    providerId: string,
  ): Promise<ProviderAccountBulkActionResult> {
    return deleteBannedRow(this.operationsCtx, tenantId, providerId);
  }

  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.probing.syncModels(tenantId, providerId);
  }

  /** Read-only discovery; delegates to the same fetch path as sync (area 05). */
  async listDiscoveryCandidates(
    tenantId: string,
    providerId: string,
  ): Promise<{
    readonly supported: boolean;
    readonly candidates: readonly DiscoverModelCandidate[];
    readonly accountLabel?: string;
  }> {
    const discovery = await this.probing.discoverModels(tenantId, providerId);
    if (!discovery.supported) return { supported: false, candidates: [] };
    const registered = await this.listModelsForTenant(tenantId, providerId);
    const ids = new Set(
      (registered.get(providerId) ?? []).map((entry) => entry.modelId),
    );
    // The picker exists to add models, so rows already on the roster are
    // excluded rather than listed disabled — a fully-registered catalog would
    // otherwise render an all-"Registered" list that reads as empty.
    const candidates: DiscoverModelCandidate[] = discovery.models
      .filter((definition) => !ids.has(definition.modelId))
      .map((definition) => ({
        modelId: definition.modelId,
        wireFamily: definition.wireFamily,
        serviceKind: definition.serviceKind ?? "llm",
        endpointPath: definition.endpointPath,
        contextLimit: definition.contextLimit,
        outputLimit: definition.outputLimit,
        modalities: definition.modalities,
        reasoning: definition.reasoning,
        toolCall: definition.toolCall,
        ...(definition.freeTier === undefined ? {} : { freeTier: definition.freeTier }),
        ...(definition.proOnly === undefined ? {} : { proOnly: definition.proOnly }),
        alreadyRegistered: false,
      }));
    return {
      supported: true,
      candidates,
      ...(discovery.accountLabel === undefined ? {} : { accountLabel: discovery.accountLabel }),
    };
  }

  /**
   * Re-runs discovery on the server, then persists only ids the fresh roster
   * actually advertised (D28/D29/D30/D31). This is the anti-forgery gate: a
   * caller cannot attach a hand-built metadata object to an arbitrary id.
   */
  async commitDiscoveredModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<{
    readonly committed: readonly string[];
    readonly skipped: readonly string[];
    readonly synced: number;
  }> {
    const discovery = await this.probing.discoverModels(tenantId, providerId);
    if (!discovery.supported) {
      throw new ConsoleDomainError(
        "model_discovery_unsupported",
        400,
        `${providerId} publishes no model-listing endpoint; add the model manually`,
      );
    }
    const byId = new Map(discovery.models.map((definition) => [definition.modelId, definition]));
    const wanted = [...new Set(modelIds)];
    const unknown = wanted.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new ConsoleDomainError(
        "invalid_request",
        400,
        `Models are no longer in the provider's listing: ${unknown.join(", ")}. Fetch the model list again 🪞`,
      );
    }
    const registered = await this.listModelsForTenant(tenantId, providerId);
    const existing = new Set(
      (registered.get(providerId) ?? []).map((entry) => entry.modelId),
    );
    const selected = wanted.filter((id) => !existing.has(id));
    const skipped = wanted.filter((id) => existing.has(id));
    if (selected.length === 0) return { committed: [], skipped, synced: 0 };
    const { synced } = await this.probing.commitDiscoveredModels(
      tenantId,
      providerId,
      selected,
    );
    return { committed: selected, skipped, synced };
  }
}
