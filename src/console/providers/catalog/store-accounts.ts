/**
 * Provider-account persistence for the catalog store: account rows, their
 * usage aggregates, pool-as-account projections, and credential writes.
 * Extracted from `store.ts`; every function takes the shared
 * `StoreAccountContext` the owning `DrizzleProviderCatalogStore` builds.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import { nextSortIndex, reorderSortIndex } from "../../../persistence/sort-order";
import { providerAccounts, providerOauthStates, providers, models, networkPools, providerPoolAccounts, telemetryEvents, telemetryUsageTotals, tenantDisabledModels } from "../../../persistence/schema";
import { IS_GATEWAY_ERROR_SQL } from "../../../observability/event-query";
import { providerRateLimitIsIpScoped } from "../../../providers/provider-metadata";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import { invalidateCredentialCache } from "../../../providers/operations/provider-credential-service";
import { isUniqueViolation } from "../../../persistence/boot";
import { ConsoleDomainError } from "../../shared/errors";
import { pushStructuredConsoleLog } from "../../../observability/log-ring";
import type {
  CreateProviderAccountBatchItemResult,
  CreateProviderAccountBatchResult,
  CreateProviderAccountRequest,
  CredentialMode,
  OwnedProviderAccountRef,
  ProviderAccountResponse,
  ProviderAccountTokenUsage,
  UpdateProviderAccountRequest,
} from "./contracts";
import type { DbOrTx, DbTx, ProviderAccountRow, StoreAccountContext } from "./store-account-types";
import {
  activePoolProviderCooldowns,
  emptyUsage,
  mapAccountRow,
  nextGeneratedAccountLabel,
  parseJwtCredential,
  parsePastedOAuthCredential,
  usageTotalsFromRow,
} from "./store-helpers";

/**
 * Today's per-account usage for a concrete id set. Scoped to those ids so
 * the `(tenant, account, created_at)` index serves the range instead of a
 * full-tenant window scan; returns exactly one group per account with
 * traffic, so an account is never lost to a top-N cap.
 */
async function accountTodayUsage(
  ctx: StoreAccountContext,
  tenantId: string,
  accountIds: readonly string[],
): Promise<
  Array<{ key: string; requests: number; errors: number; inputTokens: number; outputTokens: number }>
> {
  if (accountIds.length === 0) return [];
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rows = await ctx.db
    .select({
      accountId: telemetryEvents.accountId,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
    })
    .from(telemetryEvents)
    .where(
      and(
        eq(telemetryEvents.tenantId, tenantId),
        gte(telemetryEvents.createdAt, todayStart),
        inArray(telemetryEvents.accountId, accountIds),
      ),
    )
    .groupBy(telemetryEvents.accountId);
  return rows.flatMap((row) => {
    if (row.accountId === null) return [];
    return [
      {
        key: row.accountId,
        requests: Number(row.requests),
        errors: Number(row.errors),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
      },
    ];
  });
}

async function accountInflightFor(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string | undefined,
): Promise<Map<string, number>> {
  const readings = new Map<string, number>();
  if (!ctx.readAccountInflight || !providerId) return readings;
  const rows = await ctx.readAccountInflight(providerId, tenantId);
  for (const row of rows) {
    if (typeof row.accountId !== "string" || !Number.isFinite(row.inflight)) continue;
    readings.set(row.accountId, Math.max(0, Math.floor(row.inflight)));
  }
  return readings;
}

/**
 * Labels already in use for one provider, for numbering a generated name.
 *
 * Scoped to this provider and tenant: `dcint-key-1` and `other-key-1` belong
 * to different providers and must not collide with each other.
 *
 * `labelCache` lets a batch create share one read across its items: inside
 * the batch transaction every insert is visible to the next item's select,
 * so the first read already sees the labels the batch itself wrote — the
 * cache only saves the repeated scan, never changes the answer. Keyed by
 * `providerId` because one batch is one provider/tenant pair.
 */
async function generateAccountLabel(
  db: DbOrTx,
  providerId: string,
  tenantId: string,
  credentialMode: CredentialMode,
  labelCache?: Map<string, readonly string[]>,
): Promise<string> {
  let labels = labelCache?.get(providerId);
  if (labels === undefined) {
    const rows = await db
      .select({ label: providerAccounts.label })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      );
    labels = rows
      .map((row) => row.label)
      .filter((label): label is string => typeof label === "string");
    labelCache?.set(providerId, labels);
  }
  return nextGeneratedAccountLabel(providerId, credentialMode, labels);
}

/**
 * Next free list position for a new account in this provider's list.
 *
 * Scoped to (provider, tenant) because the list is per provider: a tenant
 * with accounts under two providers must not have the second provider's
 * first account land at a high index.
 */
async function nextAccountSortIndex(
  db: DbOrTx,
  providerId: string,
  tenantId: string,
): Promise<number> {
  return nextSortIndex(
    db,
    { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
    and(
      eq(providerAccounts.providerId, providerId),
      globalOrOwnedBy(providerAccounts.tenantId, tenantId),
    ),
  );
}

/**
 * Account rows plus their usage aggregates. One today-window GROUP BY and one
 * lifetime `telemetry_usage_totals` read serve the whole page; per-account
 * reads would scale with the account count.
 */
export async function accountsWithUsage(
  ctx: StoreAccountContext,
  tenantId: string,
  rows: readonly ProviderAccountRow[],
): Promise<readonly ProviderAccountResponse[]> {
  if (rows.length === 0) return [];
  const accountIds = rows.map((row) => row.id);
  // Today's per-account usage is one GROUP BY, not a read of every event
  // since midnight. The read is scoped to the accounts on this page via the
  // `(tenant, account, created_at)` index — a full-tenant breakdown scanned
  // every of today's events and capped at 100 groups, so an account past
  // the cap silently read as "no usage today".
  const todayGroups = await accountTodayUsage(ctx, tenantId, accountIds);
  const todayByAccount = new Map(
    todayGroups.map((group) => [
      group.key,
      {
        requests: group.requests,
        errors: group.errors,
        inputTokens: group.inputTokens,
        outputTokens: group.outputTokens,
      },
    ]),
  );
  const [lifetimeRows] = await Promise.all([
    ctx.db
      .select()
      .from(telemetryUsageTotals)
      .where(
        and(
          eq(telemetryUsageTotals.tenantId, tenantId),
          eq(telemetryUsageTotals.identityType, "account"),
          inArray(telemetryUsageTotals.entityId, accountIds),
        ),
      ),
  ]);
  const lifetimeByAccount = new Map(lifetimeRows.map((row) => [row.entityId, row]));
  const first = rows[0];
  const inflightByAccount = await accountInflightFor(ctx, tenantId, first?.providerId);
  return rows.map((row) => {
    const inflight = inflightByAccount.get(row.id);
    return mapAccountRow(row, {
      today: usageTotalsFromRow(todayByAccount.get(row.id)),
      allTime: usageTotalsFromRow(lifetimeByAccount.get(row.id)),
      ...(inflight === undefined ? {} : { inflight }),
    });
  });
}

/** Rewrites one provider's account order; `accountIds` is the full order. */
export async function reorderAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountIds: readonly string[],
): Promise<void> {
  await reorderSortIndex(
    ctx.db,
    { table: providerAccounts, idColumn: providerAccounts.id, sortIndexColumn: providerAccounts.sortIndex },
    and(
      eq(providerAccounts.providerId, providerId),
      globalOrOwnedBy(providerAccounts.tenantId, tenantId),
    ),
    accountIds,
  );
}

export async function listAccountAuthStates(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountIds: readonly string[],
): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
  if (accountIds.length === 0) return {};
  const rows = await ctx.db
    .select({ id: providerAccounts.id, authState: providerAccounts.authState })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        inArray(providerAccounts.id, accountIds),
      ),
    );
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const row of rows) {
    if (row.authState !== null && typeof row.authState === "object" && !Array.isArray(row.authState)) {
      out[row.id] = row.authState as Record<string, unknown>;
    }
  }
  return out;
}

export async function listAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
): Promise<readonly ProviderAccountResponse[]> {
  const rows = await ctx.db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
    )
    // Stable list position, not `created_at`: two accounts created in the
    // same millisecond could swap between loads. `id` breaks a tie so the
    // order is total even before a reorder assigns distinct indices.
    .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt), asc(providerAccounts.id));
  const accounts = await accountsWithUsage(ctx, tenantId, rows);
  const poolAccounts = await listPoolAccounts(ctx, tenantId, providerId);
  if (poolAccounts.length === 0) return accounts;
  // Pool-as-account rows are appended after real accounts. They are
  // account *equivalents* for ip-scoped, credential-less providers, so the
  // operator sees the egresses that carry those providers' rate limits in
  // the same list that already explains health.
  return [...accounts, ...poolAccounts];
}

/**
 * One cheap id-only read of an account set, for callers that need the set
 * (e.g. the routing-inflight reader) without the usage aggregates
 * `listAccounts` computes (P-02). No ORDER BY: the set is order-insensitive.
 */
export async function listAccountIds(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
): Promise<readonly string[]> {
  const rows = await ctx.db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * One id-only ownership probe for routes that delegate to a narrower store
 * call afterwards. `globalOrOwnedBy` admits shared rows exactly like the
 * health-event/buddy-growth/recover preludes this replaces — the catalog's
 * visibility rule is "tenant-owned or global", not owned-only.
 */
export async function ownsAccount(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.id, accountId),
        eq(providerAccounts.providerId, providerId),
        globalOrOwnedBy(providerAccounts.tenantId, tenantId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The owned-only counterpart: `tenant_id` must equal the caller's tenant, so
 * a shared/global account is never matched. Used where the operation must
 * not act on a global row (the token-refresh admission check).
 */
export async function getOwnedAccount(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<OwnedProviderAccountRef | undefined> {
  const rows = await ctx.db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      tenantId: providerAccounts.tenantId,
      credentialKind: providerAccounts.credentialKind,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.id, accountId),
        eq(providerAccounts.providerId, providerId),
        ownedByOnly(providerAccounts.tenantId, tenantId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        providerId: row.providerId,
        tenantId: row.tenantId,
        credentialKind: row.credentialKind,
        staticToken: row.staticToken,
      };
}

export async function listAllAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly ProviderAccountResponse[]> {
  const rows = await ctx.db
    .select()
    .from(providerAccounts)
    .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
    .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt), asc(providerAccounts.id));
  const accounts = await accountsWithUsage(ctx, tenantId, rows);
  const poolAccounts = await listAllPoolAccounts(ctx, tenantId);
  if (poolAccounts.length === 0) return accounts;
  return [...accounts, ...poolAccounts];
}

export async function listAllAccountSummaries(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; status: string }[]> {
  const rows = await ctx.db
    .select({ providerId: providerAccounts.providerId, status: providerAccounts.status })
    .from(providerAccounts)
    .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId));
  return rows.map((row) => ({ providerId: row.providerId, status: row.status }));
}

/**
 * Per-provider account totals for one tenant, from a single grouped read (one
 * statement, served by the `(provider_id, tenant_id)` index). `active` counts
 * every status except `disabled` — an account parked by the health machine
 * (`cooldown`) is still a connection, matching how the account-overview badge
 * reads status. Used by the provider list overview (`accountCount` /
 * `activeAccountCount`); totals are never counted in a per-provider loop.
 */
export async function providerAccountCounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; total: number; active: number }[]> {
  const rows = await ctx.db
    .select({
      providerId: providerAccounts.providerId,
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when ${providerAccounts.status} <> 'disabled' then 1 else 0 end)`,
    })
    .from(providerAccounts)
    .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
    .groupBy(providerAccounts.providerId);
  return rows.map((row) => ({
    providerId: row.providerId,
    total: Number(row.total),
    active: Number(row.active),
  }));
}

/**
 * Per-provider enabled model-row counts for one tenant, from a single grouped
 * read over `models ⋈ providers`. A model counts only when the row is enabled
 * and the tenant has not suppressed it via `tenant_disabled_models` — the
 * same visibility rule the per-provider model listing applies, so the
 * overview badge never disagrees with what the detail page would list.
 */
export async function providerModelCounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly { providerId: string; count: number }[]> {
  const rows = await ctx.db
    .select({ providerId: models.providerId, count: sql<number>`count(*)` })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .leftJoin(
      tenantDisabledModels,
      and(
        eq(tenantDisabledModels.tenantId, tenantId),
        eq(tenantDisabledModels.providerId, models.providerId),
        eq(tenantDisabledModels.modelId, models.modelId),
        eq(tenantDisabledModels.endpointPath, models.endpointPath),
      ),
    )
    .where(
      and(
        eq(models.enabled, true),
        globalOrOwnedBy(providers.tenantId, tenantId),
        isNull(tenantDisabledModels.id),
      ),
    )
    .groupBy(models.providerId);
  return rows.map((row) => ({ providerId: row.providerId, count: Number(row.count) }));
}

/**
 * Pool-as-account rows for one provider. Only providers whose rate limit
 * follows the egress address materialize these; every other provider's pool
 * list stays empty, so real accounts are returned unchanged.
 *
 * The pool row is the source of health truth: `provider_pool_accounts`
 * rows are created at backfill and never mutated, so the surface reads the
 * owning pool's live status/last-* fields and lives on top of them.
 */
async function listPoolAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
): Promise<readonly ProviderAccountResponse[]> {
  if (!providerRateLimitIsIpScoped(providerId)) return [];
  const rows = await ctx.db
    .select()
    .from(providerPoolAccounts)
    .where(
      and(
        eq(providerPoolAccounts.providerId, providerId),
        eq(providerPoolAccounts.tenantId, tenantId),
      ),
    )
    .orderBy(asc(providerPoolAccounts.createdAt), asc(providerPoolAccounts.id));
  if (rows.length === 0) return [];
  const pools = await poolsById(ctx, tenantId, rows.map((row) => row.networkPoolId));
  const usage = await poolUsage(ctx, tenantId, rows.map((row) => row.networkPoolId));
  return rows.map((row) => mapPoolAccountRow(row, pools.get(row.networkPoolId), usage.get(row.networkPoolId)));
}

/** Pool-as-account rows across every provider, for tenant-wide listings. */
async function listAllPoolAccounts(
  ctx: StoreAccountContext,
  tenantId: string,
): Promise<readonly ProviderAccountResponse[]> {
  const rows = await ctx.db
    .select()
    .from(providerPoolAccounts)
    .where(eq(providerPoolAccounts.tenantId, tenantId))
    .orderBy(asc(providerPoolAccounts.createdAt), asc(providerPoolAccounts.id));
  if (rows.length === 0) return [];
  const pools = await poolsById(ctx, tenantId, rows.map((row) => row.networkPoolId));
  const usage = await poolUsage(ctx, tenantId, rows.map((row) => row.networkPoolId));
  return rows.map((row) => mapPoolAccountRow(row, pools.get(row.networkPoolId), usage.get(row.networkPoolId)));
}

/** Selects the owning network pools for a set of pool-account rows. */
async function poolsById(
  ctx: StoreAccountContext,
  tenantId: string,
  poolIds: readonly string[],
): Promise<Map<string, typeof networkPools.$inferSelect>> {
  const map = new Map<string, typeof networkPools.$inferSelect>();
  if (poolIds.length === 0) return map;
  const rows = await ctx.db
    .select()
    .from(networkPools)
    .where(
      and(
        eq(networkPools.tenantId, tenantId),
        inArray(networkPools.id, poolIds),
      ),
    );
  for (const row of rows) map.set(row.id, row);
  return map;
}

/**
 * Today + lifetime token usage per pool, from telemetry. Pools carry no
 * rows in `telemetry_usage_totals` (that table only admits account/api_key
 * identity types), so lifetime here is aggregated from the retained event
 * window (the same bounded window the usage page reads) rather than from
 * durable rollups.
 */
async function poolUsage(
  ctx: StoreAccountContext,
  tenantId: string,
  poolIds: readonly string[],
): Promise<Map<string, { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage }>> {
  const map = new Map<string, { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage }>();
  if (poolIds.length === 0) return map;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const [todayRows, lifetimeRows] = await Promise.all([
    ctx.db
      .select({
        poolId: telemetryEvents.networkPoolId,
        requests: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
        inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      })
      .from(telemetryEvents)
      .where(
        and(
          eq(telemetryEvents.tenantId, tenantId),
          gte(telemetryEvents.createdAt, todayStart),
          inArray(telemetryEvents.networkPoolId, poolIds),
        ),
      )
      .groupBy(telemetryEvents.networkPoolId),
    ctx.db
      .select({
        poolId: telemetryEvents.networkPoolId,
        requests: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
        inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      })
      .from(telemetryEvents)
      .where(
        and(
          eq(telemetryEvents.tenantId, tenantId),
          inArray(telemetryEvents.networkPoolId, poolIds),
        ),
      )
      .groupBy(telemetryEvents.networkPoolId),
  ]);
  for (const id of poolIds) {
    const today = todayRows.find((row) => row.poolId === id);
    const lifetime = lifetimeRows.find((row) => row.poolId === id);
    map.set(id, {
      today: today ? usageTotalsFromRow(today) : emptyUsage,
      allTime: lifetime ? usageTotalsFromRow(lifetime) : emptyUsage,
    });
  }
  return map;
}

function mapPoolAccountRow(
  row: typeof providerPoolAccounts.$inferSelect,
  pool: typeof networkPools.$inferSelect | undefined,
  usage: { today: ProviderAccountTokenUsage; allTime: ProviderAccountTokenUsage } | undefined,
): ProviderAccountResponse {
  return {
    id: row.id,
    providerId: row.providerId,
    tenantId: row.tenantId,
    label: row.label,
    credentialKind: "none",
    // Health truth lives on the owning pool; fall back to the row only when
    // the pool row is unreachable (deleted cascade would have removed the
    // account row, so this is defensive).
    status: pool?.status ?? row.status,
    usageToday: usage?.today ?? emptyUsage,
    usageAllTime: usage?.allTime ?? emptyUsage,
    consecutiveFailures: pool?.consecutiveFailures ?? row.consecutiveFailures,
    ...(pool?.lastSuccessAt
      ? { lastSuccessAt: pool.lastSuccessAt.toISOString() }
      : row.lastSuccessAt
        ? { lastSuccessAt: row.lastSuccessAt.toISOString() }
        : {}),
    ...(pool?.lastError ? { lastError: pool.lastError } : row.lastError ? { lastError: row.lastError } : {}),
    ...(pool?.lastErrorCategory
      ? { lastErrorCategory: pool.lastErrorCategory }
      : row.lastErrorCategory
        ? { lastErrorCategory: row.lastErrorCategory }
        : {}),
    ...(pool?.lastErrorAt
      ? { lastErrorAt: pool.lastErrorAt.toISOString() }
      : row.lastErrorAt
        ? { lastErrorAt: row.lastErrorAt.toISOString() }
        : {}),
    ...(pool?.cooldownUntil
      ? { cooldownUntil: pool.cooldownUntil.toISOString() }
      : row.cooldownUntil
        ? { cooldownUntil: row.cooldownUntil.toISOString() }
        : {}),
    ...(pool?.lastRecoveredAt
      ? { lastRecoveredAt: pool.lastRecoveredAt.toISOString() }
      : row.lastRecoveredAt
        ? { lastRecoveredAt: row.lastRecoveredAt.toISOString() }
        : {}),
    createdAt: row.createdAt.toISOString(),
    sortIndex: 0,
    kind: "pool",
    networkPoolId: row.networkPoolId,
    ...(pool?.providerCooldowns
      ? { providerCooldowns: activePoolProviderCooldowns(pool.providerCooldowns) }
      : {}),
  };
}

export async function createAccountRow(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  request: CreateProviderAccountRequest,
  existingTx?: DbTx,
  includeUsage = true,
  sortIndexOverride?: number,
  /**
   * Batch-scoped label cache, threaded from `createAccountBatch`. Only the
   * batch path passes it; a lone create always reads fresh labels.
   */
  labelCache?: Map<string, readonly string[]>,
): Promise<ProviderAccountResponse> {
  // Callers inside an existing transaction pass it in so the account lands in
  // that unit of work (the batch path); otherwise this opens its own.
  const run = async (
    tx: DbTx,
  ): Promise<ProviderAccountResponse> => {
    let effectiveSecret = request.secret;
    let effectiveCredentialKind = request.credentialKind;
    const requestedCredentialMode: CredentialMode = request.credentialMode ?? "auto";
    let effectiveCredentialMode: CredentialMode = requestedCredentialMode;
    let tokenExpiresAt: Date | undefined;
    let jwtIssuer: string | undefined;
    let oauthRefreshCiphertext: Buffer | undefined;
    let oauthExpiresAt: Date | undefined;
    let oauthHasRefreshToken = false;
    let pastedAuthState: Readonly<Record<string, unknown>> = {};

    if (
      (request.credentialKind === "oauth" || request.credentialKind === "api_key") &&
      request.secret.trim().length > 0
    ) {
      const trimmed = request.secret.trim();
      const parts = parsePastedOAuthCredential(trimmed);
      pastedAuthState = parts.authState;
      const hasRefreshToken = parts.refreshToken !== parts.accessToken;
      const parsedJwt =
        requestedCredentialMode === "api_key"
          ? undefined
          : parseJwtCredential(parts.accessToken);
      if (requestedCredentialMode === "jwt" && parsedJwt === undefined) {
        throw new ConsoleDomainError(
          "invalid_request",
          400,
          "credentialMode jwt requires a valid three-part JWT",
        );
      }
      if (requestedCredentialMode === "api_key") {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = "api_key";
        effectiveCredentialMode = "api_key";
      } else if (
        parsedJwt !== undefined &&
        (requestedCredentialMode === "jwt" || !hasRefreshToken)
      ) {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = "api_key";
        effectiveCredentialMode = "jwt";
        tokenExpiresAt = parsedJwt.expiresAt;
        // Kept alongside the expiry: the console shows who issued a static
        // token, and the secret itself is never readable after this point.
        jwtIssuer = parsedJwt.issuer;
      } else if (request.credentialKind === "oauth" || hasRefreshToken) {
        effectiveSecret = parts.accessToken;
        effectiveCredentialKind = hasRefreshToken ? "oauth" : "api_key";
        effectiveCredentialMode = hasRefreshToken ? "auto" : "api_key";
        if (hasRefreshToken) {
          oauthRefreshCiphertext = encryptCredential(parts.refreshToken);
          oauthHasRefreshToken = true;
        }
        oauthExpiresAt = parts.expiresAt;
      } else {
        effectiveCredentialMode = "api_key";
      }
    }

    // Append to the end of this provider's list rather than relying on
    // creation time, so a new account never displaces existing positions.
    const credentialFingerprint =
      effectiveCredentialKind === "none" || effectiveSecret.length === 0
        ? undefined
        : hashSecret(effectiveSecret);
    const accountAuthState = {
      ...pastedAuthState,
      ...(request.authState ?? {}),
      credentialMode: effectiveCredentialMode,
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt: tokenExpiresAt.toISOString() }),
      ...(jwtIssuer === undefined ? {} : { jwtIssuer }),
    };
    const nextSortIndex =
      sortIndexOverride ?? (await nextAccountSortIndex(tx, providerId, tenantId));
    // Read existing labels only when one has to be generated: a named
    // account costs no extra query, and this is the path a large batch
    // paste walks once per row.
    const label =
      request.label ??
      (await generateAccountLabel(tx, providerId, tenantId, effectiveCredentialMode, labelCache));
    const rows = await tx
      .insert(providerAccounts)
      .values({
        providerId,
        tenantId,
        sortIndex: nextSortIndex,
        label,
        credentialCiphertext: encryptCredential(effectiveSecret),
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
        credentialKind: effectiveCredentialKind,
        status: "active",
        authState: accountAuthState,
        // An OAuth account pasted without a refresh token is a *static*
        // token: the pasted value is a bearer token used exactly as issued
        // and there is no refresh grant to run. Flag it as static so the
        // console reads it as an informational "static token" rather than
        // "re-login required" — the token is still valid and dispatchable —
        // and so the refresh sweep skips it instead of retrying a refresh
        // that can never succeed.
        ...(effectiveCredentialKind === "oauth" && !oauthHasRefreshToken || effectiveCredentialMode === "jwt"
          ? { staticToken: true }
          : {}),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("failed to create provider account");

    if (effectiveCredentialKind === "oauth") {
      await tx.insert(providerOauthStates).values({
        providerAccountId: row.id,
        ...(oauthRefreshCiphertext ? { refreshCiphertext: oauthRefreshCiphertext } : {}),
        expiresAt: oauthExpiresAt ?? null,
      });
    }
    if (request.credentialKind === "oauth" && !oauthHasRefreshToken) {
      pushStructuredConsoleLog(
        "info",
        "OAuth access token stored as a static API credential; it will not be refreshed",
        {
          event: "token_refresh",
          providerId,
          accountId: row.id,
          errorCode: "static_token",
        },
      );
    }

    if (!includeUsage) {
      return mapAccountRow(row, { today: emptyUsage, allTime: emptyUsage });
    }
    const [account] = await accountsWithUsage(ctx, tenantId, [row]);
    if (!account) throw new Error("created provider account could not be mapped");
    return account;
  };

  try {
    if (existingTx !== undefined) {
      return await run(existingTx);
    }
    return await ctx.db.transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleDomainError(
        "provider_account_duplicate",
        409,
        "A provider account with this credential already exists",
      );
    }
    throw error;
  }
}

/**
 * Creates many accounts in one round-trip.
 *
 * The whole batch shares one transaction, so a paste of 40 credentials costs
 * one connection checkout rather than 40. Each item is created through the
 * same `createAccount` path the single route uses — there is no second
 * implementation of credential detection to drift.
 *
 * Items are created sequentially inside that transaction: the unique
 * credential fingerprint makes two identical pastes collide, and a nested
 * transaction per item keeps that collision from aborting the whole batch.
 * Outcomes are reported per index, so a partial paste still lands the
 * accounts that were fine — an operator fixing one bad line should not have
 * to re-import 39.
 */
export async function createAccountBatch(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  requests: readonly CreateProviderAccountRequest[],
): Promise<CreateProviderAccountBatchResult> {
  if (requests.length === 0) {
    return { created: 0, failed: 0, results: [] };
  }
  const results: CreateProviderAccountBatchItemResult[] = [];
  let created = 0;
  let failed = 0;

  await ctx.db.transaction(async (tx) => {
    let nextSortIndex = await nextAccountSortIndex(tx, providerId, tenantId);
    // One label read for the whole batch: the first generated label scans
    // the provider's labels once, and every later item reuses that list —
    // inside the transaction the batch's own inserts are visible to the
    // scan anyway, so the cached list is exactly what a fresh read returns.
    const labelCache = new Map<string, readonly string[]>();
    for (const [index, request] of requests.entries()) {
      try {
        // A nested transaction acts as a savepoint: a duplicate-fingerprint
        // violation rolls back only this item, not the accounts before it.
        const account = await tx.transaction(async (inner) =>
          createAccountRow(ctx, tenantId, providerId, request, inner, false, nextSortIndex, labelCache),
        );
        created += 1;
        nextSortIndex += 1;
        results.push({ index, ok: true, ...(account ? { account } : {}) });
      } catch (error) {
        failed += 1;
        results.push({
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof ConsoleDomainError ? error.code : "create_failed",
        });
      }
    }
  });

  return { created, failed, results };
}

export async function updateAccountRow(
  ctx: StoreAccountContext,
  tenantId: string,
  providerId: string,
  accountId: string,
  patch: UpdateProviderAccountRequest,
): Promise<ProviderAccountResponse | undefined> {
  const set: Partial<typeof providerAccounts.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.secret !== undefined) {
    set.credentialCiphertext = encryptCredential(patch.secret);
    set.credentialFingerprint =
      patch.secret.length === 0 ? null : hashSecret(patch.secret);
  }
  if (patch.status !== undefined) set.status = patch.status;
  // Toggling the static-token flag: turning it on declares the credential is
  // used as issued and never refreshed, so any stale re-auth flag is cleared —
  // the operator has said the account is fine, and the pill must stop reading
  // "Re-login required". Turning it off returns the account to normal OAuth
  // refresh handling; the sweep picks it up again on its next pass.
  if (patch.staticToken !== undefined) {
    set.staticToken = patch.staticToken;
    if (patch.staticToken) {
      set.lastError = null;
      set.lastErrorCategory = null;
      set.lastErrorAt = null;
    }
  }
  // Status toggles are not recovery: preserve the health machine's evidence
  // until the operator uses Recover or replaces the rejected credential.
  const clearsFailureState = patch.secret !== undefined && patch.secret.length > 0;
  if (clearsFailureState) {
    set.consecutiveFailures = 0;
    set.cooldownUntil = null;
    set.modelCooldowns = {};
    set.lastError = null;
    set.lastErrorCategory = null;
    set.lastErrorAt = null;
  }
  const where = and(
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.providerId, providerId),
    globalOrOwnedBy(providerAccounts.tenantId, tenantId),
  );
  try {
    const rows =
      Object.keys(set).length > 0
        ? await ctx.db.update(providerAccounts).set(set).where(where).returning()
        : await ctx.db.select().from(providerAccounts).where(where);
    const row = rows[0];
    if (!row) return undefined;
    // Secret/status mutation: drop any cached credential so the next
    // attempt decrypts the new ciphertext (or refuses a disabled account).
    if (patch.secret !== undefined || patch.status !== undefined) {
      invalidateCredentialCache(accountId);
    }
    const [account] = await accountsWithUsage(ctx, tenantId, [row]);
    return account;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleDomainError(
        "provider_account_duplicate",
        409,
        "A provider account with this credential already exists",
      );
    }
    throw error;
  }
}

export { mapAccountRow };
