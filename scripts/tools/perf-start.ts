/**
 * Starts one gateway instance configured for load measurement.
 * `bun run dev:backend` reloads on change and shortens several budgets, which
 * would make every number in this investigation depend on whether a file was
 * touched mid-run. This starts the same entry point with a fixed environment
 * and no watcher, so a before/after pair differs only by the code under test.
 *
 * Nothing under `scripts/tools/` is in the npm package `files` array — these
 * harnesses exist in the repository only.
 */
const env: Record<string, string> = {
  ...process.env,
  CARTETHYIA_DB_MODE: "full",
  DATABASE_URL: process.env.CARTETHYIA_PERF_DATABASE_URL ?? "postgres://postgres@localhost:5432/cartethyia_perf",
  PORT: process.env.PERF_PORT ?? "9901",
  // The stub upstream is loopback, which the SSRF policy rejects by default.
  // This flag exists for exactly this shape of deployment (a self-hosted or
  // LAN upstream) so it is the honest way to point the gateway at it rather
  // than a hole in the policy.
  CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS: "true",
  // The default abuse window (240/min) is exactly the concurrency this
  // harness drives, so every run would measure the limiter rather than the
  // gateway. Raised for measurement only — it is a load-test knob, not a
  // production default.
  IP_RATE_MAX_PER_WINDOW: process.env.PERF_IP_RATE ?? "100000",
  // Max is 100 by spec; enough that a load run never trips the strike ban.
  CARTETHYIA_MODEL_STRIKE_THRESHOLD: "100",
  // Admission concurrency is DERIVED from the memory limit (config/resources
  // .ts): on a host with no discoverable cgroup limit it resolves to the 512 MiB
  // fallback, which derives 16 concurrent requests at a 4 MiB body — so a
  // --concurrency 40 run measures the concurrency guard instead of the gateway.
  // Set the limit and the ceiling explicitly for measurement: the throughput
  // budgets in the plan are about the gateway's own work, not about admission.
  CARTETHYIA_MEMORY_LIMIT_BYTES: process.env.PERF_MEMORY_LIMIT_BYTES ?? "17179869184",
  // Capped at 64 by the config spec, which is also the ceiling the derivation
  // clamps to. Explicit rather than left to the derivation, because on a host
  // with no discoverable cgroup limit the 512 MiB fallback derives 16 — and a
  // --concurrency 40 run would then measure the concurrency guard instead of
  // the gateway's own work. The override is intentional and logged as such.
  CARTETHYIA_PROCESS_CONCURRENCY_LIMIT: process.env.PERF_CONCURRENCY_LIMIT ?? "64",
  // A realistic multi-turn context does not fit the 4 MiB default: one user
  // carrying 40-80 MB of context/attachments is rejected at ingress before any
  // memory accounting happens, so a body-size run measures nothing at all.
  // Raised for measurement only — see PERF_MAX_BODY_BYTES.
  CARTETHYIA_SERVER_MAX_BODY_BYTES: process.env.PERF_MAX_BODY_BYTES ?? "67108864",
};
const entry = new URL("../../src/main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const proc = Bun.spawn(["bun", "run", entry], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    proc.kill(signal);
  });
}
await proc.exited;
