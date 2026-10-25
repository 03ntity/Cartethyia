/**
 * The canonical telemetry reader.
 *
 * `telemetry_events` is already written by the production path (the
 * transactional `insertEvents`), is indexed for keyset pagination and
 * tenant-scoped breakdowns, and carries exactly the bounded metadata fields
 * the console aggregates over — bodies live only in payload frame files. It
 * is therefore the analytics source: every function here runs its aggregate
 * IN SQL and returns only totals, groups, or buckets, so no read materializes
 * the retained window in JavaScript.
 *
 * Rules enforced here:
 * - every statement is tenant-scoped and `created_at >= since`;
 * - list/detail use `(created_at, id)` keyset pagination, newest first;
 * - latency percentiles are computed by the database (Postgres
 *   `percentile_cont`, SQLite nearest-rank via ordered OFFSET/LIMIT) —
 *   latency arrays are never returned to JavaScript;
 * - `isGatewayError()` semantics live in one shared SQL predicate.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { telemetryEvents } from "../persistence/schema";
import { resolveDbMode } from "../persistence/db-mode";
import type { TelemetryEventRecord } from "./event-log";
import { gatewayErrorSql } from "./telemetry-status";

/**
 * The SQL predicate for "this request counts as a gateway error".
 *
 * `gatewayErrorSql` (telemetry-status.ts) is derived from the same constants
 * `isGatewayError` reads, so the row-level predicate, the console's error
 * totals, and the durable usage rollup cannot drift apart — an unknown status
 * must be classified identically in all three.
 */
const IS_GATEWAY_ERROR_SQL = gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus);

/** One bounded page of events, newest first. */
export interface EventPage {
  readonly events: TelemetryEventRecord[];
  /** Cursor for the next (older) page; undefined when the window is exhausted. */
  readonly nextCursor?: string;
}

export interface EventListQuery {
  readonly tenantId: string;
  readonly since: Date;
  readonly until?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly requestId?: string;
  readonly id?: string;
  readonly httpStatus?: number;
  readonly limit?: number;
  /** Keyset cursor: `{createdAt}|{id}` of the last row of the previous page. */
  readonly cursor?: string;
}

export interface UsageSummary {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  /** Requests whose latency was recorded — the denominator for `latencyMs`. */
  readonly sampled: number;
  readonly latencyMs: {
    readonly avg: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  /** Requests whose usage carried no price; the analytics `partial` flag. */
  readonly unpriced: number;
}

export interface BreakdownGroup {
  readonly key: string;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ChartBucket {
  readonly at: number;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface HealthTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly latencyAvgMs: number | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericNullable(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Maps one `telemetry_events` row to the console's record shape. */
export function eventRecordFromRow(row: {
  readonly id: string | null;
  readonly createdAt: Date;
  readonly tenantId: string;
  readonly requestId: string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  readonly reportedModel: string | null;
  readonly requestedEffort: string | null;
  readonly providerId: string | null;
  readonly accountId: string | null;
  readonly networkPoolId: string | null;
  readonly endpoint: string | null;
  readonly apiKeyId: string | null;
  readonly userAgent: string | null;
  readonly clientName: string | null;
  readonly clientIp: string | null;
  readonly latencyMs: number | null;
  readonly ttfbMs: number | null;
  readonly stream: boolean | null;
  readonly status: string | null;
  readonly httpStatus: number | null;
  readonly errorOrigin: string | null;
  readonly errorCategory: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostUsd: string | number | null;
  readonly creditUsed: string | number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: string | number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
  readonly payloadCaptureState: string | null;
}): TelemetryEventRecord {
  return {
    id: row.id ?? row.requestId,
    createdAt: new Date(row.createdAt).toISOString(),
    tenantId: row.tenantId,
    requestId: row.requestId,
    sourceSurface: row.sourceSurface,
    requestedModel: row.requestedModel,
    reportedModel: row.reportedModel,
    requestedEffort: row.requestedEffort,
    providerId: row.providerId,
    accountId: row.accountId,
    networkPoolId: row.networkPoolId,
    endpoint: row.endpoint,
    apiKeyId: row.apiKeyId,
    userAgent: row.userAgent,
    clientIp: row.clientIp,
    latencyMs: row.latencyMs,
    ttfbMs: row.ttfbMs,
    stream: row.stream,
    status: row.status,
    httpStatus: row.httpStatus,
    errorOrigin: row.errorOrigin,
    errorCategory: row.errorCategory,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    estimatedCostUsd: numericNullable(row.estimatedCostUsd),
    creditUsed: numericNullable(row.creditUsed),
    resolveMs: row.resolveMs,
    tokensPerSec: numericNullable(row.tokensPerSec),
    firstContentDeltaAtMs: row.firstContentDeltaAtMs,
    lastEventAtMs: row.lastEventAtMs,
    payloadCaptureState: row.payloadCaptureState,
  };
}

/**
 * True when this deployment's backend is PostgreSQL.
 *
 * Detected from the resolved database mode, not from a property of the Drizzle
 * handle: `CartethyiaDatabase` is the pg-typed builder on both backends (the
 * SQLite adapter shares the type), so any handle-shape guess picks the wrong
 * branch and `percentile_cont` — which SQLite lacks — reaches SQLite.
 */
function isPostgres(): boolean {
  return resolveDbMode() === "full";
}

/** The shared tenant + window predicate every statement in this module adds. */
function scoped(tenantId: string, since: Date) {
  return and(eq(telemetryEvents.tenantId, tenantId), gte(telemetryEvents.createdAt, since));
}

/**
 * Bounded detail/list read — the only place rows are materialized.
 *
 * Keyset pagination on `(created_at DESC, id DESC)`: `created_at` has
 * second resolution, so a cursor on it alone could skip or repeat rows at a
 * boundary. The cursor is the last row of the page, encoded as
 * `{createdAtMs}|{id}`.
 */
export async function queryTelemetryEvents(
  db: CartethyiaDatabase,
  query: EventListQuery,
): Promise<EventPage> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(query.limit ?? DEFAULT_LIMIT)));
  const conditions = [scoped(query.tenantId, query.since)];
  if (query.until !== undefined) {
    conditions.push(sql`${telemetryEvents.createdAt} < ${query.until}`);
  }
  if (query.apiKeyIds !== undefined) {
    conditions.push(inArray(telemetryEvents.apiKeyId, [...query.apiKeyIds]));
  }
  if (query.accountIds !== undefined) {
    conditions.push(inArray(telemetryEvents.accountId, [...query.accountIds]));
  }
  if (query.requestId !== undefined) {
    conditions.push(eq(telemetryEvents.requestId, query.requestId));
  }
  if (query.id !== undefined) {
    conditions.push(eq(telemetryEvents.id, query.id));
  }
  if (query.httpStatus !== undefined) {
    conditions.push(eq(telemetryEvents.httpStatus, query.httpStatus));
  }
  if (query.cursor !== undefined) {
    const separator = query.cursor.indexOf("|");
    const at = Number(query.cursor.slice(0, separator));
    const id = query.cursor.slice(separator + 1);
    if (Number.isFinite(at) && id.length > 0) {
      conditions.push(
        sql`(${telemetryEvents.createdAt} < ${new Date(at)} OR (${telemetryEvents.createdAt} = ${new Date(at)} AND ${telemetryEvents.id} < ${id}))`,
      );
    }
  }

  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(and(...conditions))
    .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  const events = page.map((row) => eventRecordFromRow(row as Parameters<typeof eventRecordFromRow>[0]));
  return {
    events,
    ...(hasMore && last
      ? {
          nextCursor: `${new Date(last.createdAt as unknown as Date).getTime()}|${last.id ?? last.requestId}`,
        }
      : {}),
  };
}

/** One event by request id — a single indexed row, never a window scan. */
export async function eventByRequestId(
  db: CartethyiaDatabase,
  tenantId: string,
  requestId: string,
): Promise<TelemetryEventRecord | undefined> {
  const [row] = await db
    .select()
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.tenantId, tenantId), eq(telemetryEvents.requestId, requestId)))
    .limit(1);
  if (!row) return undefined;
  return eventRecordFromRow(row as Parameters<typeof eventRecordFromRow>[0]);
}

/**
 * Totals plus latency percentiles for one tenant window.
 *
 * Percentiles are computed by the database. Postgres uses `percentile_cont`;
 * SQLite (no ordered-set aggregates) computes nearest-rank percentiles from
 * the ordered latency column via OFFSET/LIMIT. Either way, latency values are
 * never returned to JavaScript — the array that the old raw reader built to
 * sort in JS was the memory cost this replaces.
 */
export async function summarizeTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<UsageSummary> {
  const condition = scoped(tenantId, since);
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${telemetryEvents.reasoningTokens}), 0)`,
      estimatedCostUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      unpriced: sql<number>`sum(case when ${telemetryEvents.estimatedCostUsd} is null then 1 else 0 end)`,
    })
    .from(telemetryEvents)
    .where(condition);
  if (!row) {
    return {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      sampled: 0,
      latencyMs: { avg: null, p50: null, p95: null, p99: null },
      unpriced: 0,
    };
  }

  const sampled = numeric(row.sampled);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    reasoningTokens: numeric(row.reasoningTokens),
    estimatedCostUsd: numeric(row.estimatedCostUsd),
    sampled,
    latencyMs: {
      avg: numericNullable(row.latencyAvg),
      ...percentiles,
    },
    unpriced: numeric(row.unpriced),
  };
}

type Percentiles = { p50: number | null; p95: number | null; p99: number | null };

async function latencyPercentiles(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
  sampled: number,
): Promise<Percentiles> {
  const empty: Percentiles = { p50: null, p95: null, p99: null };
  if (sampled <= 0) return empty;
  const base = [scoped(tenantId, since), isNotNull(telemetryEvents.latencyMs)];

  // Postgres: one statement computing all three continuous percentiles.
  if (isPostgres()) {
    const [row] = await db
      .select({
        p50: sql<number>`percentile_cont(0.50) within group (order by ${telemetryEvents.latencyMs})`,
        p95: sql<number>`percentile_cont(0.95) within group (order by ${telemetryEvents.latencyMs})`,
        p99: sql<number>`percentile_cont(0.99) within group (order by ${telemetryEvents.latencyMs})`,
      })
      .from(telemetryEvents)
      .where(and(...base));
    if (!row) return empty;
    return {
      p50: numericNullable(row.p50),
      p95: numericNullable(row.p95),
      p99: numericNullable(row.p99),
    };
  }

  // SQLite: nearest-rank percentile = the value at ceil(p * n) rows into the
  // ordered latency column, via ORDER BY + OFFSET/LIMIT in SQL.
  const rankAt = async (fraction: number): Promise<number | null> => {
    const offset = Math.max(0, Math.ceil(fraction * sampled) - 1);
    const [row] = await db
      .select({ value: telemetryEvents.latencyMs })
      .from(telemetryEvents)
      .where(and(...base))
      .orderBy(telemetryEvents.latencyMs)
      .limit(1)
      .offset(offset);
    return row?.value ?? null;
  };
  const [p50, p95, p99] = await Promise.all([rankAt(0.5), rankAt(0.95), rankAt(0.99)]);
  return { p50, p95, p99 };
}

/** The SQL column one breakdown dimension groups by. */
function dimensionColumn(dimension: string) {
  if (dimension === "model") return telemetryEvents.requestedModel;
  if (dimension === "provider") return telemetryEvents.providerId;
  if (dimension === "account") return telemetryEvents.accountId;
  if (dimension === "api_key" || dimension === "key") return telemetryEvents.apiKeyId;
  if (dimension === "client") return telemetryEvents.clientName;
  if (dimension === "status") return telemetryEvents.httpStatus;
  if (dimension === "endpoint") return telemetryEvents.endpoint;
  return telemetryEvents.requestedModel;
}

/** The dimension's raw value as a string, for the console's grouping step. */
function dimensionValue(raw: unknown): string {
  const value = raw === null || raw === undefined ? "" : String(raw);
  return value.length === 0 ? "unknown" : value;
}

/**
 * One dimension's groups, at most 100, ordered by request count.
 *
 * Grouping happens in SQL; only the groups come back. `client` groups on the
 * ingestion-stamped `client_name` rather than re-deriving a name per row in
 * JavaScript, and `client_ip` masking stays a post-grouping presentation step.
 */
export async function breakdownTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  dimension: string,
  since: Date,
): Promise<BreakdownGroup[]> {
  const column = dimensionColumn(dimension);
  const rows = await db
    .select({
      key: column,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since))
    .groupBy(column)
    .orderBy(desc(sql`count(*)`))
    .limit(100);
  return rows.map((row) => ({
    key: dimensionValue(row.key),
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
  }));
}

/**
 * Time-series buckets, computed in SQL.
 *
 * Bucket width comes from the caller (the console's existing period rule); the
 * epoch bucketing is portable — `to_timestamp`/`unixepoch` differences are
 * handled per backend.
 */
export async function chartTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
  bucketSeconds: number,
): Promise<ChartBucket[]> {
  const width = Math.max(1, Math.trunc(bucketSeconds));
  const bucketExpression = isPostgres()
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${width}) * ${width}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${width}) * ${width}`;
  const rows = await db
    .select({
      at: bucketExpression,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since))
    .groupBy(bucketExpression)
    .orderBy(bucketExpression);
  return rows.map((row) => ({
    at: numeric(row.at) * 1000,
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
  }));
}

/** Overview/health totals for one tenant window. */
export async function healthTelemetry(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<HealthTotals> {
  const [row] = await db
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  if (!row) {
    return {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      latencyAvgMs: null,
    };
  }
  return {
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    latencyAvgMs: numericNullable(row.latencyAvg),
  };
}

/**
 * Summed input+output tokens for a set of API keys over one window — the
 * family bucket spend query.
 */
export async function sumTelemetryTokens(
  db: CartethyiaDatabase,
  tenantId: string,
  filters: { readonly apiKeyIds?: readonly string[]; readonly since: Date; readonly until?: Date },
): Promise<number> {
  const conditions = [scoped(tenantId, filters.since)];
  if (filters.until !== undefined) {
    conditions.push(sql`${telemetryEvents.createdAt} < ${filters.until}`);
  }
  if (filters.apiKeyIds !== undefined && filters.apiKeyIds.length > 0) {
    conditions.push(inArray(telemetryEvents.apiKeyId, [...filters.apiKeyIds]));
  }
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`,
    })
    .from(telemetryEvents)
    .where(and(...conditions));
  return numeric(row?.total ?? 0);
}
