import { describe, expect, test } from "bun:test";
import { summarizeBucketPerformance, summarizeUsagePerformance } from "../../src/console/observability/store";
import {
  accumulate,
  emptyBucket,
  HISTOGRAM_OVERFLOW_MS,
  mergeBucketsInternal,
} from "../../src/observability/event-compaction";

test("usage performance reports routing average and P50/P95/P99 latency", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    latencyMs: index + 1,
    resolveMs: index === 1 ? 100 : index === 2 ? 300 : null,
  }));

  expect(summarizeUsagePerformance(events)).toEqual({
    avgResolveMs: 200,
    avgDurationMs: 50.5,
    latencyP50Ms: 50,
    latencyP95Ms: 95,
    latencyP99Ms: 99,
    // Every row carries a latency; only two carry a resolve measurement.
    latencySampleCount: 100,
    resolveSampleCount: 2,
  });
});

test("usage performance returns zero metrics when the period has no events", () => {
  expect(summarizeUsagePerformance([])).toEqual({
    avgResolveMs: 0,
    avgDurationMs: 0,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
    latencyP99Ms: 0,
    latencySampleCount: 0,
    resolveSampleCount: 0,
  });
});

test("the sample count is what separates a meaningful P99 from a guess", () => {
  // Three rows make P99 the slowest request, not a percentile. The count is
  // the only thing in the payload that says so.
  const events = [
    { latencyMs: 10, resolveMs: null },
    { latencyMs: 20, resolveMs: null },
    { latencyMs: 900, resolveMs: null },
  ];
  const summary = summarizeUsagePerformance(events);
  expect(summary.latencyP99Ms).toBe(900);
  expect(summary.latencySampleCount).toBe(3);
  expect(summary.resolveSampleCount).toBe(0);
});

/**
 * The same figures after the day's events have been folded into the index.
 *
 * The three defects below all had one shape: a number that lived on the event
 * was not carried into the index, so it read correctly for today and zero for
 * everything already folded. Each is asserted through `accumulate`, because
 * that is the fold — a test on `summarizeBucketPerformance` with a hand-built
 * bucket would pass regardless of whether the fold ever wrote the field.
 */
describe("indexed performance survives compaction", () => {
  /** Folds `events` into one bucket, the way the day index does. */
  function fold(events: readonly { latencyMs: number | null; resolveMs?: number | null; httpStatus?: number | null }[]) {
    let bucket = emptyBucket();
    for (const event of events) {
      bucket = accumulate(bucket, {
        latencyMs: event.latencyMs,
        resolveMs: event.resolveMs ?? null,
        httpStatus: event.httpStatus ?? null,
      } as never);
    }
    return bucket;
  }

  test("routing delay survives the fold", () => {
    // `avgResolveMs` was hardcoded to 0 in the bucket path, so the Resolve
    // figure read zero for every day except today's unfolded tail.
    const bucket = fold([
      { latencyMs: 100, resolveMs: 40 },
      { latencyMs: 200, resolveMs: 60 },
      { latencyMs: 300, resolveMs: null },
    ]);
    const summary = summarizeBucketPerformance([bucket as never]);
    expect(summary.avgResolveMs).toBe(50);
    expect(summary.resolveSampleCount).toBe(2);
  });

  test("status counts survive the fold", () => {
    const bucket = fold([
      { latencyMs: 100, httpStatus: 200 },
      { latencyMs: 100, httpStatus: 200 },
      { latencyMs: 100, httpStatus: 429 },
    ]);
    // Keyed on the HTTP status the client was given, as decimal strings.
    expect(bucket.byStatus).toEqual({ "200": 2, "429": 1 });
  });

  test("a percentile past the histogram's last edge is not reported as zero", () => {
    // LATENCY_BUCKETS_MS ends at 10_000, so everything above it lands in the
    // overflow bucket. That bucket has no upper edge and used to return `null`,
    // which `?? 0` turned into "0 ms" — the slow tail rendered as nothing while
    // the mean beside it read 40 s.
    const bucket = fold([
      { latencyMs: 8_000 },
      { latencyMs: 40_000 },
      { latencyMs: 40_000 },
    ]);
    const summary = summarizeBucketPerformance([bucket as never]);
    expect(summary.latencyP95Ms).toBe(40_000);
    expect(summary.latencyP99Ms).toBe(40_000);
    // And the mean stays the true mean, so the two figures agree.
    expect(summary.avgDurationMs).toBeCloseTo(29_333, 0);
  });

  test("an overflow percentile never reads slower than the recorded max", () => {
    // The overflow answer is the period's max, so it can overshoot a little on
    // a percentile that is merely above the last edge — but it must never fall
    // below the last edge, which is what 0 did.
    const bucket = fold([{ latencyMs: 12_000 }, { latencyMs: 12_000 }]);
    const summary = summarizeBucketPerformance([bucket as never]);
    expect(summary.latencyP50Ms).toBe(12_000);
    expect(summary.latencyP50Ms).toBeGreaterThanOrEqual(HISTOGRAM_OVERFLOW_MS);
  });

  test("merging two buckets keeps the new fields", () => {
    const merged = mergeBucketsInternal(
      fold([{ latencyMs: 100, resolveMs: 20, httpStatus: 200 }]) as never,
      fold([{ latencyMs: 100, resolveMs: 40, httpStatus: 500 }]) as never,
    );
    expect(merged.resolveSumMs).toBe(60);
    expect(merged.resolveCount).toBe(2);
    expect(merged.byStatus).toEqual({ "200": 1, "500": 1 });
  });
});

describe("an index written before the new fields existed", () => {
  /** A bucket shaped like one this build no longer writes. */
  function legacyBucket() {
    const bucket: Record<string, unknown> = { ...emptyBucket() };
    delete bucket["byStatus"];
    delete bucket["resolveSumMs"];
    delete bucket["resolveCount"];
    return bucket as never;
  }

  test("folding into it does not produce NaN", () => {
    // `undefined + 0` is NaN, and NaN survives every later fold and merge: one
    // day from before the field would turn the whole period's `avgResolveMs`
    // into NaN, which is worse than the zero it replaced.
    const grown = accumulate(legacyBucket(), {
      latencyMs: 100,
      resolveMs: 30,
      httpStatus: 200,
    } as never);
    expect(Number.isNaN(grown.resolveSumMs)).toBe(false);
    expect(grown.resolveSumMs).toBe(30);
    expect(grown.resolveCount).toBe(1);
    expect(grown.byStatus).toEqual({ "200": 1 });
  });

  test("merging it does not produce NaN", () => {
    const merged = mergeBucketsInternal(legacyBucket(), legacyBucket());
    expect(Number.isNaN(merged.resolveSumMs)).toBe(false);
    expect(merged.resolveSumMs).toBe(0);
    expect(merged.byStatus).toEqual({});
  });

  test("the summary of a legacy bucket still reports real zeroes", () => {
    const summary = summarizeBucketPerformance([legacyBucket()]);
    for (const value of Object.values(summary)) expect(Number.isNaN(value)).toBe(false);
    expect(summary.avgResolveMs).toBe(0);
  });
});

test("a legacy day beside a current one does not poison the average", () => {
  // The case the guard in `summarizeBucketPerformance` actually protects: one
  // old day missing the field plus one new day carrying it. Without coercion
  // the sum is NaN and the average is NaN, so a period that does have resolve
  // data reports nothing because a neighbouring day predates the field.
  const legacy = { ...emptyBucket() } as Record<string, unknown>;
  delete legacy["resolveSumMs"];
  delete legacy["resolveCount"];
  const current = accumulate(emptyBucket(), {
    latencyMs: 100,
    resolveMs: 40,
    httpStatus: 200,
  } as never);
  const summary = summarizeBucketPerformance([legacy as never, current as never]);
  expect(Number.isNaN(summary.avgResolveMs)).toBe(false);
  expect(summary.avgResolveMs).toBe(40);
});
