import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { affectedRows, currentTimestamp, laterOf } from "../dialect";
import type { CartethyiaDatabase } from "../db-handle";
import {
  telemetryEvents,
  telemetryPayloads,
  telemetryUsageTotals,
  type TelemetryUsageIdentityType,
} from "../schema";
import { isGatewayError } from "../../observability/telemetry-status";
import { TELEMETRY_EVENT_DIR } from "../../observability/event-log";
import { RawTelemetryEventWriter } from "../../observability/raw-event-writer";

interface UsageTotalDelta {
  readonly tenantId: string;
  readonly identityType: TelemetryUsageIdentityType;
  readonly entityId: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

function addUsageDelta(
  deltas: Map<string, UsageTotalDelta>,
  row: typeof telemetryEvents.$inferInsert,
  identityType: TelemetryUsageIdentityType,
  entityId: string | null | undefined,
): void {
  if (entityId == null) return;
  const key = `${row.tenantId}\0${identityType}\0${entityId}`;
  let delta = deltas.get(key);
  if (!delta) {
    delta = {
      tenantId: row.tenantId,
      identityType,
      entityId,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    deltas.set(key, delta);
  }
  delta.requests += 1;
  // Same definition as every read-side error count, including the HTTP-status
  // exclusions (404/499/503/504): this rollup is durable, so a request counted here
  // stays counted after its raw row is pruned and cannot be corrected later.
  if (isGatewayError(row.status, row.httpStatus)) delta.errors += 1;
  delta.inputTokens += row.inputTokens ?? 0;
  delta.outputTokens += row.outputTokens ?? 0;
}

function aggregateUsage(rows: readonly (typeof telemetryEvents.$inferInsert)[]) {
  const deltas = new Map<string, UsageTotalDelta>();
  for (const row of rows) {
    addUsageDelta(deltas, row, "account", row.accountId);
    addUsageDelta(deltas, row, "api_key", row.apiKeyId);
  }
  return [...deltas.values()];
}

/**
 * Database boundary for durable telemetry writes and bounded retention cleanup.
 * The observability buffer owns queueing and retry policy; this store owns table
 * operations, lifetime aggregates, and retention.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes hourly event files whose whole hour is older than the retention
 * cutoff. The current hour's file is never touched: it is still being appended.
 */
async function pruneEventFiles(before: Date): Promise<void> {
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  const cutoff = before.toISOString().slice(0, 13).replaceAll(":", "-");
  for (const file of files) {
    if (!file.endsWith(".jsonl") || file.endsWith(".events.jsonl")) continue;
    const hour = file.slice(0, 13);
    if (hour < cutoff) await rm(join(TELEMETRY_EVENT_DIR, file), { force: true });
  }
  // Read-only legacy day logs are pruned only after their whole UTC day has
  // aged out; index files are never consulted for usage anymore.
  const cutoffDay = before.toISOString().slice(0, 10);
  for (const file of files) {
    if (!file.endsWith(".events.jsonl") || file.slice(0, 10) >= cutoffDay) continue;
    await rm(join(TELEMETRY_EVENT_DIR, file), { force: true });
  }
}

/**
 * Appends one JSON line per event. One file per hour, so retention is a file
 * delete and no request is replaced by a compacted summary.
 */
export class DrizzleTelemetryStore {
  private readonly eventWriter: RawTelemetryEventWriter;

  constructor(
    private readonly db: CartethyiaDatabase,
    eventWriter = new RawTelemetryEventWriter(TELEMETRY_EVENT_DIR),
  ) {
    this.eventWriter = eventWriter;
  }

  private async applyUsageDeltas(deltas: readonly UsageTotalDelta[], direction: 1 | -1): Promise<void> {
    if (deltas.length === 0) return;
    const ordered = [...deltas].sort((left, right) =>
      left.tenantId.localeCompare(right.tenantId)
      || left.identityType.localeCompare(right.identityType)
      || left.entityId.localeCompare(right.entityId));
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .insert(telemetryUsageTotals)
        .values(ordered.map((delta) => ({
          ...delta,
          requests: direction * delta.requests,
          errors: direction * delta.errors,
          inputTokens: direction * delta.inputTokens,
          outputTokens: direction * delta.outputTokens,
          lastUsedAt: now,
        })))
        .onConflictDoUpdate({
          target: [
            telemetryUsageTotals.tenantId,
            telemetryUsageTotals.identityType,
            telemetryUsageTotals.entityId,
          ],
          set: {
            requests: sql`${telemetryUsageTotals.requests} + excluded.requests`,
            errors: sql`${telemetryUsageTotals.errors} + excluded.errors`,
            inputTokens: sql`${telemetryUsageTotals.inputTokens} + excluded.input_tokens`,
            outputTokens: sql`${telemetryUsageTotals.outputTokens} + excluded.output_tokens`,
            // Do not alter lastUsedAt on a compensating upsert. A portable
            // CASE keeps the original timestamp on either SQL backend.
            lastUsedAt: sql`CASE WHEN excluded.requests < 0 THEN ${telemetryUsageTotals.lastUsedAt} ELSE ${laterOf(sql`${telemetryUsageTotals.lastUsedAt}`, sql`excluded.last_used_at`, this.db)} END`,
            updatedAt: currentTimestamp(),
          },
        });
    });
  }

  /** Writes raw events and maintains their durable identity aggregates. */
  async insertEvents(rows: Array<typeof telemetryEvents.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    // The file accepts anything, so a malformed row would be written and then
    // retried forever without ever failing. Rejecting it here keeps the buffer's
    // drop-and-count contract: one bad row fails the batch, once.
    for (const row of rows) {
      if (!UUID_RE.test(row.tenantId)) {
        throw new Error("telemetry event rejected: tenantId is not a uuid");
      }
    }
    const deltas = aggregateUsage(rows);
    // The per-request row goes to an append-only file, not to Postgres. The
    // database keeps only the durable aggregate below, so a request never
    // adds a row to the largest table. Readers of recent requests read the
    // file; readers of long-term totals read the aggregate.
    await this.applyUsageDeltas(deltas, 1);
    // The aggregate commits before the file append so an invalid row is not
    // rewritten on every database retry. A failed append is compensated below;
    // only a failure of that compensation itself needs external reconciliation.
    try {
      await this.eventWriter.append(rows);
    } catch (error) {
      // Do not let the retry charge this batch twice. Compensation is itself
      // a transaction, so a partial database outage cannot unwind only some
      // identities in this batch. Surface both failures if that also fails.
      await this.applyUsageDeltas(deltas, -1).catch((compensationError: unknown) => {
        throw new AggregateError(
          [error, compensationError],
          "telemetry raw append failed and aggregate compensation also failed",
        );
      });
      throw error;
    }
  }

  /** Inserts one redacted payload and returns its generated identity. */
  async insertPayload(
    row: typeof telemetryPayloads.$inferInsert,
  ): Promise<{ id: string; expiresAt: Date }> {
    const [inserted] = await this.db
      .insert(telemetryPayloads)
      .values(row)
      .returning({ id: telemetryPayloads.id, expiresAt: telemetryPayloads.expiresAt });
    if (!inserted) throw new Error("payload capture insert returned no row");
    return inserted;
  }

  /**
   * Deletes at most one bounded batch of expired payloads in a single
   * statement, so concurrent sweeps atomically claim disjoint rows and the
   * returned count matches the rows actually deleted.
   */
  async deleteExpiredPayloads(batchSize = 5000, before = new Date()): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryPayloads}
      WHERE ${telemetryPayloads.id} IN (
        SELECT ${telemetryPayloads.id} FROM ${telemetryPayloads}
        WHERE ${telemetryPayloads.expiresAt} < ${before}
        ORDER BY ${telemetryPayloads.expiresAt}
        LIMIT ${batchSize}
      )
    `);
    return affectedRows(result);
  }

  /**
   * Deletes at most one bounded batch of aged events in a single statement, so
   * concurrent sweeps atomically claim disjoint rows and the returned count
   * matches the rows actually deleted. Ordered by `created_at`, which
   * `idx_telemetry_created_at` backs.
   */
  async deleteExpiredEvents(batchSize = 5000, before: Date): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM ${telemetryEvents}
      WHERE ${telemetryEvents.id} IN (
        SELECT ${telemetryEvents.id} FROM ${telemetryEvents}
        WHERE ${telemetryEvents.createdAt} < ${before}
        ORDER BY ${telemetryEvents.createdAt}
        LIMIT ${batchSize}
      )
    `);
    return affectedRows(result);
  }

  /**
   * Deletes telemetry older than the supplied cutoff. Payloads follow their
   * `expires_at` contract (15 minutes per row) rather than capture time.
   *
   * Events are pruned in bounded batches rather than one `DELETE`, because
   * `telemetry_events` is the highest-volume table and a single statement
   * covering every aged row grows without limit: it holds locks and WAL for the
   * whole sweep, and on a deployment that has run for months it can exceed the
   * pool's `statement_timeout` and be cancelled, so the sweep never converges
   * and retention silently stops working. Each batch commits independently, so
   * progress survives a cancel or a restart. The loop is bounded so one pass
   * cannot run unbounded — a backlog drains over successive sweeps — mirroring
   * the payload sweeper's `cleanupExpired`.
   */
  async pruneTelemetry(before: Date): Promise<void> {
    await this.eventWriter.idle();
    await pruneEventFiles(before);
    const MAX_BATCHES_PER_SWEEP = 40;
    for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
      const deleted = await this.deleteExpiredEvents(5000, before);
      if (deleted < 5000) break;
    }
    await this.deleteExpiredPayloads(5000, before);
  }
}
