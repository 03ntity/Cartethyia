/**
 * Bucket primitives for the per-day telemetry index.
 *
 * Each day's events are folded into a `CompactedBucket` via `accumulate()` and
 * stored as a `.index.json` file alongside the source `.events.jsonl`. Buckets
 * are pure accumulators: every field is a running sum, min, or max — nothing
 * is averaged or estimated away. `mergeBucketsInternal` adds two buckets so
 * partial indexes can be merged without re-reading source files.
 */
import type { TelemetryEventRecord } from "./event-log";

/**
 * Histogram bucket edges in milliseconds.
 *
 * Fixed rather than adaptive: a reader that wants P50/P95/P99 has to be able to
 * interpret buckets it did not write, and an adaptive layout would have to be
 * stored alongside every row. These follow the gateway's own latency
 * histogram, so a compacted period and a live one read comparably.
 */
export const LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface CompactedBucket {
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  readonly creditUsed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly truncated: number;
  readonly latencySum: number;
  readonly latencyCount: number;
  readonly latencyMinMs: number | null;
  readonly latencyMaxMs: number | null;
  /** Counts per fixed latency bucket; `+Inf` is the last, overflow, bucket. */
  readonly latencyHistogram: readonly number[];
  readonly tokensPerSecSum: number;
  readonly tokensPerSecCount: number;
  /** Requests whose cost could not be priced. */
  readonly unpriced: number;
  /**
   * Requests per breakdown dimension, kept so the Usage breakdown survives the
   * source files being deleted.
   *
   * Only the *counts* are kept, never the events: a day's breakdown asks how
   * many requests went to a model, not which ones. That is what makes this
   * small enough to keep — a full event is ~1KB, a count is a few bytes.
   */
  readonly byModel: Readonly<Record<string, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byClient: Readonly<Record<string, number>>;
  readonly byClientIp: Readonly<Record<string, number>>;
}

/** A number from a value that may be a numeric string; 0 when unusable. */
function numeric(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

/** Adds one occurrence to a count map, ignoring an absent key. */
function bump(
  counts: Readonly<Record<string, number>> | undefined,
  key: string | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(counts ?? {}) };
  const name = typeof key === "string" ? key.trim() : "";
  if (name !== "") out[name] = (out[name] ?? 0) + 1;
  return out;
}

/** Adds two count maps. */
function mergeCounts(
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [key, value] of Object.entries(b ?? {})) out[key] = (out[key] ?? 0) + value;
  return out;
}

export function emptyBucket(): CompactedBucket {
  return {
    byModel: {},
    byProvider: {},
    byClient: {},
    byClientIp: {},
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    creditUsed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    truncated: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyMinMs: null,
    latencyMaxMs: null,
    latencyHistogram: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
    tokensPerSecSum: 0,
    tokensPerSecCount: 0,
    unpriced: 0,
  };
}

function bucketIndex(latencyMs: number): number {
  for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
    if (latencyMs <= LATENCY_BUCKETS_MS[index]!) return index;
  }
  return LATENCY_BUCKETS_MS.length;
}

/**
 * Folds one request row into a bucket.
 *
 * Every field is a running sum or a min/max, never an average of averages: an
 * average of per-file averages would drift from the true mean as soon as the
 * files held different request counts, and the whole point of compaction is
 * that the totals survive intact.
 */
export function accumulate(
  into: CompactedBucket,
  event: TelemetryEventRecord,
): CompactedBucket {
  const histogram = [...into.latencyHistogram];
  const latency = event.latencyMs;
  if (latency !== null && Number.isFinite(latency)) {
    histogram[bucketIndex(latency)] = (histogram[bucketIndex(latency)] ?? 0) + 1;
  }
  // A cost can arrive as a string: Postgres `numeric` columns come back that
  // way, and so do restored rows. Adding one to a number concatenates instead of
  // summing, which turned a cost of 0.000966 into "00.000966". Coerced here so
  // every downstream sum is arithmetic.
  const priced = numeric(event.estimatedCostUsd);
  return {
    byModel: bump(into.byModel, event.requestedModel ?? event.reportedModel),
    byProvider: bump(into.byProvider, event.providerId),
    byClient: bump(into.byClient, event.sourceSurface),
    byClientIp: bump(into.byClientIp, event.clientIp),
    requests: into.requests + 1,
    inputTokens: into.inputTokens + (event.inputTokens ?? 0),
    cachedTokens: into.cachedTokens + (event.cachedInputTokens ?? 0),
    outputTokens: into.outputTokens + (event.outputTokens ?? 0),
    reasoningTokens: into.reasoningTokens + (event.reasoningTokens ?? 0),
    estimatedCostUsd: into.estimatedCostUsd + priced,
    creditUsed: into.creditUsed + (event.creditUsed ?? 0),
    succeeded: into.succeeded + (event.status === "completed" ? 1 : 0),
    failed: into.failed + (event.status === "failed" ? 1 : 0),
    cancelled: into.cancelled + (event.status === "cancelled" ? 1 : 0),
    truncated: into.truncated + (event.status === "truncated" ? 1 : 0),
    latencySum: into.latencySum + (latency ?? 0),
    latencyCount: into.latencyCount + (latency === null ? 0 : 1),
    latencyMinMs:
      latency === null
        ? into.latencyMinMs
        : into.latencyMinMs === null
          ? latency
          : Math.min(into.latencyMinMs, latency),
    latencyMaxMs:
      latency === null
        ? into.latencyMaxMs
        : into.latencyMaxMs === null
          ? latency
          : Math.max(into.latencyMaxMs, latency),
    latencyHistogram: histogram,
    tokensPerSecSum: into.tokensPerSecSum + (event.tokensPerSec ?? 0),
    tokensPerSecCount: into.tokensPerSecCount + (event.tokensPerSec === null ? 0 : 1),
    // A completed request with no cost is unpriced, not free. Counting it keeps
    // the dashboard's "partial cost" warning honest after compaction.
    unpriced: into.unpriced + (event.status === "completed" && priced === 0 ? 1 : 0),
  };
}

/**
 * An approximate percentile over a compacted histogram.
 *
 * Returns the upper edge of the bucket that contains it — never a value
 * between edges, because a histogram cannot be more precise than the bucket
 * that holds the sample. `null` when there are no samples, and `null` when the
 * percentile falls in the overflow bucket, whose upper edge is unbounded.
 */
export function percentileFromHistogram(
  histogram: readonly number[],
  percentile: number,
): (typeof LATENCY_BUCKETS_MS)[number] | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const target = Math.ceil((percentile / 100) * total);
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index] ?? 0;
    if (seen >= target) {
      // The bucket's upper edge: a percentile from a histogram can never be
      // more precise than the bucket that contains it.
      return index < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[index]! : null;
    }
  }
  return null;
}

/** Newline count of a file, so a torn or unparsable line is detectable. */
/** Adds two buckets. Exported so the day index can merge without duplicating it. */
export function mergeBucketsInternal(a: CompactedBucket, b: CompactedBucket): CompactedBucket {
  const histogram = a.latencyHistogram.map((count, index) => count + (b.latencyHistogram[index] ?? 0));
  return {
    byModel: mergeCounts(a.byModel, b.byModel),
    byProvider: mergeCounts(a.byProvider, b.byProvider),
    byClient: mergeCounts(a.byClient, b.byClient),
    byClientIp: mergeCounts(a.byClientIp, b.byClientIp),
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
    creditUsed: a.creditUsed + b.creditUsed,
    succeeded: a.succeeded + b.succeeded,
    failed: a.failed + b.failed,
    cancelled: a.cancelled + b.cancelled,
    truncated: a.truncated + b.truncated,
    latencySum: a.latencySum + b.latencySum,
    latencyCount: a.latencyCount + b.latencyCount,
    latencyMinMs:
      a.latencyMinMs === null
        ? b.latencyMinMs
        : b.latencyMinMs === null
          ? a.latencyMinMs
          : Math.min(a.latencyMinMs, b.latencyMinMs),
    latencyMaxMs:
      a.latencyMaxMs === null
        ? b.latencyMaxMs
        : b.latencyMaxMs === null
          ? a.latencyMaxMs
          : Math.max(a.latencyMaxMs, b.latencyMaxMs),
    latencyHistogram: histogram,
    tokensPerSecSum: a.tokensPerSecSum + b.tokensPerSecSum,
    tokensPerSecCount: a.tokensPerSecCount + b.tokensPerSecCount,
    unpriced: a.unpriced + b.unpriced,
  };
}
