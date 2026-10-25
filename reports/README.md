# F2 — Measured acceptance

Reports produced by `scripts/tools/perf-matrix.ts`, one JSON per cell plus a
`<cell>.worst.json` holding the worst of N runs. Verify a directory with:

```sh
bun run scripts/tools/perf-verify.ts reports/<cell>.worst.json
```

`perf-verify` exits nonzero on any budget miss, so it is a gate rather than a
number someone reads and then decides about.

## How to read these

- **Worst-of-N, not best-of-N.** An acceptance budget is a worst-case claim.
- **`--profile` records the machine; it never scales a budget.** A report taken
  on a 16 GB host is recorded as such, and its memory numbers must not be read
  as evidence about a 2 GiB VPS.
- **A `?` line in `perf-verify` output is an unevaluated budget**, not a pass.
  `--strict` makes unevaluated budgets fail, for runs where every metric should
  be present.

## Budgets (from the plan, verbatim)

| Budget | metadata | full / 1 MiB |
|---|---|---|
| proxy p95 | ≤ 250 ms | ≤ 1,500 ms |
| proxy p99 | ≤ 500 ms | ≤ 3,000 ms |
| dashboard-active p95 | ≤ 500 ms | ≤ 1,000 ms |
| dashboard slack | ≤ 1.5× proxy-only + 25 ms | same |
| summed worker peak RSS | ≤ 1,536 MiB | same |
| settled RSS above idle | ≤ 128 MiB | ≤ 256 MiB |
| every cell | all responses 200, zero network errors, `proxy_in_flight=0` after settle, both worker PIDs served | same |

## Redis index discipline

Use a DIFFERENT Redis db index for perf runs than the test suite uses. A perf
run leaves thousands of admission keys behind; if the tests then run against
that index, the bounded purge (A6) hits its scan cap and a test fails with a
counter left at `"0"` instead of null — which looks like a purge bug and is not.

```sh
export CARTETHYIA_TEST_REDIS_URL='redis://127.0.0.1:6379/5'   # tests
export CARTETHYIA_PERF_REDIS_URL='redis://127.0.0.1:6379/9'   # perf — keep separate
```

## Status

See `F2-RESULTS.md` for the measured numbers and what they do and do not prove.
