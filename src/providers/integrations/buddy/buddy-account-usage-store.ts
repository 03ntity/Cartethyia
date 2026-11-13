import { and, desc, gte, inArray, lt, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { buddyUsageSnapshots } from "../../../persistence/schema";
import { log } from "../../../observability/logger";
import type { BuddyUsageRow } from "./buddy-account-usage";

// ── buddy-usage-store ──────────────────────────────────────────

export interface BuddyUsageSnapshotRow extends BuddyUsageRow {
  readonly syncedAt: string | null;
}

const RETENTION_DAYS = 30;

function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export async function saveBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountId: string,
  rows: readonly BuddyUsageRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date();
  try {
    await db
      .insert(buddyUsageSnapshots)
      .values(
        rows.map((row) => ({
          accountId,
          dayKey: row.day,
          model: row.model,
          credit: String(row.credit),
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          buddyUsageSnapshots.accountId,
          buddyUsageSnapshots.dayKey,
          buddyUsageSnapshots.model,
        ],
        set: {
          credit: sql`excluded."credit"`,
          syncedAt: sql`excluded."synced_at"`,
        },
      });
    return rows.length;
  } catch (error) {
    log.warn("buddy: usage snapshot save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

const MODELS_PER_DAY_CEILING = 64;

const DEFAULT_LIMIT_PER_ACCOUNT = 30;

export async function readBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  accountIds: readonly string[],
  limitPerAccount = DEFAULT_LIMIT_PER_ACCOUNT,
): Promise<Map<string, readonly BuddyUsageSnapshotRow[]>> {
  const result = new Map<string, BuddyUsageSnapshotRow[]>();
  if (accountIds.length === 0) return result;
  let rows: {
    accountId: string;
    dayKey: string;
    model: string;
    credit: string | number | null;
    syncedAt: Date | string | null;
  }[];
  try {
    rows = await db
      .select({
        accountId: buddyUsageSnapshots.accountId,
        dayKey: buddyUsageSnapshots.dayKey,
        model: buddyUsageSnapshots.model,
        credit: buddyUsageSnapshots.credit,
        syncedAt: buddyUsageSnapshots.syncedAt,
      })
      .from(buddyUsageSnapshots)
      .where(
        and(
          inArray(buddyUsageSnapshots.accountId, [...accountIds]),
          gte(buddyUsageSnapshots.dayKey, retentionCutoff()),
        ),
      )
      .orderBy(desc(buddyUsageSnapshots.dayKey))
      .limit(accountIds.length * limitPerAccount * MODELS_PER_DAY_CEILING);
  } catch (error) {
    log.warn("buddy: usage snapshot read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  for (const row of rows) {
    const bucket = result.get(row.accountId) ?? [];
    // Ordered by day, so the first `limitPerAccount` distinct days win and a
    // model that ran every day does not crowd out the rest of the window.
    if (bucket.length >= limitPerAccount && bucket[bucket.length - 1]?.day !== row.dayKey) continue;
    bucket.push({
      day: row.dayKey,
      model: row.model,
      credit: Number(row.credit ?? 0) || 0,
      syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : (row.syncedAt ?? null),
    });
    result.set(row.accountId, bucket);
  }
  return result;
}

export async function pruneBuddyUsageSnapshots(
  db: CartethyiaDatabase,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now);
  try {
    // Days strictly older than the cutoff: the reader keeps `dayKey >= cutoff`
    // (`gte` above), so the prune boundary is the matching strict inequality —
    // one delete that also reports the real deleted count.
    const deleted = await db
      .delete(buddyUsageSnapshots)
      .where(lt(buddyUsageSnapshots.dayKey, cutoff))
      .returning({ accountId: buddyUsageSnapshots.accountId });
    return deleted.length;
  } catch (error) {
    log.warn("buddy: usage snapshot prune failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
