/**
 * A tick that cannot get an answer must skip, not hang.
 *
 * `runOnce` latched the process-wide `busy` gate and *then* awaited
 * `lease.tryAcquire` with no bound. A lease store that never answered left
 * `busy` set forever, and since the gate is shared across every task name,
 * every later tick of every task returned at the gate: the entire registry
 * stopped running. The sweep whose whole job is to clean up after something
 * that never finishes was itself stopped by one thing that never finished.
 *
 * These pin that the gate is released without running the task, and that a
 * later tick still runs — which is the property that was lost.
 */
import { expect, test } from "bun:test";
import { ScheduledTaskRegistry } from "../../src/workers/scheduler";
import type { MaintenanceLease, MaintenanceLeaseStore } from "../../src/workers/maintenance-lease";

/**
 * The lease wait is bounded at 5s in production, so a test that exercises the
 * silent-lease path must outlast it. Bun's default is 5s.
 */
const HANG_TIMEOUT_MS = 12_000;

/** A lease store whose answer never arrives. */
function silentLease(): MaintenanceLeaseStore {
  return { tryAcquire: () => new Promise<MaintenanceLease>(() => {}) };
}

const GRANTED: MaintenanceLease = {
  held: true,
  renew: () => Promise.resolve(true),
  release: () => Promise.resolve(),
  taskName: "ok",
};

test("a lease that never answers does not block the tick", async () => {
  const store = silentLease();
  const registry = new ScheduledTaskRegistry([], { lease: store });
  let ran = 0;
  registry.register({ name: "shared", intervalMs: 60_000, shared: true, run: () => {
    ran += 1;
    return Promise.resolve();
  } });
  // The wait is bounded, so this resolves instead of hanging forever.
  await registry.runNow("shared");
  // Skipped, not run: a task that could not prove it owns the work must not
  // run unguarded, which is what sharing the lease was for.
  expect(ran).toBe(0);
  expect(registry.leaseSkips("shared")).toBeGreaterThan(0);
}, HANG_TIMEOUT_MS);

test("the gate is released after a silent lease, so a later tick still runs", async () => {
  const store = silentLease();
  const registry = new ScheduledTaskRegistry([], { lease: store });
  let ran = 0;
  registry.register({ name: "first", intervalMs: 60_000, shared: true, run: () => Promise.resolve() });
  registry.register({ name: "second", intervalMs: 60_000, run: () => {
    ran += 1;
    return Promise.resolve();
  } });
  await registry.runNow("first");
  // Before the fix this hung at the gate: `busy` was still latched by the
  // task whose lease call never settled.
  await registry.runNow("second");
  expect(ran).toBe(1);
}, HANG_TIMEOUT_MS);

test("a granted lease still runs the task", async () => {
  const registry = new ScheduledTaskRegistry([], {
    lease: { tryAcquire: () => Promise.resolve(GRANTED) },
  });
  let ran = 0;
  registry.register({ name: "ok", intervalMs: 60_000, shared: true, run: () => {
    ran += 1;
    return Promise.resolve();
  } });
  await registry.runNow("ok");
  expect(ran).toBe(1);
  expect(registry.leaseSkips("ok")).toBe(0);
});

test("a task with no lease store is unaffected", async () => {
  const registry = new ScheduledTaskRegistry();
  let ran = 0;
  registry.register({ name: "local", intervalMs: 60_000, run: () => {
    ran += 1;
    return Promise.resolve();
  } });
  await registry.runNow("local");
  expect(ran).toBe(1);
});
