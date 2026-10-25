/**
 * `carte telemetry reconcile` — recovers telemetry rows the SQL table missed.
 *
 * The durable record is `telemetry_events`, written in the same transaction as
 * the request's admission/usage accounting. The raw JSONL files are an
 * at-least-once mirror: a crash between the raw append and the commit can
 * leave a line whose row never landed. This command drains that gap, and is
 * also how a deployment that predates the SQL table gets its history back.
 *
 * It talks to the database directly (not through the gateway) because the
 * gateway may be down — a reconciliation is exactly what you run after an
 * incident — and because the job is lease-guarded, so it is safe even with the
 * gateway up and writing.
 */

import { bootDatabase, closeDb, getDb } from "../../src/persistence/boot";
import { reconcileTelemetry } from "../../src/observability/telemetry-reconciliation";

function usage(): string {
  return [
    "Usage:",
    "  cartethyia telemetry reconcile --verify   report the gap, write nothing",
    "  cartethyia telemetry reconcile --apply    insert the missing rows",
    "",
    "--verify is read-only and takes no lease, so it is safe to run while the",
    "gateway is serving. --apply holds a lease for the duration of the run;",
    "a second invocation reports `lease_held` and exits without writing.",
    "",
    "Usage counters (telemetry_usage_totals) are never modified: they were",
    "charged at request time, and re-charging from a backfill would inflate",
    "every dashboard figure for the affected window.",
  ].join("\n");
}

export async function telemetry(argv: readonly string[]): Promise<void> {
  const mode = argv.find((arg) => arg === "--apply" || arg === "--verify");
  if (mode === undefined) {
    console.error(`No mode given.\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  await bootDatabase();
  try {
    const report = await reconcileTelemetry(getDb(), { verify: mode === "--verify" });
    if (!report.ran) {
      const why =
        report.skippedReason === "lease_held"
          ? "another runner holds the lease — try again later"
          : report.skippedReason === "no_files"
            ? "no eligible raw telemetry files (the current and previous UTC hour are always skipped)"
            : "checkpoint is up to date — nothing to reconcile";
      console.log(`telemetry reconcile (${mode}): skipped — ${why}`);
      return;
    }
    console.log(
      [
        `telemetry reconcile (${mode}): done`,
        `  files completed : ${report.filesCompleted}`,
        `  events examined : ${report.eventsExamined}`,
        `  events inserted : ${report.eventsInserted}`,
        `  conflicts       : ${report.conflicts} (already present)`,
        `  bytes read      : ${report.bytesRead}`,
      ].join("\n"),
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
}

