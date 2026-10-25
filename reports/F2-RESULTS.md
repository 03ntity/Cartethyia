# F2 — Verification & load harness: results

Machine: `reports/machine-windows-dev.json` — 12 cores, 16088 MB, Windows.
**Not the 1-core/2GiB VPS target.** Latency and correctness are informative;
memory numbers are not evidence about the target.

## What was measured

8 cells (1 worker × {redis, no-redis} × {dash, no-dash} × {full, meta}),
400 requests, concurrency 40, settle 10, warmup 100.

| cell | p95 | p99 | budget | result |
|---|---|---|---|---|
| w1-noredis-nodash-meta | 426.96 | 552.47 | 250 / 500 | FAIL p95,p99 |
| w1-noredis-nodash-full | 1005.84 | 1523.74 | 1500 / 3000 | **PASS** |
| w1-noredis-dash-meta | 378.03 | 507.21 | 250 / 500 | FAIL p95,p99,dash |
| w1-noredis-dash-full | 1153.08 | 2013 | 1500 / 3000 | FAIL dash p95 |
| w1-redis-nodash-meta | 452.6 | 632.73 | 250 / 500 | FAIL p95,p99 |
| w1-redis-nodash-full | 984.76 | 1257.28 | 1500 / 3000 | **PASS** |
| w1-redis-dash-meta | 420.36 | 695.29 | 250 / 500 | FAIL p95 |

Low-concurrency control (100 req / concurrency 5): p50 32.92ms, p95 53.83ms,
p99 61.74ms — the metadata failures are load-driven, not intrinsic.

## Body size does not move RSS — measured, not assumed

Request bodies were raised past the 4 MiB default (`CARTETHYIA_SERVER_MAX_BODY_BYTES`)
to test the realistic multi-turn case.

| body | peak RSS | throughput |
|---|---|---|
| 4 MiB × 5 concurrent | 127.7 MB | 23 req/s |
| 50 MB × 5 concurrent | 129.0 MB | 2 req/s |

12× the body, 1.3 MB of RSS. The gateway does not retain the full body in
memory, so throughput collapses under body size while memory does not.

## Derived concurrency at realistic body sizes

`floor(limit × 0.25 / (2 × body))`:

| memory limit | 4 MB | 20 MB | 50 MB |
|---|---|---|---|
| 512 MiB (fallback) | 16 | 3 | 1 |
| **2 GiB (target)** | 64 | 12 | **5** |
| 16 GiB (this host) | 64 | 64 | 40 |

On a 2 GiB box a 50 MB context admits **5 concurrent** — so 50–100 such users
are shed by design. Observed at simulated 2 GiB / 50 users / 50 MB:
176×200, 21×503, 3×400, health still available, no OOM.

## NOT proven

- **No real 1-core/2GiB VPS was used.** `CARTETHYIA_MEMORY_LIMIT_BYTES` drives
  the admission guard only; it does not cap real allocation. OOM protection is
  therefore unverified — a memory-capped container or a real VPS is required.
- **2-worker cells did not run.** Multi-process requires Linux,
  `CARTETHYIA_DB_MODE=full`, and reachable Redis. Skipped with a recorded
  reason, not reported as passing.
- **Redis is 5.0.14.1** (Laragon), not the 7.4.2 the plan names for CI.
- The p50 28s in the 50-user run is harness-side (2.5 GB over loopback), not
  gateway latency.

## Correction to the premise

A 50 MB request body is **rejected by default** — `CARTETHYIA_SERVER_MAX_BODY_BYTES`
is 4 MiB. "+40–80 MB per concurrent" does not apply to this architecture; the
measured cost at the default limit is ~10–20 MiB per concurrent at most, and
RSS does not track body size at all.

## Harness defects found and fixed (do not regress)

1. RSS attributed to the `bun run` **launcher**, not the gateway — the console
   health route 401s, so PID resolution silently fell back. Now resolved via the
   listening socket owner. Every earlier RSS figure was off-target.
2. Provider readiness assumed by `/health`; adapters register from a snapshot,
   so early requests 503 "provider adapter not registered". Now probed with a
   real request.
3. Upstream stub serves POST only; readiness probed with GET → always "not ready".
4. `perf-start` read `DATABASE_URL` while `perf-seed` read
   `CARTETHYIA_PERF_DATABASE_URL` — different databases.
5. Perf runs polluted Redis db 5 with 3080 keys, hitting the bounded purge (A6)
   scan cap and failing a test. Perf must use a separate index.
6. Body was `JSON.stringify`-ed per request: 50 MB allocated per request in the
   load generator. Built once now.

## Suite

`bun run scripts/test/run.ts --scope backend` → **4050 pass / 0 fail**.
