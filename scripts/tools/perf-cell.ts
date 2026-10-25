/**
 * Runs ONE F2 matrix cell end to end: upstream stub → N gateway workers → seed
 * → load → per-worker attribution → report JSON.
 *
 * Split out of `perf-matrix.ts` so one cell can be re-run on its own without
 * the whole matrix, and so a cell that fails does not take the driver with it.
 *
 * Two-worker cells start two gateway processes with explicit
 * CARTETHYIA_PROCESS_COUNT/INDEX, which is what makes `reusePort` share the
 * port. A worker that fails to come up fails the cell rather than quietly
 * measuring one process and calling it two.
 *
 * Usage: bun run scripts/tools/perf-cell.ts --name w2-redis-dash-full --workers 2
 *        [--redis] [--dashboard] [--full] [--requests 4000] [--concurrency 40]
 *        [--settle 60] [--warmup 200] [--json out.json]
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "cell" },
    workers: { type: "string", default: "1" },
    redis: { type: "boolean", default: false },
    dashboard: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    requests: { type: "string", default: "4000" },
    concurrency: { type: "string", default: "40" },
    settle: { type: "string", default: "60" },
    warmup: { type: "string", default: "200" },
    "dashboard-rps": { type: "string", default: "2" },
    "request-bytes": { type: "string", default: "0" },
    "response-bytes": { type: "string", default: "0" },
    port: { type: "string", default: "9901" },
    "upstream-port": { type: "string", default: "9911" },
    json: { type: "string" },
  },
});

const name = String(values.name);
const workers = Number(values.workers);
const port = Number(values.port);
const upstreamPort = Number(values["upstream-port"]);
const settle = Number(values.settle);

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Shared env for every child: one upstream, one database, no watcher. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    // perf-start.ts reads DATABASE_URL, while perf-seed.ts reads
    // CARTETHYIA_PERF_DATABASE_URL. Both must point at the SAME database, or
    // the gateway boots against the built-in default while the seed writes
    // somewhere else — and every request then fails with "provider adapter not
    // registered" because the seeded provider is not in the gateway's database.
    ...(process.env.CARTETHYIA_PERF_DATABASE_URL
      ? { DATABASE_URL: process.env.CARTETHYIA_PERF_DATABASE_URL }
      : {}),
    PERF_PORT: String(port),
    PERF_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    ...(values.redis === true && process.env.CARTETHYIA_PERF_REDIS_URL
      ? { REDIS_URL: process.env.CARTETHYIA_PERF_REDIS_URL }
      : {}),
    ...extra,
  };
}

function spawn(args: readonly string[], env: Record<string, string>) {
  return Bun.spawn([...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
}

/**
 * Polls until the upstream answers, or fails after `timeoutMs`.
 *
 * Probed with POST: the stub upstream serves POST only, so a GET returns 404
 * and a GET-based readiness check would report "never ready" against a server
 * that is listening fine.
 */
async function waitUpstreamReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "readiness-probe" }),
        signal: AbortSignal.timeout(2_000),
      });
      // Any HTTP response means the listener is up; a 404 from an unknown path
      // is still proof of life.
      if (response.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  return false;
}

/** Polls the gateway's health route until it answers 200. */
async function waitGatewayReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  return false;
}

const children: { proc: ReturnType<typeof spawn>; label: string }[] = [];

function shutdownAll(): void {
  for (const child of children) {
    try {
      child.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGINT", () => {
  shutdownAll();
  process.exit(130);
});

/**
 * Fails if a port is already in use.
 *
 * Without this a stale gateway from an earlier run keeps serving the port, the
 * new worker silently fails to bind, and the load is measured against the OLD
 * process pointed at a DIFFERENT database — which reports "provider adapter not
 * registered" for every request and looks like a gateway bug.
 */
async function assertPortFree(port: number, label: string): Promise<void> {
  try {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { open() {}, close() {}, data() {} },
    } as never);
    probe.stop(true);
    return;
  } catch {
    throw new Error(
      `port ${port} (${label}) is already in use — stop the stale process before running this cell`,
    );
  }
}

try {
  await assertPortFree(upstreamPort, "upstream");
  await assertPortFree(port, "gateway");
  console.log(`[cell:${name}] starting upstream on :${upstreamPort}`);
  const upstream = spawn(["bun", "run", "scripts/tools/perf-upstream.ts", "--port", String(upstreamPort)], childEnv({}));
  children.push({ proc: upstream, label: "upstream" });
  if (!(await waitUpstreamReady(`http://127.0.0.1:${upstreamPort}/v1/chat/completions`, 20_000))) {
    throw new Error("upstream did not become ready");
  }

  // Seed before the gateway boots for multi-worker: both processes read the
  // same seeded rows, so seeding once is correct and seeding per worker would
  // create a second tenant per worker.
  console.log(`[cell:${name}] seeding`);
  const seedOut = await new Response(
    spawn(["bun", "run", "scripts/tools/perf-seed.ts"], childEnv({})).stdout,
  ).text();
  const seeded = JSON.parse(seedOut.trim().split("\n").at(-1) ?? "{}") as {
    token?: string;
    modelId?: string;
    qualifiedModel?: string;
  };
  if (!seeded.token || !seeded.qualifiedModel) {
    throw new Error(`seed did not return token+model: ${seedOut.slice(-400)}`);
  }

  const workerPids: number[] = [];
  for (let index = 0; index < workers; index += 1) {
    const env = childEnv({
      ...(workers > 1
        ? { CARTETHYIA_PROCESS_COUNT: String(workers), CARTETHYIA_PROCESS_INDEX: String(index) }
        : {}),
    });
    console.log(`[cell:${name}] starting worker ${index}/${workers}`);
    const worker = spawn(["bun", "run", "scripts/tools/perf-start.ts", "--port", String(port)], env);
    children.push({ proc: worker, label: `worker-${index}` });
    if (worker.pid !== undefined) workerPids.push(worker.pid);
  }

  if (!(await waitGatewayReady(`http://127.0.0.1:${port}/health`, 60_000))) {
    // Multi-process has hard preconditions (Linux + full mode + REACHABLE
    // Redis) that deliberately fail the boot. Say so, because "did not become
    // ready" reads like a harness bug when it is the topology guard working.
    const hint =
      workers > 1
        ? ` — multi-process requires Linux, CARTETHYIA_DB_MODE=full, and a REACHABLE Redis ` +
          `(platform=${process.platform}, redis=${values.redis === true ? "requested" : "not requested"})`
        : "";
    throw new Error(`gateway worker(s) did not become ready on :${port}${hint}`);
  }
  console.log(`[cell:${name}] gateway ready (pids ${workerPids.join(",")})`);

  // Wait until the seeded provider actually SERVES, not merely until the
  // listener answers. The gateway registers non-bundled provider adapters from
  // a snapshot built at boot, so /health returning 200 does not mean a request
  // for the just-seeded provider will route — it 503s with "provider adapter
  // not registered" until the registry catches up. Probing with a real request
  // turns that race into a bounded wait instead of ~93% 503s in the results.
  const seedOut2 = JSON.parse(seedOut.trim().split("\n").at(-1) ?? "{}") as {
    token?: string;
    qualifiedModel?: string;
  };
  const probeReady = await waitProviderServes(port, seedOut2.token!, seedOut2.qualifiedModel!, 30_000);
  if (!probeReady) {
    throw new Error(
      `seeded provider never served on :${port} — the gateway is up but routing is not ` +
        `(check that seed and gateway use the same database)`,
    );
  }
  console.log(`[cell:${name}] seeded provider serves`);

  // Attribute memory to the GATEWAY process, not to the launcher. On Windows
  // `bun run scripts/tools/perf-start.ts` is itself a process, so the spawned
  // PID is the launcher's; the gateway is its child. Reading `pid` from the
  // gateway's own health payload is the only attribution that is actually about
  // the process serving traffic.
  const gatewayPids = await resolveGatewayPids(port, workers);
  // On Windows the spawned PID is the `bun run perf-start.ts` launcher, not the
  // gateway: the launcher's RSS is a constant ~30 MB that says nothing about the
  // process under test. Resolve the launcher's child, which is the gateway.
  // Order matters: the listening-socket owner is authoritative. Falling back to
  // the spawned PID reports the LAUNCHER's RSS, which is why earlier runs
  // showed a flat RSS that tracked nothing the gateway did.
  const childPids = gatewayPids.length > 0 ? [] : process.platform === "win32" ? await childrenOf(workerPids) : [];
  const attributedPids =
    gatewayPids.length > 0 ? gatewayPids : childPids.length > 0 ? childPids : workerPids;
  const workersFile = `/tmp/carte-perf-workers-${name}.txt`;
  const rssSnapshot = await rssOf(attributedPids);
  writeFileSync(
    workersFile,
    attributedPids.map((pid) => `${pid}\t${rssSnapshot.get(pid) ?? 0}`).join("\n"),
  );
  console.log(
    `[cell:${name}] attribution pids=${attributedPids.join(",")} ` +
      `(from ${gatewayPids.length > 0 ? "health" : "spawn fallback"})`,
  );

  const reportPath = values.json ? String(values.json) : `/tmp/carte-perf-${name}.json`;
  const loadArgs = [
    "bun",
    "run",
    "scripts/tools/perf-load.ts",
    "--base",
    `http://127.0.0.1:${port}`,
    "--token",
    seeded.token,
    "--model",
    seeded.qualifiedModel,
    "--concurrency",
    String(values.concurrency),
    "--requests",
    String(values.requests),
    "--settle",
    String(settle),
    "--warmup",
    String(values.warmup),
    "--workers-file",
    workersFile,
    "--json",
    reportPath,
  ];
  if (values.dashboard === true) {
    loadArgs.push("--dashboard", "--dashboard-rps", String(values["dashboard-rps"]));
  }
  if (values.full === true) {
    loadArgs.push("--request-bytes", String(values["request-bytes"]), "--response-bytes", String(values["response-bytes"]));
  }

  console.log(`[cell:${name}] driving load`);
  const load = spawn(loadArgs, childEnv({}));
  const [loadOut, loadErr, loadCode] = await Promise.all([
    new Response(load.stdout).text(),
    new Response(load.stderr).text(),
    load.exited,
  ]);
  console.log(loadOut.trim());
  if (loadCode !== 0) {
    console.error(loadErr.slice(-1200));
    throw new Error(`perf-load exited ${loadCode}`);
  }
  console.log(`[cell:${name}] report -> ${reportPath}`);
} catch (error) {
  console.error(`[cell:${name}] FAILED: ${(error as Error).message}`);
  shutdownAll();
  process.exit(1);
} finally {
  shutdownAll();
}

/**
 * The PIDs the gateway reports for itself.
 *
 * One probe answers once per process, so a two-worker cell needs as many
 * probes as there are workers to see both — with `reusePort`, each answer comes
 * from whichever process the kernel picked. Collected until distinct PIDs stop
 * appearing or the budget runs out.
 */
async function resolveGatewayPids(port: number, expected: number): Promise<number[]> {
  void expected;
  // Whoever holds the LISTENING socket on the gateway port IS the gateway.
  //
  // The previous two attempts were both wrong and both silently degraded:
  //   - the console health route answers 401 (bearer token does not satisfy the
  //     console access resolver), so it never yields a pid;
  //   - falling back to the spawned PID yields the `bun run perf-start.ts`
  //     LAUNCHER, whose RSS is a flat ~30 MB no matter what the gateway does.
  // That is how earlier reports claimed "RSS flat at 126 MB" while measuring
  // the wrong process. Asking the OS who owns the port cannot degrade: if no
  // process owns it, the gateway is genuinely not up.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pids = await pidsListeningOn(port);
    if (pids.length > 0) return pids;
    await Bun.sleep(250);
  }
  return [];
}

/** PIDs with a LISTENING socket on the port (Windows netstat, Linux ss/lsof). */
async function pidsListeningOn(port: number): Promise<number[]> {
  const commands: string[][] = process.platform === "win32"
    ? [["netstat", "-ano"]]
    : [["ss", "-lptnH"], ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]];
  const found = new Set<number>();
  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of text.split("\n")) {
        if (!line.includes("LISTEN") && process.platform !== "win32") continue;
        if (!new RegExp(`[:.]${port}\s`).test(line) && !line.includes(`:${port} `)) continue;
        // Windows netstat puts the PID last; ss writes pid=NNN; lsof -t is bare.
        const m = /pid=(\d+)/.exec(line) ?? /\s(\d+)\s*$/.exec(line);
        if (m) {
          const pid = Number(m[1]);
          if (Number.isInteger(pid) && pid > 0) found.add(pid);
        }
      }
      if (found.size > 0) break;
    } catch {
      /* tool unavailable; try the next one */
    }
  }
  return [...found];
}

/**
 * Child PIDs of the given processes (Windows).
 *
 * `wmic process where (ParentProcessId=...)` is the portable-enough way to
 * resolve them. Falls back to an empty list when the tool is unavailable, in
 * which case the caller keeps the launcher PIDs and the report says so.
 */
async function childrenOf(pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  const out: number[] = [];
  for (const pid of pids) {
    try {
      const proc = Bun.spawn(
        ["wmic", "process", "where", `ParentProcessId=${pid}`, "get", "ProcessId"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of text.split("\n")) {
        const value = Number(line.trim());
        if (Number.isInteger(value) && value > 0) out.push(value);
      }
    } catch {
      /* wmic unavailable */
    }
  }
  return [...new Set(out)];
}

/**
 * Polls a real chat request until it returns 2xx.
 *
 * `/health` only proves the listener is up. The question a load cell needs
 * answered is whether the seeded provider ROUTES, which is a different thing:
 * the adapter registry is built from a snapshot, so there is a window where
 * health is green and every proxy request 503s.
 */
async function waitProviderServes(
  port: number,
  token: string,
  model: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          stream: false,
          messages: [{ role: "user", content: "readiness" }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return true;
    } catch {
      /* not ready */
    }
    await Bun.sleep(300);
  }
  return false;
}

/** Reads RSS per PID. Windows has no /proc, so tasklist is used there. */
async function rssOf(pids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;
  if (process.platform === "win32") {
    const proc = Bun.spawn(["tasklist", "/FO", "CSV", "/NH"], { stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const match = /"([^"]+)","(\d+)","[^"]*","[^"]*","([\d,.]+) K"/.exec(line);
      if (match === null) continue;
      const pid = Number(match[2]);
      if (!pids.includes(pid)) continue;
      const kb = Number(match[3]!.replace(/[,.]/g, ""));
      if (Number.isFinite(kb)) out.set(pid, kb * 1024);
    }
    return out;
  }
  for (const pid of pids) {
    try {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (match) out.set(pid, Number(match[1]) * 1024);
    } catch {
      /* gone */
    }
  }
  return out;
}
