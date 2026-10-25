/**
 * Maintenance coordination: the Redis lease, and the registry's local rule.
 *
 * The failure these prevent is duplicated work. Two processes running
 * retention at once do not split the job; they both walk the same batches,
 * double the row churn, and contend for the one core — on the same box that
 * is already shedding requests.
 *
 * The subtle part, and what these pin down: releasing a lease must be
 * CONDITIONAL. A holder that overran its TTL has already been replaced, and an
 * unconditional DEL would delete its successor's lease and let a third process
 * in while the second is still running.
 */
import { describe, expect, test } from "bun:test";
import {
  ScheduledTaskRegistry,
  type ScheduledTask,
} from "../../src/workers/scheduler";
import {
  createNoopMaintenanceLeaseStore,
  createRedisMaintenanceLeaseStore,
  leaseTtlMs,
  type MaintenanceLeaseStore,
} from "../../src/workers/maintenance-lease";

/**
 * A Map-backed Redis stand-in that speaks enough `eval` to run the scripts.
 *
 * Scripted commands are the point of the lease — `SET NX PX`, compare-and-
 * delete — so the fake implements `eval` by dispatching on the command the
 * script performs rather than by interpreting Lua.
 */
function fakeRedis(): {
  client: Parameters<typeof createRedisMaintenanceLeaseStore>[0];
  keys: Map<string, string>;
  calls: string[];
} {
  const keys = new Map<string, string>();
  const calls: string[] = [];
  const client = {
    async eval(script: string, _numKeys: number, ...args: (string | number)[]) {
      const key = String(args[0]);
      const token = String(args[1]);
      if (script.includes("'set'") && script.includes("'NX'")) {
        calls.push("set");
        if (keys.has(key)) return 0;
        keys.set(key, token);
        return 1;
      }
      if (script.includes("pexpire")) {
        calls.push("pexpire");
        return keys.get(key) === token ? 1 : 0;
      }
      if (script.includes("'del'")) {
        calls.push("del");
        if (keys.get(key) !== token) return 0;
        keys.delete(key);
        return 1;
      }
      throw new Error(`unexpected script: ${script}`);
    },
  };
  return { client: client as never, keys, calls };
}

describe("leaseTtlMs", () => {
  test("clamps into the supported range", () => {
    expect(leaseTtlMs(30_000)).toBe(30_000);
    // A fast task must not hold so briefly that a peer with a skewed clock
    // steals it mid-run.
    expect(leaseTtlMs(500)).toBe(5_000);
    // A crashed holder must not block the task for hours.
    expect(leaseTtlMs(6 * 60 * 60_000)).toBe(60_000);
  });
});

describe("createRedisMaintenanceLeaseStore", () => {
  test("the first acquirer holds it, the second does not", async () => {
    const { client, keys } = fakeRedis();
    const store = createRedisMaintenanceLeaseStore(client);
    const first = await store.tryAcquire("retention", 30_000);
    expect(first.held).toBe(true);
    expect(keys.size).toBe(1);

    const second = await store.tryAcquire("retention", 30_000);
    expect(second.held).toBe(false);
  });

  test("release is conditional: a lost lease is not deleted", async () => {
    const { client, keys } = fakeRedis();
    const store = createRedisMaintenanceLeaseStore(client);
    const first = await store.tryAcquire("retention", 30_000);
    // Simulate the TTL lapsing and a peer taking over.
    keys.set("cartethyia:maintenance:lease:v1:retention", "someone-elses-token");

    await first.release();
    // The successor's lease must survive: deleting it would let a third
    // process in while the second is still running.
    expect(keys.get("cartethyia:maintenance:lease:v1:retention")).toBe("someone-elses-token");
  });

  test("renew reports false once the lease is lost", async () => {
    const { client, keys } = fakeRedis();
    const store = createRedisMaintenanceLeaseStore(client);
    const lease = await store.tryAcquire("retention", 30_000);
    expect(await lease.renew()).toBe(true);
    keys.set("cartethyia:maintenance:lease:v1:retention", "other");
    expect(await lease.renew()).toBe(false);
  });

  test("a double release is safe", async () => {
    const { client, keys } = fakeRedis();
    const store = createRedisMaintenanceLeaseStore(client);
    const lease = await store.tryAcquire("retention", 30_000);
    await lease.release();
    await lease.release();
    expect(keys.size).toBe(0);
    // Re-acquirable afterwards, which is the property that matters.
    expect((await store.tryAcquire("retention", 30_000)).held).toBe(true);
  });

  test("a Redis that throws skips rather than crashing the tick", async () => {
    const client = {
      async eval() {
        throw new Error("redis down");
      },
    } as never;
    const store = createRedisMaintenanceLeaseStore(client);
    const lease = await store.tryAcquire("retention", 30_000);
    // Not held: the registry will skip and count, not run unguarded.
    expect(lease.held).toBe(false);
  });
});

describe("createNoopMaintenanceLeaseStore", () => {
  test("reports held, so single-process deployments still run their sweeps", async () => {
    const store = createNoopMaintenanceLeaseStore();
    const lease = await store.tryAcquire("retention", 30_000);
    // Reporting not-held would silently disable every maintenance task on the
    // deployments that have no Redis — which is most of them.
    expect(lease.held).toBe(true);
    expect(await lease.renew()).toBe(true);
  });
});

describe("ScheduledTaskRegistry coordination", () => {
  function buildRegistry(lease: MaintenanceLeaseStore): {
    registry: ScheduledTaskRegistry;
    runs: string[];
  } {
    const runs: string[] = [];
    const instance = new ScheduledTaskRegistry([], { lease });
    const task = (name: string, shared = true): ScheduledTask => ({
      name,
      intervalMs: 30_000,
      shared,
      run: () => {
        runs.push(name);
      },
    });
    instance.register(task("retention"));
    instance.register(task("gauges", false));
    return { registry: instance, runs };
  }

  test("a task that cannot acquire the lease skips its tick", async () => {
    const { registry, runs } = buildRegistry(createNoopMaintenanceLeaseStore());
    await registry.runNow("retention");
    expect(runs).toEqual(["retention"]);
    expect(registry.leaseSkips("retention")).toBe(0);
  });

  test("a lost lease is counted, not queued", async () => {
    const denied: MaintenanceLeaseStore = {
      async tryAcquire(taskName) {
        return {
          taskName,
          held: false,
          async renew() {
            return false;
          },
          async release() {
            /* not held */
          },
        };
      },
    };
    const { registry, runs } = buildRegistry(denied);
    await registry.runNow("retention");
    // Skipped, and the skip is visible: a steadily rising count means the
    // fleet is duplicating work or one holder never releases.
    expect(runs).toEqual([]);
    expect(registry.leaseSkips("retention")).toBe(1);
    expect(registry.lastLeaseSkipAt("retention")).toBeTypeOf("number");
  });

  test("a non-shared task runs without taking a lease", async () => {
    const denied: MaintenanceLeaseStore = {
      async tryAcquire(taskName) {
        return {
          taskName,
          held: false,
          async renew() {
            return false;
          },
          async release() {
            /* not held */
          },
        };
      },
    };
    const { registry, runs } = buildRegistry(denied);
    await registry.runNow("gauges");
    // Gauges are per-process state: leasing them would mean only one process
    // in the fleet reported its own numbers.
    expect(runs).toEqual(["gauges"]);
  });

  test("one task at a time per process, and a second name skips rather than queues", async () => {
    const runs: string[] = [];
    const instance = new ScheduledTaskRegistry([], { lease: createNoopMaintenanceLeaseStore() });
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    instance.register({
      name: "slow",
      intervalMs: 30_000,
      shared: true,
      async run() {
        runs.push("slow:start");
        await gate;
        runs.push("slow:end");
      },
    });
    instance.register({
      name: "other",
      intervalMs: 30_000,
      shared: true,
      run: () => {
        runs.push("other");
      },
    });

    const first = instance.runNow("slow");
    // While "slow" is in flight, a DIFFERENT task's tick must skip — the two
    // would contend for the same rows and the same single core.
    await instance.runNow("other");
    expect(runs).not.toContain("other");
    open();
    await first;
    expect(runs).toEqual(["slow:start", "slow:end"]);
  });
});
