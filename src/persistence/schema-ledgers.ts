/**
 * Daily-claim ledgers and provider usage snapshots: one row per
 * (day, account[, task]) idempotency guard plus the buddy billing snapshot.
 */
import {
  index, numeric, pgTable, primaryKey, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { providerAccounts } from "./schema-providers";

// Daily check-in ledger: one row per (account, calendar day) once the sweep has
// attempted that account's claim.
//
// The day-scoped composite PK is the claim guard — an insert that conflicts is
// exactly the "already settled today" answer — so it replaces the Redis
// `SET NX EX` the Lite backend never had. The console reads the same table to
// answer "was this attempted today", which is what makes the Quota page show
// the real state instead of a permanent "Check-in due" when Redis is absent.
export const dailyCheckinLedger = pgTable(
  "daily_checkin_ledger",
  {
    dayKey: text("day_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dayKey, table.accountId] }),
  ],
);

/**
 * Per-day, per-model credit deductions the buddy billing meter reported.
 *
 * A snapshot, not a ledger: the upstream is the source of truth and answers the
 * whole window on every call, so a row is upserted rather than appended. What it
 * buys is that the console renders a *stored* figure — without it every page
 * open would re-hit the billing endpoint for every account, and a failed read
 * would show nothing at all instead of the last number obtained.
 *
 * Keyed (account, day, model): one row per bucket, and the conflict target is
 * what makes the write idempotent across passes.
 */
export const buddyUsageSnapshots = pgTable(
  "buddy_usage_snapshots",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    /** Calendar day the requests were metered on, `YYYY-MM-DD`. */
    dayKey: text("day_key").notNull(),
    model: text("model").notNull(),
    /** Credits deducted across every request in this bucket. */
    credit: numeric("credit", { precision: 14, scale: 4 }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.dayKey, table.model] }),
    index("buddy_usage_snapshots_day_idx").on(table.dayKey),
  ],
);

/**
 * One row per (day, account, growth task) once that day's claim was attempted.
 *
 * The composite PK is the idempotency guard: an insert that conflicts is
 * exactly the "already settled today" answer, which is what stops a sweep from
 * re-POSTing a claim on every pass. Same shape as `daily_checkin_ledger`
 * because it is the same problem — one claim per account per day — widened by
 * the task name now that there is more than one thing to claim.
 */
export const buddyTaskLedger = pgTable(
  "buddy_task_ledger",
  {
    dayKey: text("day_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dayKey, table.accountId, table.task] }),
    index("buddy_task_ledger_account_idx").on(table.accountId),
  ],
);
