/**
 * Drives concurrent load at a running gateway and reports what the audit needs.
 *
 * Deliberately measures two things separately:
 *
 * - **Hot path** — `POST /v1/chat/completions` on the seeded model. The
 *   upstream is unroutable, so this exercises everything the gateway owns
 *   (auth, admission, routing, lease, attempt bookkeeping, telemetry, release)
 *   and none of the provider's latency. That is the part under investigation.
 * - **Dashboard** — `GET /console/api/*` endpoints, driven *concurrently* with
 *   the hot path so contention is visible rather than inferred.
 *
 * Reports p50/p95/p99 per surface, and samples RSS/heap before, during, and
 * after so a reclaim claim is backed by numbers instead of a vibe.
 *
 * Usage: bun run scripts/tools/perf-load.ts --concurrency 40 --requests 400
 *        [--dashboard] [--base http://127.0.0.1:9901] [--token <key>]
 *        [--settle 30] [--json out.json]
 *        [--request-bytes 743600] [--response-bytes 55000] [--warmup 200]
 *        [--workers <n>...]
 *
 * `--request-bytes`/`--response-bytes` size the payload the way the reported
 * production shape does, so `full` capture is measured against the body it
 * actually has to hold. `--warmup` requests are sent and DISCARDED: they exist
 * to get the process to steady state (pool filled, caches warm, JIT settled)
 * and including them in the percentiles would report cold-start latency as if
 * it were steady-state latency.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const { values } = parseArgs({
  options: {
    concurrency: { type: "string", default: "40" },
    requests: { type: "string", default: "400" },
    base: { type: "string", default: "http://127.0.0.1:9901" },
    token: { type: "string" },
    model: { type: "string" },
    dashboard: { type: "boolean", default: false },
    "dashboard-rps": { type: "string", default: "2" },
    settle: { type: "string", default: "30" },
    json: { type: "string" },
    /** Target size of the request body, in bytes. Fills the messages content. */
    "request-bytes": { type: "string", default: "0" },
    /** Requested `max_tokens`, as a proxy for response size. */
    "response-bytes": { type: "string", default: "0" },
    /** Requests sent and discarded before measurement begins. */
    warmup: { type: "string", default: "0" },
    /**
     * Per-worker PID/RSS file, written by the matrix driver: a newline-separated
     * `pid<TAB>rssBytes` list. Lets the harness attribute memory and traffic to
     * each process instead of reporting one opaque total.
     */
    "workers-file": { type: "string" },
  },
});

const base = String(values.base);
const concurrency = Number(values.concurrency);
const total = Number(values.requests);
const withDashboard = values.dashboard === true;
const dashboardRps = Number(values["dashboard-rps"]);
const settleSeconds = Number(values.settle);
const token = values.token ? String(values.token) : undefined;
const model = values.model ? String(values.model) : undefined;
const requestBytes = Number(values["request-bytes"]);
const responseBytes = Number(values["response-bytes"]);
const warmup = Number(values.warmup);
const workersFile = values["workers-file"] ? String(values["workers-file"]) : undefined;

if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("--concurrency must be >= 1");
if (!Number.isFinite(total) || total < 1) throw new Error("--requests must be >= 1");
if (!token || !model) throw new Error("--token and --model are required (run scripts/tools/perf-seed.ts first)");

/** Dashboard routes that read aggregated data, hit alongside the hot path. */
const DASHBOARD_PATHS = [
  "/console/api/usage/summary",
  "/console/api/requests/recent",
  "/console/api/providers",
  "/console/api/models",
  "/console/api/accounts",
] as const;

type Sample = { readonly rssMb: number; readonly heapMb: number; readonly inFlight: number };

async function sample(): Promise<Sample> {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heapMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    inFlight: 0,
  };
}

/** Reads the gateway's own process memory, not this harness's. */
async function gatewayMemory(): Promise<Sample> {
  // Retried: the probe competes with the load it is measuring for a
  // connection, and one failed attempt must not cost the run its memory
  // numbers — the reclaim evidence is half the point.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // A longer timeout than the default: under peak load this probe is one
      // more client competing for the listener, and losing it silently is what
      // made the memory columns read NaN on earlier runs.
      const response = await fetch(`${base}/metrics`, {
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      const gauge = (name: string): number => {
        const match = new RegExp(`^${name} (\\d+)$`, "m").exec(text);
        return match ? Number(match[1]) : Number.NaN;
      };
      const inFlightMatch = /^proxy_in_flight (\d+)$/m.exec(text);
      return {
        rssMb: Math.round((gauge("cartethyia_memory_rss_bytes") / 1024 / 1024) * 10) / 10,
        heapMb: Math.round((gauge("cartethyia_memory_heap_used_bytes") / 1024 / 1024) * 10) / 10,
        inFlight: inFlightMatch ? Number(inFlightMatch[1]) : Number.NaN,
      };
    } catch (error) {
      if (attempt < 2) {
        await Bun.sleep(250);
        continue;
      }
      console.log(`[load] metrics sample failed: ${(error as Error).message}`);
    }
  }
  return { rssMb: Number.NaN, heapMb: Number.NaN, inFlight: Number.NaN };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function summarize(values: readonly number[]): {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly errors: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  return {
    count: values.length,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
    errors: 0,
  };
}

interface SurfaceResult {
  readonly surface: string;
  readonly sent: number;
  readonly ok: number;
  readonly statusCounts: Record<string, number>;
  readonly latency: ReturnType<typeof summarize>;
}

async function driveSurface(
  surface: string,
  path: string,
  init: () => { method: string; headers: Record<string, string>; body?: string },
  count: number,
  parallel: number,
): Promise<SurfaceResult> {
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const mine = index;
      index += 1;
      if (mine >= count) return;
      const started = Bun.nanoseconds();
      try {
        const response = await fetch(`${base}${path}`, init() as RequestInit);
        await response.arrayBuffer();
        const bucket = String(response.status);
        statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
      } catch {
        statusCounts.network_error = (statusCounts.network_error ?? 0) + 1;
      }
      latencies.push((Bun.nanoseconds() - started) / 1e6);
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  const ok = Object.entries(statusCounts)
    .filter(([status]) => status.startsWith("2"))
    .reduce((sum, [, n]) => sum + n, 0);
  return { surface, sent: count, ok, statusCounts, latency: summarize(latencies) };
}

/**
 * Per-worker process attribution, read from `--workers-file`.
 *
 * A summed RSS total cannot answer the question that matters for multi-process:
 * did BOTH workers actually serve traffic? The health endpoint reports each
 * process's own `pid` and request count, so this joins the harness's PID list
 * against each worker's own report.
 */
async function workerAttribution(): Promise<
  readonly { readonly pid: number; readonly rssBytes: number; readonly pidMatches: boolean }[]
> {
  if (workersFile === undefined) return [];
  let raw: string;
  try {
    raw = readFileSync(workersFile, "utf8");
  } catch {
    return [];
  }
  const declared = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pidText, rssText] = line.split("\t");
      return { pid: Number(pidText), rssBytes: Number(rssText) };
    })
    .filter((entry) => Number.isFinite(entry.pid));

  // Which PIDs the gateway itself reports. `pid` is in the health payload, so
  // this is the gateway's own view rather than the harness's assumption.
  const reportedPids = new Set<number>();
  try {
    const response = await fetch(`${base}/console/api/observability/system/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as { pid?: number };
    if (typeof body.pid === "number") reportedPids.add(body.pid);
  } catch {
    // Health being unreachable is itself a finding; the join just reports no
    // match rather than failing the run.
  }
  return declared.map((entry) => ({
    ...entry,
    pidMatches: reportedPids.size === 0 ? false : reportedPids.has(entry.pid),
  }));
}

/**
 * The request body, sized to `--request-bytes`.
 *
 * Measured in UTF-8 bytes, not characters: a 743,600-byte body of CJK is a
 * third of the characters, and a cap measured in code units would be three
 * times the intended budget. Built once and reused — rebuilding a ~744 KB
 * string per request would make the harness, not the gateway, the bottleneck.
 */
const sizedContent =
  requestBytes > 0 ? "x".repeat(requestBytes) : "Say hello to Cartethyia.";
const sizedMaxTokens = responseBytes > 0 ? Math.max(1, Math.round(responseBytes / 4)) : 64;

/**
 * The whole request init, built ONCE.
 *
 * Every field is constant for a run — model, token, headers, body — so
 * serializing per request was pure waste. At a 50 MB body that is a 50 MB
 * stringify PER REQUEST, which makes the harness the bottleneck and allocates
 * gigabytes in the load generator, not in the gateway being measured. This is
 * both the single biggest speed win and the difference between a body-size run
 * being feasible and not.
 */
const chatInitValue = {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: sizedMaxTokens,
    stream: false,
    messages: [{ role: "user", content: sizedContent }],
  }),
};

const chatInit = () => chatInitValue;

console.log(
  `[load] base=${base} concurrency=${concurrency} requests=${total} dashboard=${withDashboard} ` +
    `requestBytes=${requestBytes} responseBytes=${responseBytes} warmup=${warmup}`,
);

const idleBefore = await gatewayMemory();
console.log(`[load] idle  rss=${idleBefore.rssMb}MB heap=${idleBefore.heapMb}MB`);

if (warmup > 0) {
  // Sent and DISCARDED. The first requests after boot pay connection-pool
  // setup, cache misses, and JIT warmup; counting them would report cold-start
  // latency as steady-state latency and make every cell look worse than the
  // deployment actually runs.
  const warmed = await driveSurface("warmup", "/v1/chat/completions", chatInit, warmup, concurrency);
  console.log(
    `[load] warmup sent=${warmed.sent} ok=${warmed.ok} p95=${warmed.latency.p95Ms}ms ` +
      `(excluded from results)`,
  );
}

const started = Date.now();
const dashboardLatencies: number[] = [];
let dashboardStop = false;
const dashboardTask = (async () => {
  if (!withDashboard) return;
  const intervalMs = Math.max(20, Math.round(1000 / Math.max(1, dashboardRps)));
  let pathIndex = 0;
  while (!dashboardStop) {
    const path = DASHBOARD_PATHS[pathIndex % DASHBOARD_PATHS.length]!;
    pathIndex += 1;
    const t0 = Bun.nanoseconds();
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.arrayBuffer();
    } catch {
      // Counted as latency only; a refusal is still contention evidence.
    }
    dashboardLatencies.push((Bun.nanoseconds() - t0) / 1e6);
    await Bun.sleep(intervalMs);
  }
})();

const hot = await driveSurface("chat", "/v1/chat/completions", chatInit, total, concurrency);
const duringPeak = await gatewayMemory();
dashboardStop = true;
await dashboardTask;
const elapsedMs = Date.now() - started;

console.log(
  `[load] peak  rss=${duringPeak.rssMb}MB heap=${duringPeak.heapMb}MB inFlight=${duringPeak.inFlight} ` +
    `elapsed=${elapsedMs}ms throughput=${Math.round((total / elapsedMs) * 1000)}req/s`,
);
console.log(
  `[load] hot   p50=${hot.latency.p50Ms}ms p95=${hot.latency.p95Ms}ms p99=${hot.latency.p99Ms}ms ` +
    `mean=${hot.latency.meanMs}ms max=${hot.latency.maxMs}ms statuses=${JSON.stringify(hot.statusCounts)}`,
);
if (withDashboard) {
  console.log(
    `[load] dash  n=${dashboardLatencies.length} p50=${summarize(dashboardLatencies).p50Ms}ms ` +
      `p95=${summarize(dashboardLatencies).p95Ms}ms p99=${summarize(dashboardLatencies).p99Ms}ms`,
  );
}

let settled: Sample | undefined;
let workers: readonly { pid: number; rssBytes: number; pidMatches: boolean }[] = [];
if (settleSeconds > 0) {
  await Bun.sleep(settleSeconds * 1000);
  settled = await gatewayMemory();
  console.log(`[load] settled rss=${settled.rssMb}MB heap=${settled.heapMb}MB after ${settleSeconds}s`);
  console.log(
    `[load] reclaim rssDelta=${Math.round((settled.rssMb - duringPeak.rssMb) * 10) / 10}MB ` +
      `heapDelta=${Math.round((settled.heapMb - duringPeak.heapMb) * 10) / 10}MB`,
  );
  // Final in-flight must be zero: a leaked reservation or a stream that never
  // finalized would hold memory the settle window was supposed to prove
  // reclaimed.
  console.log(`[load] final inFlight=${settled.inFlight}`);
  workers = await workerAttribution();
  if (workers.length > 0) {
    const totalRss = workers.reduce((sum, w) => sum + w.rssBytes, 0);
    console.log(
      `[load] workers n=${workers.length} sumRssMb=${Math.round((totalRss / 1024 / 1024) * 10) / 10} ` +
        `pids=${workers.map((w) => w.pid).join(",")} matched=${workers.filter((w) => w.pidMatches).length}`,
    );
  }
}

if (values.json) {
  const dashboardSummary = withDashboard ? summarize(dashboardLatencies) : undefined;
  await Bun.write(
    String(values.json),
    JSON.stringify(
      {
        base,
        concurrency,
        requests: total,
        withDashboard,
        dashboardRps,
        requestBytes,
        responseBytes,
        warmup,
        elapsedMs,
        throughputRps: Math.round((total / elapsedMs) * 1000),
        idleBefore,
        duringPeak,
        // Settled memory and final in-flight, so a reclaim claim is a number
        // and not a vibe.
        settled,
        settledRssAboveIdleMb:
          settled === undefined || Number.isNaN(settled.rssMb) || Number.isNaN(idleBefore.rssMb)
            ? undefined
            : Math.round((settled.rssMb - idleBefore.rssMb) * 10) / 10,
        finalInFlight: settled?.inFlight,
        hot,
        dashboard: dashboardSummary,
        dashboardStatusCounts: withDashboard ? dashboardSummary?.errors : undefined,
        workers,
        workersSumRssMb:
          workers.length > 0
            ? Math.round((workers.reduce((sum, w) => sum + w.rssBytes, 0) / 1024 / 1024) * 10) / 10
            : undefined,
        harness: await sample(),
      },
      null,
      2,
    ),
  );
}
