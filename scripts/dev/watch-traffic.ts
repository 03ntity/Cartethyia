/**
 * Live traffic and bottleneck watch for a local gateway.
 *
 * Prints a row every interval: request rate, in-flight, memory, and — because
 * the local deployment is SQLite — the write-side signals that decide whether
 * the database is the bottleneck or merely the nearest suspect.
 *
 * SQLite serialises writers. The tells are:
 *  - `busy_timeout` contention shows up as latency inflation, not errors,
 *    because a blocked writer waits rather than fails.
 *  - WAL growth means a checkpoint cannot keep up with the write rate.
 *  - a widening gap between requests seen and requests completed means work is
 *    queued somewhere, which for this process is usually the write path or a
 *    stalled upstream, not the CPU.
 *
 * Usage:
 *   bun run scripts/dev/watch-traffic.ts [--port 12800] [--every 5] [--for 0]
 *
 * `--every` and `--for` are both seconds; `--for 0` watches until interrupted.
 */
import { existsSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const PORT = flag("port", 12_800);
const EVERY_MS = Math.max(1, flag("every", 5)) * 1000;
/** Seconds, for consistency with `--every`. 0 runs until interrupted. */
const FOR_MS = Math.max(0, flag("for", 0)) * 1000;
const BASE = `http://127.0.0.1:${PORT}`;

const KEY = process.env["CARTETHYIA_CONSOLE_TOKEN"] ?? "";
const HEADERS: Record<string, string> = KEY.length > 0 ? { authorization: `Bearer ${KEY}` } : {};

interface Sample {
  readonly at: number;
  readonly reqCount: number;
  readonly inFlight: number;
  readonly rss: number;
  readonly quota: number | null;
  readonly walBytes: number | null;
  readonly dbBytes: number | null;
}

async function metric(name: string): Promise<number | null> {
  try {
    const response = await fetch(`${BASE}/metrics`, { headers: HEADERS, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const text = await response.text();
    const line = text.split("\n").find((l) => l.startsWith(`${name} `));
    if (!line) return null;
    const value = Number(line.split(" ")[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function gauge(): Promise<number | null> {
  // The console's own in-flight view is authoritative for admission; fall back
  // to the Prometheus gauge when the console route is not mounted.
  try {
    const response = await fetch(`${BASE}/console/api/live/in-flight`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { inFlight?: unknown };
      return typeof body.inFlight === "number" ? body.inFlight : null;
    }
  } catch {
    // fall through to the metric
  }
  return await metric("proxy_in_flight");
}

/** SQLite file sizes: `-wal` growth is the write-pressure tell. */
function dbSizes(): { wal: number | null; db: number | null } {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  if (home.length === 0) return { wal: null, db: null };
  const dir = `${home}/AppData/Roaming/Cartethyia`;
  const main = `${dir}/cartethyia.sqlite`;
  const wal = `${dir}/cartethyia.sqlite-wal`;
  return {
    db: existsSync(main) ? statSync(main).size : null,
    wal: existsSync(wal) ? statSync(wal).size : null,
  };
}

async function sample(): Promise<Sample> {
  const sizes = dbSizes();
  const [reqCount, inFlight, rss, quota] = await Promise.all([
    metric("cartethyia_requests_total"),
    gauge(),
    metric("cartethyia_memory_rss_bytes"),
    metric("cartethyia_quota_cache_entries"),
  ]);
  return {
    at: Date.now(),
    reqCount: reqCount ?? 0,
    inFlight: inFlight ?? 0,
    rss: rss ?? 0,
    quota,
    walBytes: sizes.wal,
    dbBytes: sizes.db,
  };
}

function mb(bytes: number | null): string {
  return bytes === null ? "-" : `${(bytes / 1_048_576).toFixed(1)}M`;
}

function report(prev: Sample, now: Sample): void {
  const seconds = (now.at - prev.at) / 1000;
  const rate = seconds > 0 ? (now.reqCount - prev.reqCount) / seconds : 0;
  const walGrew = now.walBytes !== null && prev.walBytes !== null && now.walBytes > prev.walBytes;
  console.log(
    [
      new Date(now.at).toISOString().slice(11, 19),
      `req/s=${rate.toFixed(2)}`.padEnd(11),
      `total=${now.reqCount}`.padEnd(12),
      `inflight=${now.inFlight}`.padEnd(12),
      `rss=${mb(now.rss)}`.padEnd(11),
      `db=${mb(now.dbBytes)}`.padEnd(11),
      `wal=${mb(now.walBytes)}${walGrew ? "+" : " "}`.padEnd(12),
      `quota=${now.quota ?? "-"}`,
    ].join(" "),
  );
}

console.log(`watching ${BASE} every ${EVERY_MS / 1000}s — Ctrl+C to stop`);
console.log("rate and in-flight come from the gateway; db/wal from the SQLite files on disk\n");

let previous = await sample();
const deadline = FOR_MS > 0 ? Date.now() + FOR_MS : Number.POSITIVE_INFINITY;
while (Date.now() < deadline) {
  await Bun.sleep(EVERY_MS);
  const now = await sample();
  report(previous, now);
  previous = now;
}
