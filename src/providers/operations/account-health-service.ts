import { and, count, desc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { healthEvents } from "../../persistence/schema";
import type { AccountFailureEvidence } from "./account-error-classification";
import { recordAccountFailure, recordAccountSuccess } from "./account-health-writes";

export {
  AUTO_DISABLE_MARKER_PREFIX,
  applyAccountVerdict,
  autoDisableRateLimitedEnabled,
  recordAccountFailure,
  recordAccountSuccess,
  recoverAccount,
  sweepExpiredCooldowns,
} from "./account-health-writes";

export { classifyAccountError, unsupportedModelCooldownMs } from "./account-error-classification";
export type {
  AccountErrorCategory,
  AccountErrorClassification,
  AccountFailureEvidence,
  AccountFailureOrigin,
  AccountFailureScope,
} from "./account-error-classification";

export interface AccountHealthEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly modelId: string | null;
  readonly createdAt: string;
}

/**
 * Single attempt health reporter: one home for the success/failure writes
 * every dispatch attempt ends with. Success records recovery; failure
 * records with caller-supplied evidence (origin/scope classification plus
 * model id). A mutating write invalidates the route snapshot so the next
 * plan sees fresh health. Never throws — health must not fail requests.
 */
export interface AttemptHealthReport {
  readonly accountId: string | undefined;
  readonly modelId?: string;
  readonly error?: unknown;
  readonly evidence?: AccountFailureEvidence;
  readonly snapshotService?: { invalidate(): unknown };
}

export async function reportAttemptOutcome(
  db: CartethyiaDatabase,
  report: AttemptHealthReport,
): Promise<void> {
  if (!report.accountId) return;
  if (report.error === undefined) {
    const recovered = await recordAccountSuccess(db, report.accountId).catch(() => false);
    if (recovered) await report.snapshotService?.invalidate();
    return;
  }
  const classification = await recordAccountFailure(db, report.accountId, report.error, {
    ...report.evidence,
    ...(report.modelId === undefined ? {} : { modelId: report.modelId }),
  }).catch(() => null);
  // Gated on `routesVisible`, not on `mutatesAccount`: a model cooldown changes
  // routing, while a repeated report with the same deadline or a streak-only
  // write does not.
  if (classification?.routesVisible) await report.snapshotService?.invalidate();
}

export async function listAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
  limit = 50,
): Promise<readonly AccountHealthEventRecord[]> {
  try {
    const rows = await db
      .select()
      .from(healthEvents)
      .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
      .orderBy(desc(healthEvents.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId as string,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      modelId: r.modelId ?? null,
      reason: r.reason,
      errorCategory: r.errorCategory,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Every stored row across accounts and pools — the size the purge offers to delete. */
export async function countAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  try {
    const rows = await db.select({ total: count() }).from(healthEvents);
    return rows[0]?.total ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Deletes stored health & error rows.
 *
 * Unlike the read above, a failed delete surfaces: an operator who purged
 * believes the trail is gone, so "it failed" must not read as "it succeeded
 * with zero rows". Callers own the flush-buffer barrier (`drain`) so a queued
 * write cannot land after these rows are gone.
 */
export async function deleteAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<number> {
  const rows = await db
    .delete(healthEvents)
    .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
    .returning({ id: healthEvents.id });
  return rows.length;
}

export async function deleteAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  const rows = await db.delete(healthEvents).returning({ id: healthEvents.id });
  return rows.length;
}

