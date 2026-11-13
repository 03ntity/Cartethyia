/**
 * Shared SQL machinery for the canonical telemetry reader.
 *
 * Every predicate and fragment here is used by at least two of the reader
 * modules (`event-query.ts` and `event-query-types.ts`), so it lives once,
 * here. The row-level gateway-error rule, the aggregate select fragments, and
 * the membership/family predicates cannot drift between the readers that
 * consume them.
 */
import { and, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { apiKeys, telemetryEvents } from "../persistence/schema";
import { gatewayErrorSql } from "./telemetry-status";

/**
 * The SQL predicate for "this request counts as a gateway error".
 *
 * `gatewayErrorSql` (telemetry-status.ts) is derived from the same constants
 * `isGatewayError` reads, so the row-level predicate, the console's error
 * totals, and the durable usage rollup cannot drift apart — an unknown status
 * must be classified identically in all three.
 */
export const IS_GATEWAY_ERROR_SQL = gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus);

/**
 * Cached-token aggregate under the "eligible request" rule.
 *
 * A request that carried any cached input (`cached_input_tokens > 0`) is a
 * cache hit, and the WHOLE prompt is read as cached — the operator's rule is
 * binary per request, not proportional (see the Usage page's "Cached tokens"
 * tile and the provider Activity Matrix). So the aggregate is the sum of
 * `input_tokens` over rows with a positive cached count, not the sum of the
 * cached counts themselves.
 *
 * This reuses the same column the row-level estimator writes
 * (`cached_input_tokens`), so it stays consistent across SQLite and Postgres.
 */
export const CACHED_INPUT_TOKENS_SQL = sql<number>`coalesce(sum(case when ${telemetryEvents.cachedInputTokens} > 0 then ${telemetryEvents.inputTokens} else 0 end), 0)`;

/**
 * The aggregate select fragments shared by every tenant-window read. The
 * `errors` count uses the single shared gateway-error predicate (see
 * {@link IS_GATEWAY_ERROR_SQL}) so the row-level rule and the SQL aggregate
 * cannot drift; the sum fragments coalesce to 0 so an empty window reads as
 * zero rather than null.
 */
export const AGGREGATE_SELECT = {
  errors: sql<number>`sum(case when ${IS_GATEWAY_ERROR_SQL} then 1 else 0 end)`,
  inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
  cachedInputTokens: CACHED_INPUT_TOKENS_SQL,
} as const;

export interface ChartBucket {
  readonly at: number;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cached-input share of the prompt, summed for the bucket. */
  readonly cachedInputTokens: number;
}

/**
 * Thrown when a membership filter outruns the guard below. This is a handled
 * query error, not a protocol fault: callers surface it as a request failure
 * instead of crashing the process with a PostgreSQL wire error that systemd
 * would only restart into.
 */
export class TelemetryQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryQueryInputError";
  }
}

/**
 * The deduplicated id count a list membership filter accepts before refusing.
 *
 * `idMembershipFilter` binds the whole set as one array parameter, so even a
 * six-figure set is wire-safe; this guard is not a protocol necessity but a
 * runaway-collector tripwire — a bug elsewhere (an unbounded accumulator, a
 * vanished scope) must fail as a query error instead of materializing an
 * unbounded parameter. Families larger than this must use the `familyApiKeyId`
 * filter, which never materializes ids.
 */
const MAX_MEMBERSHIP_IDS = 200_000;

/**
 * The chunk size for the SQLite rendering of a list membership filter.
 *
 * SQLite has no array parameters, so the set has to come back as individual
 * placeholders; 500 per chunk sits far below every build's
 * SQLITE_MAX_VARIABLE_NUMBER while keeping the OR of chunks — semantically
 * the identical membership test — to a handful of clauses for realistic sets.
 */
const SQLITE_IDS_PER_CHUNK = 500;

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
export function isPostgres(db: CartethyiaDatabase): boolean {
  const dialect = (db as unknown as { dialect?: unknown }).dialect;
  if (dialect instanceof PgDialect) return true;
  const name = (dialect as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return name === "PostgresDialect" || name === "PgDialect";
}

/**
 * The epoch-bucket SQL expression for one time column.
 *
 * Inlined (not parameterised) so Postgres sees the SELECT and GROUP BY
 * expressions as identical: parameter numbers differing between the two
 * clauses made Postgres treat them as unrelated expressions referencing
 * `created_at`, which 42803-rejected the query. The width is a raw SQL
 * literal for the same reason.
 */
export function bucketExpression(db: CartethyiaDatabase, column: typeof telemetryEvents.createdAt, widthSeconds: number): SQL {
  const w = sql.raw(String(Math.max(1, Math.trunc(widthSeconds))));
  return isPostgres(db)
    ? sql<number>`(cast(extract(epoch from ${column}) as bigint) / ${w}) * ${w}`
    : sql<number>`(cast(strftime('%s', ${column}) as integer) / ${w}) * ${w}`;
}

/**
 * The tenant predicate — the scope every read shares — plus the window when
 * one is given.
 *
 * Tenant is NOT optional: every statement here is tenant-scoped, and a query
 * that forgot it would read another tenant's traffic.
 */
export function scoped(tenantId: string, since?: Date) {
  const tenant = eq(telemetryEvents.tenantId, tenantId);
  return since === undefined ? tenant : and(tenant, gte(telemetryEvents.createdAt, since));
}

/**
 * Membership of `column` in a caller-supplied id set, safe at any set size.
 *
 * Expanding the members into one bind placeholder each breaks the wire twice
 * over: PostgreSQL caps a Bind message at 65,535 parameters, and node-postgres
 * miscounts long placeholder lists anyway (`08P01 bind message has N parameter
 * formats but 0 parameters` — the shape that crash-looped the dev deployment,
 * whose share family carried ~90k minted child keys). Instead the set is
 * deduplicated and handed to the server as a single array parameter
 * (`= ANY(…::uuid[])`), or, on SQLite, to chunks of individual placeholders;
 * membership semantics are unchanged in both renderings.
 */
export function idMembershipFilter(
  db: CartethyiaDatabase,
  column: typeof telemetryEvents.apiKeyId | typeof telemetryEvents.accountId | typeof telemetryEvents.requestId,
  values: readonly string[],
  cast: "uuid[]" | "text[]",
): SQL {
  const unique = [...new Set(values)];
  if (unique.length > MAX_MEMBERSHIP_IDS) {
    throw new TelemetryQueryInputError(
      `telemetry filter exceeds ${MAX_MEMBERSHIP_IDS} distinct ids (got ${unique.length}); scope the read by family or tenant instead`,
    );
  }
  if (unique.length === 0) return sql`false`;
  if (isPostgres(db)) {
    return sql`${column} = ANY(${unique}::${sql.raw(cast)})`;
  }
  if (unique.length <= SQLITE_IDS_PER_CHUNK) return inArray(column, unique);
  const chunks: SQL[] = [];
  for (let start = 0; start < unique.length; start += SQLITE_IDS_PER_CHUNK) {
    chunks.push(inArray(column, unique.slice(start, start + SQLITE_IDS_PER_CHUNK)));
  }
  return or(...chunks) as SQL;
}

/**
 * Membership of `api_key_id` in the family of one share template — the
 * template itself plus every key it issued.
 *
 * The primary predicate is the denormalized `family_template_key_id` column:
 * an event is in the family when it was stamped with the template at write
 * time. That makes the read independent of the key row surviving — a revoked
 * or removed key keeps its history. Events written before the column existed
 * (or whose key was hard-deleted before the backfill) fall back to an
 * `EXISTS` against `api_keys`, so the migration window is still counted when
 * the key row is present. The tenant predicate is carried by every read
 * already, so a child in another tenant still cannot match.
 */
export function familyKeyCondition(templateKeyId: string): SQL {
  return sql`(${telemetryEvents.familyTemplateKeyId} = ${templateKeyId} or (${telemetryEvents.familyTemplateKeyId} is null and exists (select 1 from ${apiKeys} where ${apiKeys.id} = ${telemetryEvents.apiKeyId} and (${apiKeys.id} = ${templateKeyId} or ${apiKeys.parentKeyId} = ${templateKeyId}))))`;
}

export function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function numericNullable(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
