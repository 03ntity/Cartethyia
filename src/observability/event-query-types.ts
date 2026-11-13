/**
 * The type surface of the canonical telemetry reader.
 *
 * Split out of `event-query.ts` so the query builders and the read functions
 * share one definitions file. Everything here is a plain data shape; no SQL,
 * no database handles.
 */
import type { TelemetryEventRecord } from "./event-log";

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
  /**
   * The share-template key whose family (the template itself plus every child
   * key it issued) scopes the read. Rendered as an `EXISTS` subquery against
   * `api_keys` rather than an id list: a family is minted by the tenant and
   * can grow to whatever size the tenant drives it to, so enumerating its ids
   * in JavaScript to feed a bind list would scale the query's wire size with
   * the family instead of with the result. The subquery keeps the same
   * membership semantics — template id or any child of it — for any family
   * size.
   */
  readonly familyApiKeyId?: string;
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
  /** Cached-input share of the prompt, summed for the bucket. */
  readonly cachedInputTokens: number;
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
