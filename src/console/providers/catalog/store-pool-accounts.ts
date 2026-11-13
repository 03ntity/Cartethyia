/**
 * Pool-as-account reads and projection for the catalog store: the egress
 * rows ip-scoped providers materialize as account equivalents, plus the
 * owning pool's live health fields and per-pool token usage. Extracted from
 * `store-accounts.ts`; every function takes the shared `StoreAccountContext`
 * the owning `DrizzleProviderCatalogStore` builds.
 */
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { providerPoolAccounts, networkPools, telemetryEvents } from "../../../persistence/schema";
import { IS_GATEWAY_ERROR_SQL } from "../../../observability/event-query";
import { providerRateLimitIsIpScoped } from "../../../providers/provider-metadata";
import {
  activePoolProviderCooldowns,
  emptyUsage,
  usageTotalsFromRow,
} from "./store-helpers";
import type { ProviderAccountResponse, ProviderAccountTokenUsage } from "./contracts";
import type { StoreAccountContext } from "./store-account-types";

/**
 * Pool-as-account rows for one provider. Only providers whose rate limit
 * follows the egress address materialize these; every other provider's pool
 * list stays empty, so real accounts are returned unchanged.
 *
 * The pool row is the source of health truth: `provider_pool_accounts`
 * rows are created at backfill and never mutated, so the surface reads the
 * owning pool's live status/last-* fields and lives on top of them.
 */
export async function listPoolAccounts(
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
export async function listAllPoolAccounts(
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
