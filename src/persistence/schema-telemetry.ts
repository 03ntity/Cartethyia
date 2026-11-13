/**
 * Metadata-only request telemetry: events, the reconciliation checkpoint,
 * durable usage totals, and the on-disk payload index.
 */
import { desc, sql } from "drizzle-orm";
import {
  bigint, boolean, check, index, integer, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, tenantRefRequired, updatedAtColumn } from "./schema-shared";

// Metadata-only request telemetry. Retention is configured independently of
// payload capture (`CARTETHYIA_TELEMETRY_RETENTION_DAYS`, default 30 days).
// No prompt text, raw body, API key, encrypted-reasoning payload, or generic
// `payload` column — the schema structurally prevents those fields.
// Correlation columns intentionally have no catalog foreign keys, so a
// telemetry write never depends on provider-row lifetime.
export const telemetrySourceSurface = pgEnum("telemetry_source_surface", [
  "chat",
  "responses",
  "messages",
  "completion",
]);

export const telemetryStatus = pgEnum("telemetry_status", [
  "completed",
  "failed",
  "cancelled",
  "truncated",
]);

export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    tenantId: tenantRefRequired(),
    requestId: uuid("request_id").notNull(),
    sourceSurface: telemetrySourceSurface("source_surface"),
    requestedModel: text("requested_model"),
    /**
     * Canonical client name derived from `user_agent` at ingestion
     * (`clientNameFromUserAgent`). Stamped once at write time so client
     * breakdowns group in SQL; the raw `user_agent` stays for detail.
     */
    clientName: text("client_name"),
    /**
     * The `model` the upstream put in its own response, verbatim.
     *
     * Separate from `requested_model` because they answer different questions:
     * one is what the client asked for, the other is what the provider said it
     * ran. A provider that answers `muse-spark` as `deepseek-v4.1-flash` is
     * telling the operator something, and overwriting one with the other would
     * erase it. NULL when the response carried no model.
     */
    reportedModel: text("reported_model"),
    /** Canonical reasoning effort the client asked for; NULL when it asked for none. */
    requestedEffort: text("requested_effort"),
    providerId: text("provider_id"),
    accountId: uuid("account_id"),
    networkPoolId: uuid("network_pool_id"),
    endpoint: text("endpoint"),
    apiKeyId: uuid("api_key_id"),
    /**
     * The share-template key this event belongs to (the template itself, or
     * the parent of the child key that carried the request). Denormalized at
     * write time so family rollups survive the key row being deleted — an
     * `EXISTS` join against `api_keys` tied history to key lifetime. NULL for
     * requests that ran under no share template.
     */
    familyTemplateKeyId: uuid("family_template_key_id"),
    userAgent: text("user_agent"),
    clientIp: text("client_ip"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"),
    stream: boolean("stream"),
    status: telemetryStatus("status"),
    /**
     * HTTP status the client actually received. The `status` enum is the
     * internal terminal state (`completed`/`failed`/…), which collapses every
     * failure to one bucket; this column keeps the wire code, so a 503
     * admission rejection stays distinguishable from a 500 upstream failure
     * in the Usage status breakdown. NULL on rows written before the column.
     */
    httpStatus: integer("http_status"),
    /**
     * Which layer produced the failure: the gateway itself, the upstream
     * provider, or the network in between. Recorded beside `error_category`
     * because the category alone cannot separate them — `invalid_request` is
     * both "the caller sent a bad body" (ours) and "the upstream rejected the
     * body" (theirs), and an operator triaging a failure needs to know which.
     */
    errorOrigin: text("error_origin"),
    errorCategory: text("error_category"),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    /** Provider-billed credits (Tencent buddy-meter `credit`, Qoder `credits`); NULL when unreported. */
    creditUsed: numeric("credit_used", { precision: 12, scale: 4 }),
    /**
     * Gateway-side time before the upstream dispatch began: routing,
     * credential lease, and request preparation. `ttfbMs` is measured from
     * the dispatch start, so this is the overhead the client waited on before
     * the provider was even called.
     */
    resolveMs: integer("resolve_ms"),
    tokensPerSec: numeric("tokens_per_sec", { precision: 10, scale: 2 }),
    // Absolute epoch-millisecond event timestamps (~1.8e12) overflow integer
    // (int4): completed requests carrying observed stream timings failed
    // their telemetry insert and vanished from the console. bigint "number"
    // mode is safe here — epoch millis stay far below MAX_SAFE_INTEGER —
    // and keeps the columns JSON-safe like the token-budget bigints above.
    firstContentDeltaAtMs: bigint("first_content_delta_at_ms", { mode: "number" }),
    lastEventAtMs: bigint("last_event_at_ms", { mode: "number" }),
    /**
     * Why this request's drawer payloads were not captured, or `captured` when
     * they were. Remote-diagnosis column: the drawer reads empty for reasons
     * that are invisible from the client — the tenant's capture mode, a missing
     * tenant, a non-terminal attempt — and without this an operator could not
     * tell "not configured" from "broken".
     */
    payloadCaptureState: text("payload_capture_state"),
    /**
     * Set for a completed request whose output is far smaller than what the
     * model can produce AND which the model ended with an ordinary `stop`
     * (a "degenerate stop"). Introduced to measure how often a model
     * truncates itself on a cached prefix — the pattern that surfaced as
     * short, cut-off chat replies. NULL/unset for everything else.
     */
    degenerateStop: boolean("degenerate_stop"),
  },
  (table) => [
    index("telemetry_events_created_at_idx").on(table.createdAt),
    // Keyset pagination, newest-first: `(created_at, id)` DESC breaks ties
    // deterministically (created_at is second-resolution), so a cursor on the
    // pair never skips or repeats rows at a boundary. Replaces the plain
    // `(tenant_id, created_at)` index, which could not break ties.
    index("telemetry_events_tenant_created_id_idx").on(
      table.tenantId,
      desc(table.createdAt),
      desc(table.id),
    ),
    /**
     * Cross-process idempotency boundary: one terminal event per
     * (tenant, request). Retried drains and cross-process races converge to
     * one row (and one usage charge) via `ON CONFLICT DO NOTHING`.
     */
    uniqueIndex("telemetry_events_tenant_request_uidx").on(
      table.tenantId,
      table.requestId,
    ),
    // Usage status breakdown: equality on `http_status`, keyset range+order.
    index("telemetry_events_tenant_http_created_id_idx").on(
      table.tenantId,
      table.httpStatus,
      desc(table.createdAt),
      desc(table.id),
    ),
    // Per-key family spend: equality on `api_key_id`, keyset range+order.
    index("telemetry_events_tenant_api_key_created_id_idx").on(
      table.tenantId,
      table.apiKeyId,
      desc(table.createdAt),
      desc(table.id),
    ),
    // Share-family rollup: equality on the denormalized template, keyset
    // range+order. Backs both the family totals and the hourly chart reads.
    index("telemetry_events_tenant_family_created_id_idx").on(
      table.tenantId,
      table.familyTemplateKeyId,
      desc(table.createdAt),
      desc(table.id),
    ),
    index("telemetry_events_request_id_idx").on(table.requestId),
    index("telemetry_events_tenant_account_created_idx").on(
      table.tenantId,
      table.accountId,
      table.createdAt,
    ),
    // Provider usage matrix + `breakdownTelemetry("provider")`: equality on
    // `provider_id`, range+aggregate on `created_at`. Was served by the
    // tenant-range index, which scanned every event in the window for one
    // provider's card.
    index("telemetry_events_tenant_provider_created_idx").on(
      table.tenantId,
      table.providerId,
      table.createdAt,
    ),
    // `breakdownTelemetry("model")` (top-model lists): equality on
    // `requested_model`, range+aggregate on `created_at`.
    index("telemetry_events_tenant_model_created_idx").on(
      table.tenantId,
      table.requestedModel,
      table.createdAt,
    ),
    /**
     * Serves the public share page's per-key aggregate (`share-usage.ts`):
     * equality on `api_key_id`, range and aggregate on `created_at`. Without
     * it every share render scanned the largest table in the schema.
     */
    index("telemetry_events_api_key_created_idx").on(table.apiKeyId, table.createdAt),
  ],
);

/**
 * Backfill/reconciliation checkpoint for `carte telemetry reconcile`.
 *
 * One row per job name. The checkpoint (file_name, byte_offset) commits in
 * the same transaction as each backfill batch, so a crash resumes from the
 * last committed offset. The lease columns let exactly one worker run the
 * job: a second worker is rejected until the lease expires.
 */
export const telemetryReconciliationState = pgTable(
  "telemetry_reconciliation_state",
  {
    jobName: text("job_name").primaryKey(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fileName: text("file_name").notNull().default(""),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull().default(0),
    filesCompleted: bigint("files_completed", { mode: "number" }).default(0),
    eventsExamined: bigint("events_examined", { mode: "number" }).default(0),
    eventsInserted: bigint("events_inserted", { mode: "number" }).default(0),
    conflicts: bigint("conflicts", { mode: "number" }).default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("telemetry_reconciliation_state_offset_nonneg", sql`${table.byteOffset} >= 0`),
    check("telemetry_reconciliation_state_files_nonneg", sql`${table.filesCompleted} >= 0`),
    check("telemetry_reconciliation_state_examined_nonneg", sql`${table.eventsExamined} >= 0`),
    check("telemetry_reconciliation_state_inserted_nonneg", sql`${table.eventsInserted} >= 0`),
    check("telemetry_reconciliation_state_conflicts_nonneg", sql`${table.conflicts} >= 0`),
  ],
);

/** Durable aggregates retained after metadata telemetry expires. */
const TELEMETRY_USAGE_IDENTITY_TYPES = ["account", "api_key"] as const;
export type TelemetryUsageIdentityType = (typeof TELEMETRY_USAGE_IDENTITY_TYPES)[number];

export const telemetryUsageTotals = pgTable(
  "telemetry_usage_totals",
  {
    tenantId: tenantRefRequired(),
    identityType: text("identity_type").$type<TelemetryUsageIdentityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    /**
     * For `api_key` identities, the share-template key this key belongs to
     * (the template itself, or the parent of a minted child). Denormalized so
     * family reads do not depend on the key row surviving; NULL for `account`
     * identities and for keys outside a share family.
     */
    familyTemplateKeyId: uuid("family_template_key_id"),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "telemetry_usage_totals_identity_pk",
      columns: [table.tenantId, table.identityType, table.entityId],
    }),
    check(
      "telemetry_usage_totals_identity_type_check",
      sql`${table.identityType} IN ('account', 'api_key')`,
    ),
    index("telemetry_usage_totals_tenant_family_idx").on(
      table.tenantId,
      table.familyTemplateKeyId,
    ),
  ],
);

export const telemetryPayloads = pgTable(
  "telemetry_payloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    requestId: uuid("request_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Typed index into the on-disk frame store. Prompt/response bodies live
     * only in the frame file these columns name — never in Postgres, which is
     * why this table carries no body column to write one into by accident.
     */
    storage: text("storage").notNull(),
    file: text("file").notNull(),
    offset: integer("offset").notNull(),
    length: integer("length").notNull(),
    checksum: text("checksum").notNull(),
    version: integer("version").notNull(),
    /**
     * Which of the four payload stages were captured, as a bitmask. The Usage
     * list shows one icon per stage; learning presence from the frame would
     * cost one inflate per row, so the writer records it here and the list
     * reads it off the indexed row.
     *
     * Bits: 1=request, 2=provider_request, 4=provider_response,
     * 8=client_response. Nullable: NULL renders as all icons greyed rather
     * than inventing presence.
     */
    stages: integer("stages"),
  },
  (table) => [
    index("telemetry_payloads_request_id_idx").on(table.requestId),
    index("telemetry_payloads_tenant_request_idx").on(table.tenantId, table.requestId),
    index("telemetry_payloads_expires_idx").on(table.expiresAt),
    check("telemetry_payloads_storage_check", sql`${table.storage} = 'jsonl-file'`),
    check("telemetry_payloads_version_check", sql`${table.version} = 1`),
    check("telemetry_payloads_offset_check", sql`${table.offset} >= 0`),
    check("telemetry_payloads_length_check", sql`${table.length} > 0`),
  ],
);
