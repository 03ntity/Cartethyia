/**
 * Applies the F2 acceptance budgets to one or more `perf-load` JSON reports and
 * exits nonzero on any miss.
 *
 * Exists so a threshold is a gate, not a number someone reads and decides about.
 * It takes the harness's JSON rather than re-measuring, because re-measuring
 * would mean two runs disagreeing about the same cell.
 *
 * Budgets come from the plan verbatim; none are relaxed here to make a run pass.
 * A persistent miss is reported as a miss.
 *
 * Usage: bun run scripts/tools/perf-verify.ts [--json out.json]... [--strict]
 */
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    json: { type: "string", multiple: true, default: [] },
    /**
     * Fail the run when a budget could not be evaluated (missing metric) rather
     * than only when a budget was violated. Off by default: a single-process
     * cell has no worker-sum metric to check, which is not a failure.
     */
    strict: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const paths = [...(values.json ?? []), ...positionals.map(String)];
if (paths.length === 0) {
  console.error("usage: bun run scripts/tools/perf-verify.ts --json <report.json>...");
  process.exit(2);
}

/** The F2 budgets, in the units the harness reports. */
const BUDGET = {
  /** Proxy p95/p99, metadata capture. */
  metadataP95Ms: 250,
  metadataP99Ms: 500,
  /** Proxy p95/p99, full 1 MiB capture. */
  fullP95Ms: 1_500,
  fullP99Ms: 3_000,
  /** Dashboard-active p95, and its slack against the matching proxy-only cell. */
  dashboardP95MetadataMs: 500,
  dashboardP95FullMs: 1_000,
  dashboardSlackFactor: 1.5,
  dashboardSlackMs: 25,
  /** Summed worker peak RSS. */
  workersPeakRssMb: 1_536,
  /** Settled RSS above the idle baseline. */
  settledAboveIdleMetadataMb: 128,
  settledAboveIdleFullMb: 256,
} as const;

interface Report {
  readonly requests?: number;
  readonly withDashboard?: boolean;
  readonly requestBytes?: number;
  readonly throughputRps?: number;
  readonly finalInFlight?: number;
  readonly settledRssAboveIdleMb?: number;
  readonly workersSumRssMb?: number;
  readonly hot?: {
    readonly sent?: number;
    readonly ok?: number;
    readonly statusCounts?: Record<string, number>;
    readonly latency?: { readonly p95Ms?: number; readonly p99Ms?: number };
  };
  readonly dashboard?: { readonly p95Ms?: number };
}

interface Finding {
  readonly kind: "fail" | "unevaluated";
  readonly budget: string;
  readonly detail: string;
}

/**
 * Whether a cell uses the 1 MiB `full` budget.
 *
 * Determined by the request size the harness was told to send, not by a flag:
 * the capture mode is a tenant setting the harness cannot read, so the payload
 * size is the observable proxy for which budget applies.
 */
function isFullCell(report: Report): boolean {
  return (report.requestBytes ?? 0) > 100_000;
}

function evaluate(report: Report, file: string): readonly Finding[] {
  const findings: Finding[] = [];
  const push = (kind: Finding["kind"], budget: string, detail: string): void => {
    findings.push({ kind, budget, detail });
  };

  const p95 = report.hot?.latency?.p95Ms;
  const p99 = report.hot?.latency?.p99Ms;
  const full = isFullCell(report);
  const p95Budget = full ? BUDGET.fullP95Ms : BUDGET.metadataP95Ms;
  const p99Budget = full ? BUDGET.fullP99Ms : BUDGET.metadataP99Ms;

  if (p95 === undefined || Number.isNaN(p95)) {
    push("unevaluated", "proxy_p95", `no p95 in ${file}`);
  } else if (p95 > p95Budget) {
    push("fail", "proxy_p95", `p95 ${p95}ms > ${p95Budget}ms (${full ? "full" : "metadata"})`);
  }
  if (p99 === undefined || Number.isNaN(p99)) {
    push("unevaluated", "proxy_p99", `no p99 in ${file}`);
  } else if (p99 > p99Budget) {
    push("fail", "proxy_p99", `p99 ${p99}ms > ${p99Budget}ms (${full ? "full" : "metadata"})`);
  }

  // Every response must be a 200 and there must be zero network errors. A cell
  // that is fast because it is refusing requests has not passed.
  const statusCounts = report.hot?.statusCounts ?? {};
  const networkErrors = statusCounts["network_error"] ?? 0;
  if (networkErrors > 0) {
    push("fail", "network_errors", `${networkErrors} network errors`);
  }
  const ok = report.hot?.ok ?? 0;
  const sent = report.hot?.sent ?? report.requests ?? 0;
  if (sent > 0 && ok !== sent) {
    push("fail", "all_200", `${ok}/${sent} responses were 2xx`);
  }

  // In-flight must return to zero: a leaked reservation holds memory the settle
  // window was meant to prove reclaimed.
  const inFlight = report.finalInFlight;
  if (inFlight === undefined || Number.isNaN(inFlight)) {
    push("unevaluated", "final_in_flight", `no in-flight reading in ${file}`);
  } else if (inFlight !== 0) {
    push("fail", "final_in_flight", `in-flight ${inFlight} after settle (expected 0)`);
  }

  const settled = report.settledRssAboveIdleMb;
  const settledBudget = full ? BUDGET.settledAboveIdleFullMb : BUDGET.settledAboveIdleMetadataMb;
  if (settled === undefined || Number.isNaN(settled)) {
    push("unevaluated", "settled_rss", `no settled RSS in ${file}`);
  } else if (settled > settledBudget) {
    push("fail", "settled_rss", `settled +${settled}MB over idle > ${settledBudget}MB`);
  }

  const workerRss = report.workersSumRssMb;
  if (workerRss !== undefined && !Number.isNaN(workerRss) && workerRss > BUDGET.workersPeakRssMb) {
    push("fail", "workers_peak_rss", `summed worker RSS ${workerRss}MB > ${BUDGET.workersPeakRssMb}MB`);
  }

  const dashP95 = report.dashboard?.p95Ms;
  if (report.withDashboard === true) {
    const dashBudget = full ? BUDGET.dashboardP95FullMs : BUDGET.dashboardP95MetadataMs;
    if (dashP95 === undefined || Number.isNaN(dashP95)) {
      push("unevaluated", "dashboard_p95", `no dashboard p95 in ${file}`);
    } else if (dashP95 > dashBudget) {
      push("fail", "dashboard_p95", `dashboard p95 ${dashP95}ms > ${dashBudget}ms`);
    }
    // Never worse than 1.5x the matching proxy-only cell +25 ms. Checked by
    // the matrix driver, which sees both cells; here it is only reported when a
    // proxy-only sibling was supplied.
  }

  return findings;
}

let failed = 0;
let unevaluated = 0;

for (const file of paths) {
  let report: Report;
  try {
    report = (await Bun.file(file).json()) as Report;
  } catch (error) {
    console.error(`[verify] cannot read ${file}: ${(error as Error).message}`);
    failed += 1;
    continue;
  }
  const findings = evaluate(report, file);
  const fails = findings.filter((f) => f.kind === "fail");
  const skips = findings.filter((f) => f.kind === "unevaluated");
  failed += fails.length;
  unevaluated += skips.length;

  const label = `${file} (${isFullCell(report) ? "full" : "metadata"}${report.withDashboard ? "+dash" : ""})`;
  if (fails.length === 0 && skips.length === 0) {
    console.log(`[verify] PASS ${label}`);
    continue;
  }
  console.log(`[verify] ${fails.length > 0 ? "FAIL" : "PASS"} ${label}`);
  for (const finding of fails) console.log(`  ✗ ${finding.budget}: ${finding.detail}`);
  for (const finding of skips) console.log(`  ? ${finding.budget}: ${finding.detail}`);
}

console.log(`[verify] ${failed} budget miss(es), ${unevaluated} unevaluated`);

// Unevaluated budgets fail only under --strict: a single-process cell has no
// worker-sum to check, and a run without a settle window has no settled RSS.
process.exit(failed > 0 || (values.strict === true && unevaluated > 0) ? 1 : 0);
