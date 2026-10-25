/**
 * Drives the F2 acceptance matrix and writes one JSON report per cell.
 *
 * The matrix is {1,2} workers × {no Redis, Redis} × {no dashboard, active} ×
 * {metadata, full/1 MiB}. Each cell is run `--runs` times and the WORST run is
 * kept, because an acceptance budget is a worst-case claim: reporting the best
 * of three would describe the machine on a good day, not what an operator can
 * rely on.
 *
 * `--profile` names an optional file describing the machine the numbers are
 * being read against. It is NOT used to relax any budget — it is recorded so a
 * report cannot be read as a VPS measurement when it was taken on a bigger box.
 *
 * Usage: bun run scripts/tools/perf-matrix.ts [--runs 3] [--settle 60]
 *        [--requests 4000] [--concurrency 40] [--only name-substring]
 *        [--profile machine.json] [--out-dir reports/]
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    settle: { type: "string", default: "60" },
    requests: { type: "string", default: "4000" },
    concurrency: { type: "string", default: "40" },
    warmup: { type: "string", default: "200" },
    "dashboard-rps": { type: "string", default: "2" },
    /** Substring filter, so one cell can be re-run without the whole matrix. */
    only: { type: "string" },
    /** Machine description recorded into every report. Never relaxes a budget. */
    profile: { type: "string" },
    "out-dir": { type: "string", default: "reports" },
    /**
     * Skip multi-worker cells with a recorded reason instead of running them
     * into a precondition the topology guard enforces by design (Linux + full
     * mode + reachable Redis). Skipping silently would be a lie; this makes the
     * omission part of the report.
     */
    "skip-multi-worker": { type: "boolean", default: false },
    port: { type: "string", default: "9901" },
    "upstream-port": { type: "string", default: "9911" },
  },
});

const R = {
  runs: Number(values.runs),
  settle: Number(values.settle),
  requests: Number(values.requests),
  concurrency: Number(values.concurrency),
  warmup: Number(values.warmup),
  dashboardRps: Number(values["dashboard-rps"]),
  only: values.only ? String(values.only) : undefined,
  profile: values.profile ? String(values.profile) : undefined,
  outDir: String(values["out-dir"]),
  port: String(values.port),
  upstreamPort: String(values["upstream-port"]),
};

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(REPO, R.outDir);
mkdirSync(OUT, { recursive: true });

/** The reported production payload shape. */
const REQUEST_BYTES = 743_600;
const RESPONSE_BYTES = 55_000;

interface Profile {
  readonly label?: string;
  readonly cores?: number;
  readonly memoryMb?: number;
  readonly note?: string;
}

let profile: Profile = {};
if (R.profile !== undefined) {
  try {
    profile = (await Bun.file(R.profile).json()) as Profile;
  } catch (error) {
    console.error(`[matrix] cannot read profile: ${(error as Error).message}`);
  }
}

interface Cell {
  readonly name: string;
  readonly workers: 1 | 2;
  readonly redis: boolean;
  readonly dashboard: boolean;
  readonly full: boolean;
}

const skipMulti = values["skip-multi-worker"] === true;
const CELLS: Cell[] = [];
for (const workers of [1, 2] as const) {
  if (skipMulti && workers > 1) continue;
  for (const redis of [false, true]) {
    for (const dashboard of [false, true]) {
      for (const full of [false, true]) {
        CELLS.push({
          name: `w${workers}-${redis ? "redis" : "noredis"}-${dashboard ? "dash" : "nodash"}-${full ? "full" : "meta"}`,
          workers,
          redis,
          dashboard,
          full,
        });
      }
    }
  }
}

const selected = R.only === undefined ? CELLS : CELLS.filter((cell) => cell.name.includes(R.only as string));
if (selected.length === 0) {
  console.error(`[matrix] no cell matches --only ${R.only}`);
  process.exit(2);
}

/** Runs one command, returning its stdout. */
async function run(args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${args.join(" ")} exited ${code}\n${stderr.slice(-800)}`);
  }
  return stdout;
}

console.log(
  `[matrix] cells=${selected.length} runs=${R.runs} requests=${R.requests} concurrency=${R.concurrency} ` +
    `settle=${R.settle} out=${R.outDir}`,
);
if (skipMulti) {
  console.log(
    "[matrix] NOTE: multi-worker cells SKIPPED. Multi-process requires Linux, " +
      "CARTETHYIA_DB_MODE=full, and a reachable Redis; this host does not satisfy them, " +
      "so those cells are omitted rather than reported as failures.",
  );
}
if (profile.memoryMb !== undefined) {
  console.log(
    `[matrix] profile: ${profile.label ?? "unnamed"} — ${profile.cores ?? "?"} core(s), ` +
      `${profile.memoryMb}MB RAM${profile.note ? ` — ${profile.note}` : ""}`,
  );
  console.log("[matrix] NOTE: budgets are NOT scaled by this profile. It is recorded for honest reading only.");
}

let gateFailures = 0;

for (const cell of selected) {
  console.log(`\n[matrix] === ${cell.name} ===`);
  const worstPath = join(OUT, `${cell.name}.worst.json`);
  let worst: { score: number; path: string; report: unknown } | undefined;

  for (let runIndex = 1; runIndex <= R.runs; runIndex += 1) {
    const reportPath = join(OUT, `${cell.name}.run${runIndex}.json`);
    try {
      await run([
        "bun",
        "run",
        "scripts/tools/perf-cell.ts",
        "--name",
        cell.name,
        "--workers",
        String(cell.workers),
        ...(cell.redis ? ["--redis"] : []),
        ...(cell.dashboard ? ["--dashboard"] : []),
        ...(cell.full ? ["--full"] : []),
        "--requests",
        String(R.requests),
        "--concurrency",
        String(R.concurrency),
        "--settle",
        String(R.settle),
        "--warmup",
        String(R.warmup),
        "--dashboard-rps",
        String(R.dashboardRps),
        ...(cell.full
          ? ["--request-bytes", String(REQUEST_BYTES), "--response-bytes", String(RESPONSE_BYTES)]
          : []),
        "--port",
        R.port,
        "--upstream-port",
        R.upstreamPort,
        "--json",
        reportPath,
      ]);
    } catch (error) {
      console.error(`[matrix] ${cell.name} run ${runIndex} FAILED: ${(error as Error).message}`);
      gateFailures += 1;
      continue;
    }

    const report = (await Bun.file(reportPath).json()) as {
      readonly hot?: { readonly latency?: { readonly p95Ms?: number; readonly p99Ms?: number } };
      readonly workersSumRssMb?: number;
    };
    // Worst-of: the higher of p95/p99 plus any worker RSS, so a cell that
    // passed on two good runs and failed on one is recorded as failing.
    const score =
      Math.max(report.hot?.latency?.p95Ms ?? 0, report.hot?.latency?.p99Ms ?? 0) +
      (report.workersSumRssMb ?? 0) / 100;
    if (worst === undefined || score >= worst.score) worst = { score, path: reportPath, report };
    console.log(`[matrix] ${cell.name} run ${runIndex}: p95=${report.hot?.latency?.p95Ms}ms p99=${report.hot?.latency?.p99Ms}ms`);
  }

  if (worst === undefined) continue;
  writeFileSync(worstPath, JSON.stringify({ ...(worst.report as object), cell, profile }, null, 2));
  console.log(`[matrix] ${cell.name} worst -> ${worstPath} (score ${Math.round(worst.score)})`);

  const verify = Bun.spawn(["bun", "run", "scripts/tools/perf-verify.ts", worstPath], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [vOut, vCode] = await Promise.all([new Response(verify.stdout).text(), verify.exited]);
  console.log(vOut.trim());
  if (vCode !== 0) gateFailures += 1;
}

console.log(`\n[matrix] done — ${gateFailures} cell(s) failed the budget gate`);
process.exit(gateFailures > 0 ? 1 : 0);
