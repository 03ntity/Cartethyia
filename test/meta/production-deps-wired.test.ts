/**
 * Every dependency the production graph builds must reach the app.
 *
 * The runtime sampler was constructed in `dependencies.ts`, registered on its
 * own interval, and returned in the deps object — but `main.ts` never passed
 * it to `createGatewayApp`. So `createGatewayApp`'s `bindInFlight` call no-op'd
 * on an optional dependency and the sampler kept its `() => 0` placeholder.
 *
 * The consequence was worse than a flat gauge: `checkIdleReclaim` gates on
 * `inFlightSource() > 0`, so a permanently-zero source told the gateway
 * nothing was in flight and let it run a synchronous `Bun.gc(true)` under
 * load. A synchronous collection stalls concurrent requests, which pinned
 * latency to the request deadline and produced the wall of 499s.
 *
 * Both classes behaved exactly as written; only the wire between them was
 * missing. Nothing in either file can catch that, so it is asserted here:
 * read the composition and require the field to be passed.
 *
 * Static rather than executed, because `main.ts` boots a real gateway on
 * import — this must stay readable without a database.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN_TS = readFileSync(join(import.meta.dir, "..", "..", "src", "main.ts"), "utf8");
const DEPENDENCIES_TS = readFileSync(
  join(import.meta.dir, "..", "..", "src", "boot", "dependencies.ts"),
  "utf8",
);

/** The `createGatewayApp({ ... })` call in main.ts, the production composition. */
function productionComposition(): string {
  const start = MAIN_TS.indexOf("createGatewayApp({");
  expect(start).toBeGreaterThan(-1);
  // Balanced by brace depth, so the block ends at the real close rather than
  // the first `})` belonging to a nested object literal.
  let depth = 0;
  let i = MAIN_TS.indexOf("{", start);
  for (; i < MAIN_TS.length; i += 1) {
    if (MAIN_TS[i] === "{") depth += 1;
    else if (MAIN_TS[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return MAIN_TS.slice(start, i + 1);
}

test("main.ts hands the runtime sampler to the app", () => {
  // Without this the app cannot bind the sampler's in-flight source, and the
  // gauge — and the idle-GC gate that reads it — stay pinned at zero.
  expect(productionComposition()).toContain("runtimeMetricsSampler");
});

test("main.ts passes the other dependencies that gate behaviour silently", () => {
  const composition = productionComposition();
  for (const field of [
    "scheduledTasks",
    "telemetryBuffer",
    "shutdownCoordinator",
    "snapshotService",
  ]) {
    expect(composition).toContain(field);
  }
});

test("the dependency graph still builds the sampler main.ts forwards", () => {
  // If the graph ever stops constructing one, the forwarding above becomes a
  // type error rather than a silent regression — this keeps the two halves
  // from drifting apart in the other direction.
  expect(DEPENDENCIES_TS).toContain("new RuntimeMetricsSampler(");
});
