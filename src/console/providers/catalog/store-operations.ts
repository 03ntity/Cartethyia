/**
 * Account health and bulk-action persistence for the catalog store: health
 * event reads/purges, buddy growth ledger, operator Recover, and the two
 * tenant-scoped bulk actions. Extracted from `store.ts`; every function
 * takes the shared `StoreOperationsContext` the owning
 * `DrizzleProviderCatalogStore` builds.
 */
import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { liveModelCooldownExistsSql } from "../../../persistence/dialect";
import { providerAccounts, buddyTaskLedger } from "../../../persistence/schema";
import { invalidateCredentialCaches } from "../../../providers/operations/provider-credential-service";
import { invalidateQuotaCaches } from "../../../providers/quota/cache";
import {
  listAccountHealthEvents,
  recoverAccount,
  deleteAccountHealthEvents,
  type AccountHealthEventRecord,
} from "../../../providers/operations/account-health-service";
import type {
  BuddyGrowthTaskLedgerEntry,
  ProviderAccountBulkActionResult,
} from "./contracts";
import type { StoreOperationsContext } from "./store-contexts";
import { ownsAccount } from "./store-account-queries";

export async function listAccountHealthEventsRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<readonly AccountHealthEventRecord[]> {
  if (!(await ownsAccount(ctx, tenantId, providerId, accountId))) return [];
  return listAccountHealthEvents(ctx.db, accountId);
}

/** Deletes one account's stored health & error rows, for the modal's purge. */
export async function purgeAccountHealthEventsRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<number> {
  if (!(await ownsAccount(ctx, tenantId, providerId, accountId))) return 0;
  return deleteAccountHealthEvents(ctx.db, accountId);
}

export async function listBuddyGrowthTasksRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
  accountId: string,
  dayKey: string,
): Promise<readonly BuddyGrowthTaskLedgerEntry[]> {
  if (!(await ownsAccount(ctx, tenantId, providerId, accountId))) return [];
  const rows = await ctx.db
    .select({
      accountId: buddyTaskLedger.accountId,
      task: buddyTaskLedger.task,
      claimedAt: buddyTaskLedger.claimedAt,
    })
    .from(buddyTaskLedger)
    .where(
      and(
        eq(buddyTaskLedger.accountId, accountId),
        eq(buddyTaskLedger.dayKey, dayKey),
      ),
    );
  return rows.map((row) => ({
    accountId: row.accountId,
    task: row.task,
    claimedAt: row.claimedAt.toISOString(),
  }));
}

export async function recoverAccountRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
  accountId: string,
): Promise<boolean> {
  if (!(await ownsAccount(ctx, tenantId, providerId, accountId))) return false;
  return recoverAccount(ctx.db, accountId, "manual_operator_recovery");
}

/**
 * One `UPDATE ... WHERE <cooldown predicate>` (D07/D08/D09). The predicate
 * is evaluated in SQL, so the whole provider is handled in one statement
 * without reading rows into the process. `cooldown_until` and
 * `model_cooldowns` are left untouched: they are the evidence the operator
 * sees on a disabled row until an explicit Recover clears them. A row that
 * is already `disabled` is not a target — those columns surviving the
 * status change would otherwise keep matching the predicate forever.
 *
 * Pool-as-account rows live in `provider_pool_accounts`, not this table, so
 * they are excluded by construction. Shared (`tenant_id IS NULL`) rows are
 * counted in `globalSkipped` but never written by a tenant; the global-admin
 * pair of routes owns those.
 */
export async function disableCooldownsRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
): Promise<ProviderAccountBulkActionResult> {
  const nowIso = new Date().toISOString();
  const [globalRows, updatedRows] = await Promise.all([
    ctx.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          isNull(providerAccounts.tenantId),
          liveCooldownPredicate(ctx, nowIso),
        ),
      ),
    ctx.db
      .update(providerAccounts)
      .set({ status: "disabled" })
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          eq(providerAccounts.tenantId, tenantId),
          liveCooldownPredicate(ctx, nowIso),
        ),
      )
      .returning({ id: providerAccounts.id }),
  ]);
  // Status is part of the cached credential's admission decision, so every
  // newly disabled id must be dropped here — not only on delete.
  invalidateCredentialCaches(updatedRows.map((row) => row.id));
  return { ok: true, updated: updatedRows.length, globalSkipped: globalRows.length };
}

/**
 * One `DELETE ... WHERE <strict banned predicate> RETURNING id` (D12).
 * Credential and quota caches are dropped for the deleted ids in one pass
 * each, exactly like the existing batch-delete route. A delete is strictly
 * `status='disabled' AND last_error_category='policy_blocked_banned'`;
 * `auth_invalidated` is remediated by replacing the credential, not here.
 */
export async function deleteBannedRow(
  ctx: StoreOperationsContext,
  tenantId: string,
  providerId: string,
): Promise<ProviderAccountBulkActionResult> {
  const globalRows = await ctx.db
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        isNull(providerAccounts.tenantId),
        bannedPredicate(),
      ),
    );
  const deletedRows = await ctx.db
    .delete(providerAccounts)
    .where(
      and(
        eq(providerAccounts.providerId, providerId),
        eq(providerAccounts.tenantId, tenantId),
        bannedPredicate(),
      ),
    )
    .returning({ id: providerAccounts.id });
  const deletedIds = deletedRows.map((row) => row.id);
  invalidateCredentialCaches(deletedIds);
  await invalidateQuotaCaches(tenantId, deletedIds, ctx.redis);
  return {
    ok: true,
    updated: 0,
    deleted: deletedIds,
    missing: [],
    globalSkipped: globalRows.length,
  };
}

/** Strict banned definition shared by the tenant and global DELETE paths. */
function bannedPredicate(): SQL {
  return and(
    eq(providerAccounts.status, "disabled"),
    eq(providerAccounts.lastErrorCategory, "policy_blocked_banned"),
  ) as SQL;
}

/**
 * Not already disabled, and either `status='cooldown'`, `cooldown_until` is
 * still in the future, or `model_cooldowns` carries a live entry. Scoped to
 * the caller's own rows (the tenant path never touches `tenant_id IS NULL`
 * rows). The shared JSON subquery lives in the dialect module; only the
 * surrounding scoping is the store's.
 *
 * The disabled exclusion is load-bearing. Disable preserves the deadline
 * columns as evidence, so without it a row this action just wrote matches
 * the predicate again and the operator's count never drops to zero.
 */
function liveCooldownPredicate(ctx: StoreOperationsContext, nowIso: string): SQL {
  return and(
    ne(providerAccounts.status, "disabled"),
    or(
      eq(providerAccounts.status, "cooldown"),
      sql`${providerAccounts.cooldownUntil} > ${nowIso}`,
      liveModelCooldownExistsSql(ctx.db, nowIso),
    ),
  ) as SQL;
}
