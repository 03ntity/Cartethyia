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
  /**
   * Lower bound. Omitting it means "the whole retained window" — the SQL table
   * is pruned by the same retention rule as the raw files, so an unbounded
   * query is bounded by retention rather than unbounded in effect. (Backup
   * export is the one caller that needs the full window.)
   */
  readonly since?: Date;
  readonly until?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly requestId?: string;
  /** Several request ids at once — the backup restore's "already present" check. */
  readonly requestIds?: readonly string[];
  readonly id?: string;
  readonly httpStatus?: number;
  readonly limit?: number;
  /** Keyset cursor: `{createdAt}|{id}` of the last row of the previous page. */
  readonly cursor?: string;
}

export interface UsageSummary {
  readonly requests: number;
  readonly errors: number;
  /** Lifecycle breakdown: cancelled and truncated counts, for the summary card. */
  readonly cancelled: number;
  readonly truncated: number;
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
  /** Summed estimated cost; null when no row in the group carried a price. */
  readonly costUsd: number | null;
  /** Mean tokens/sec across rows that reported one; 0 when none did. */
  readonly avgTokensPerSec: number;
  /** Cached-input share of the prompt, summed for the group. */
  readonly cachedInputTokens: number;
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
 * True when this handle speaks PostgreSQL.
 *
 * Read off the live dialect rather than `resolveDbMode()`/`handle.kind`:
 * `CartethyiaDatabase` is the pg-typed builder on both backends (the SQLite
 * adapter shares the type), and a test can build a SQLite handle while the
 * process' mode is `full` — a mode-based guess then sends `percentile_cont`,
 * which SQLite lacks, to SQLite. The dialect is the thing that actually
 * renders the SQL, so it is the only answer that cannot disagree with it.
 */
function isPostgres(db: CartethyiaDatabase): boolean {
  const dialect = (db as unknown as { dialect?: { constructor?: { name?: string } } }).dialect;
  const name = dialect?.constructor?.name;
  return name === "PostgresDialect" || name === "PgDialect";
}

/**
 * The tenant predicate — the scope every read shares — plus the window when
 * one is given.
 *
 * Tenant is NOT optional: every statement here is tenant-scoped, and a query
 * that forgot it would read another tenant's traffic.
 */
function scoped(tenantId: string, since?: Date) {
  const tenant = eq(telemetryEvents.tenantId, tenantId);
  return since === undefined ? tenant : and(tenant, gte(telemetryEvents.createdAt, since));
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
  if (query.requestIds !== undefined) {
    conditions.push(inArray(telemetryEvents.requestId, [...query.requestIds]));
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
      cancelled: sql<number>`sum(case when ${telemetryEvents.status} = 'cancelled' then 1 else 0 end)`,
      truncated: sql<number>`sum(case when ${telemetryEvents.status} = 'truncated' then 1 else 0 end)`,
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
      cancelled: 0,
      truncated: 0,
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
    cancelled: numeric(row.cancelled),
    truncated: numeric(row.truncated),
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
  if (isPostgres(db)) {
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
  // `client_ip` groups on the raw address; masking stays a post-grouping
  // presentation step in the console, unchanged.
  if (dimension === "client_ip" || dimension === "ip") return telemetryEvents.clientIp;
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
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
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
    cachedInputTokens: numeric(row.cachedInputTokens),
    // A group whose rows carried no price reports null, matching the console's
    // "cost is unknown" reading rather than a false zero.
    costUsd: numeric(row.costUsd) > 0 ? numeric(row.costUsd) : null,
    avgTokensPerSec: numeric(row.avgTokensPerSec),
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
  // Inlined (not parameterised) so Postgres sees the SELECT and GROUP BY
  // expressions as identical: parameter numbers differing between the two
  // clauses made Postgres treat them as unrelated expressions referencing
  // `created_at`, which 42803-rejected the query.
  const w = sql.raw(String(width));
  const bucketExpression = isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${w}) * ${w}`;
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
    .groupBy(bucketExpression);
  return rows.map((row) => ({
    at: numeric(row.at) * 1000,
    requests: numeric(row.requests),
    errors: numeric(row.errors),
    inputTokens: numeric(row.inputTokens),
    outputTokens: numeric(row.outputTokens),
  }));
}

/** One day × model usage cell for a single provider — the Activity Matrix feed. */
export interface ProviderUsageDayRow {
  /** UTC day, `YYYY-MM-DD` (epoch-day buckets, so the same key on both backends). */
  readonly day: string;
  /** What the client asked for; `null` when the event carried no model. */
  readonly model: string | null;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * Per-provider daily usage grouped by `requested_model`, day-bucketed like
 * {@link chartTelemetry} but with a second grouping dimension (requested
 * model) and the totals the tooltip/summary strip need. Provider rows carry
 * no catalog foreign keys, so an unknown or deleted provider id returns empty
 * rather than erroring.
 */
export async function providerUsageMatrix(
  db: CartethyiaDatabase,
  tenantId: string,
  providerId: string,
  since: Date,
): Promise<ProviderUsageDayRow[]> {
  // Same inlining rule as chartTelemetry: SELECT and GROUP BY must spell the
  // identical expression or Postgres 42803-rejects the grouped reference.
  const w = sql.raw(String(86400));
  const dayExpression = isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${telemetryEvents.createdAt}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${telemetryEvents.createdAt}) as integer) / ${w}) * ${w}`;
  const rows = await db
    .select({
      day: dayExpression,
      model: telemetryEvents.requestedModel,
      requests: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
    })
    .from(telemetryEvents)
    .where(and(scoped(tenantId, since), eq(telemetryEvents.providerId, providerId)))
    .groupBy(dayExpression, telemetryEvents.requestedModel)
    .orderBy(dayExpression);
  return rows.map((row) => ({
    day: new Date(numeric(row.day) * 1000).toISOString().slice(0, 10),
    model: row.model,
    requests: numeric(row.requests),
    inputTokens: numeric(row.inputTokens),
    cachedInputTokens: numeric(row.cachedInputTokens),
    outputTokens: numeric(row.outputTokens),
    costUsd: numeric(row.costUsd),
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

/**
 * The health card's latency and throughput figures for one window.
 *
 * Same principle as {@link summarizeTelemetry}: `avg(tokens_per_sec)` and the
 * latency percentiles are computed by the database. The console's health card
 * used to pull every retained event into an array to average `tokensPerSec`
 * and sort latencies in JavaScript.
 */
export interface HealthPerformance {
  readonly latencyAvgMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly latencyP99Ms: number | null;
  readonly avgTokensPerSec: number;
}

export async function summarizeHealthPerformance(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<HealthPerformance> {
  const [row] = await db
    .select({
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  const sampled = numeric(row?.sampled ?? 0);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    latencyAvgMs: numericNullable(row?.latencyAvg ?? null),
    latencyP50Ms: percentiles.p50,
    latencyP95Ms: percentiles.p95,
    latencyP99Ms: percentiles.p99,
    avgTokensPerSec: numeric(row?.avgTokensPerSec ?? 0),
  };
}

/**
 * The Usage summary's performance block, computed in SQL.
 *
 * Replaces `summarizeUsagePerformance` (which sorted a latency array in
 * JavaScript): `avg(resolve_ms)` and `avg(tokens_per_sec)` are SQL averages,
 * and the latency percentiles come from the same database-side percentile
 * path {@link summarizeTelemetry} uses.
 */
export interface UsagePerformanceTotals {
  readonly avgResolveMs: number;
  readonly avgDurationMs: number;
  /**
   * Percentiles as plain numbers: an empty window reports 0, which is what the
   * JS-side `summarizeUsagePerformance` reported and what the summary card's
   * contract expects. (The health reader keeps null so "no samples" stays
   * distinguishable from a genuine near-zero latency.)
   */
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyP99Ms: number;
  readonly latencySampleCount: number;
  readonly resolveSampleCount: number;
  readonly avgTokensPerSec: number;
}

export async function summarizeUsagePerformanceSql(
  db: CartethyiaDatabase,
  tenantId: string,
  since: Date,
): Promise<UsagePerformanceTotals> {
  const [row] = await db
    .select({
      sampled: sql<number>`count(${telemetryEvents.latencyMs})`,
      latencyAvg: sql<number>`avg(${telemetryEvents.latencyMs})`,
      resolveSum: sql<number>`coalesce(sum(${telemetryEvents.resolveMs}), 0)`,
      resolveCount: sql<number>`count(${telemetryEvents.resolveMs})`,
      avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}), 0)`,
    })
    .from(telemetryEvents)
    .where(scoped(tenantId, since));
  const sampled = numeric(row?.sampled ?? 0);
  const resolveCount = numeric(row?.resolveCount ?? 0);
  const percentiles = await latencyPercentiles(db, tenantId, since, sampled);
  return {
    avgResolveMs: resolveCount > 0 ? numeric(row?.resolveSum ?? 0) / resolveCount : 0,
    avgDurationMs: numericNullable(row?.latencyAvg ?? null) ?? 0,
    latencyP50Ms: percentiles.p50 ?? 0,
    latencyP95Ms: percentiles.p95 ?? 0,
    latencyP99Ms: percentiles.p99 ?? 0,
    latencySampleCount: sampled,
    resolveSampleCount: resolveCount,
    avgTokensPerSec: numeric(row?.avgTokensPerSec ?? 0),
  };
}
