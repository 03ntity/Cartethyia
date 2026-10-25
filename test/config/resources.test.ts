/**
 * The canonical resource policy, and the concurrency controller built on it.
 *
 * The numbers here are the whole point of the module: a single formula decides
 * how much work this process admits from how much memory it has. These pin the
 * worked examples from the plan, so a change to the fractions cannot quietly
 * move a 512 MiB box from 16 to 64 concurrent requests.
 */
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_MEMORY_LIMIT_BYTES,
  MAX_PROCESS_CONCURRENCY,
  MEMORY_HEADROOM_FRACTION,
  REQUEST_BODY_BUDGET_FRACTION,
  REQUEST_BODY_TRANSIENT_COPIES,
  deriveMemoryHeadroomBytes,
  deriveProcessConcurrency,
} from "../../src/config/resources";
import {
  createProcessConcurrencyController,
  createProcessConcurrencyMiddleware,
} from "../../src/transport/guards/concurrency-guard";
import { resolveProcessTopology, type ProcessTopology } from "../../src/config/runtime";

const MiB = 1024 * 1024;

describe("deriveProcessConcurrency", () => {
  test("2 GiB with 4 MiB bodies reaches the ceiling", () => {
    expect(deriveProcessConcurrency({ memoryLimitBytes: 2 * 1024 * MiB, maxBodyBytes: 4 * MiB })).toBe(
      MAX_PROCESS_CONCURRENCY,
    );
  });

  test("512 MiB with 4 MiB bodies admits 16", () => {
    expect(deriveProcessConcurrency({ memoryLimitBytes: 512 * MiB, maxBodyBytes: 4 * MiB })).toBe(16);
  });

  test("256 MiB with 16 MiB bodies admits 2", () => {
    expect(deriveProcessConcurrency({ memoryLimitBytes: 256 * MiB, maxBodyBytes: 16 * MiB })).toBe(2);
  });

  test("a tiny limit still admits one request", () => {
    // Never zero: a limit that admits nothing is a gateway that serves nothing,
    // which is worse than one that admits a single request and sheds the rest.
    expect(deriveProcessConcurrency({ memoryLimitBytes: 1 * MiB, maxBodyBytes: 64 * MiB })).toBe(1);
    expect(deriveProcessConcurrency({ memoryLimitBytes: 0, maxBodyBytes: 4 * MiB })).toBe(1);
  });

  test("the budget accounts for every transient copy of a body", () => {
    // One copy would double the answer. The factor is the reason the formula
    // is not simply limit/body.
    const oneCopy = Math.floor((512 * MiB * REQUEST_BODY_BUDGET_FRACTION) / (1 * 4 * MiB));
    const actual = deriveProcessConcurrency({ memoryLimitBytes: 512 * MiB, maxBodyBytes: 4 * MiB });
    expect(actual).toBe(Math.floor(oneCopy / REQUEST_BODY_TRANSIENT_COPIES));
    expect(REQUEST_BODY_TRANSIENT_COPIES).toBe(2);
  });

  test("an override wins, clamped to the ceiling and to at least one", () => {
    expect(
      deriveProcessConcurrency({ memoryLimitBytes: 256 * MiB, maxBodyBytes: 4 * MiB, override: 32 }),
    ).toBe(32);
    expect(
      deriveProcessConcurrency({ memoryLimitBytes: 2 * 1024 * MiB, maxBodyBytes: 4 * MiB, override: 999 }),
    ).toBe(MAX_PROCESS_CONCURRENCY);
    expect(
      deriveProcessConcurrency({ memoryLimitBytes: 2 * 1024 * MiB, maxBodyBytes: 4 * MiB, override: -5 }),
    ).toBe(1);
  });
});

describe("deriveMemoryHeadroomBytes", () => {
  test("is a fraction of the real limit, not a flat constant", () => {
    expect(deriveMemoryHeadroomBytes(512 * MiB)).toBe(Math.ceil(512 * MiB * MEMORY_HEADROOM_FRACTION));
    // A flat 64 MiB would keep the same headroom on a box a quarter the size,
    // leaving a 512 MiB container almost no room to react.
    expect(deriveMemoryHeadroomBytes(2 * 1024 * MiB)).toBeGreaterThan(deriveMemoryHeadroomBytes(256 * MiB));
  });

  test("the fallback limit is the documented 512 MiB", () => {
    expect(FALLBACK_MEMORY_LIMIT_BYTES).toBe(512 * MiB);
  });
});

describe("ProcessConcurrencyController", () => {
  test("a token is required to run, and releasing frees exactly one", () => {
    const controller = createProcessConcurrencyController(2);
    const first = controller.tryAcquire();
    const second = controller.tryAcquire();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(controller.activeCount()).toBe(2);
    // Past the cap: refused rather than queued.
    expect(controller.tryAcquire()).toBeUndefined();
    first?.();
    expect(controller.activeCount()).toBe(1);
    expect(controller.tryAcquire()).toBeDefined();
  });

  test("a double release frees one token, not two", () => {
    const controller = createProcessConcurrencyController(2);
    const release = controller.tryAcquire();
    release?.();
    release?.();
    // Had the second release decremented again, the count would wrap and the
    // cap would silently admit unbounded work.
    expect(controller.activeCount()).toBe(0);
    const a = controller.tryAcquire();
    const b = controller.tryAcquire();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(controller.tryAcquire()).toBeUndefined();
  });

  test("two controllers count independently", () => {
    // The previous shape was one module-global counter, so two instances
    // shared — and corrupted — a single count.
    const a = createProcessConcurrencyController(1);
    const b = createProcessConcurrencyController(1);
    expect(a.tryAcquire()).toBeDefined();
    expect(b.tryAcquire()).toBeDefined();
    expect(a.activeCount()).toBe(1);
    expect(b.activeCount()).toBe(1);
  });

  test("the effective limit is reported", () => {
    expect(createProcessConcurrencyController(7).limit()).toBe(7);
  });
});

describe("createProcessConcurrencyMiddleware", () => {
  /**
   * The bug this middleware fixes: `afterResponse` used to decrement a counter
   * for every `/v1` request, including the ones it had just REFUSED — which
   * never incremented it. Under sustained overload that drove the count below
   * zero's floor and let more through than the cap allows.
   */
  test("a rejected request does not free a token it never took", async () => {
    const controller = createProcessConcurrencyController(1);
    const app = createProcessConcurrencyMiddleware(controller);

    const held = app
      // The middleware is a plugin, so it is mounted on a minimal app with one
      // gateway route behind it.
      .post("/v1/chat/completions", () => new Response("ok", { status: 200 }));

    const first = await held.handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(first.status).toBe(200);
    // The first request completed, so its token is back. To observe the bug we
    // need a request that is refused: force one by taking the token manually.
    const manual = controller.tryAcquire();
    expect(manual).toBeDefined();
    const refused = await held.handle(
      new Request("https://gateway.test/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(refused.status).toBe(503);
    // The refused request must NOT have released anything: the manually held
    // token is still outstanding, so the cap is still reached.
    expect(controller.activeCount()).toBe(1);
    expect(controller.tryAcquire()).toBeUndefined();
    manual?.();
    expect(controller.activeCount()).toBe(0);
  });

  test("non-gateway paths are never counted", async () => {
    const controller = createProcessConcurrencyController(1);
    const app = createProcessConcurrencyMiddleware(controller).get(
      "/console",
      () => new Response("console", { status: 200 }),
    );
    const response = await app.handle(new Request("https://gateway.test/console"));
    expect(response.status).toBe(200);
    // The console must remain reachable while the process is saturated, or an
    // operator cannot see why it is refusing.
    expect(controller.activeCount()).toBe(0);
    expect(controller.tryAcquire()).toBeDefined();
  });
});

describe("resolveProcessTopology", () => {
  const savedCount = process.env.CARTETHYIA_PROCESS_COUNT;
  const savedIndex = process.env.CARTETHYIA_PROCESS_INDEX;

  function withTopology(count: string | undefined, index: string | undefined): ProcessTopology {
    if (count === undefined) delete process.env.CARTETHYIA_PROCESS_COUNT;
    else process.env.CARTETHYIA_PROCESS_COUNT = count;
    if (index === undefined) delete process.env.CARTETHYIA_PROCESS_INDEX;
    else process.env.CARTETHYIA_PROCESS_INDEX = index;
    return resolveProcessTopology();
  }

  test("unset means one process", () => {
    const topology = withTopology(undefined, undefined);
    expect(topology).toEqual({ count: 1, index: 0, multiProcess: false });
  });

  test("an explicit single process needs no index", () => {
    expect(withTopology("1", undefined)).toEqual({ count: 1, index: 0, multiProcess: false });
  });

  test("several processes report index and multiProcess", () => {
    expect(withTopology("4", "2")).toEqual({ count: 4, index: 2, multiProcess: true });
  });

  test("a count above one with no index fails rather than defaulting to 0", () => {
    // Defaulting would give two processes the same index, and neither could
    // own a distinct shard of anything.
    expect(() => withTopology("4", undefined)).toThrow(/CARTETHYIA_PROCESS_INDEX is required/);
  });

  test("an index outside the range fails", () => {
    expect(() => withTopology("4", "4")).toThrow(/must be an integer between 0 and 3/);
    expect(() => withTopology("4", "-1")).toThrow(/must be an integer/);
  });

  test("a malformed or out-of-range count fails", () => {
    expect(() => withTopology("0", "0")).toThrow(/must be an integer between 1 and 16/);
    expect(() => withTopology("99", "0")).toThrow(/must be an integer between 1 and 16/);
    expect(() => withTopology("many", "0")).toThrow(/must be an integer/);
  });

  test("the environment is restored", () => {
    if (savedCount === undefined) delete process.env.CARTETHYIA_PROCESS_COUNT;
    else process.env.CARTETHYIA_PROCESS_COUNT = savedCount;
    if (savedIndex === undefined) delete process.env.CARTETHYIA_PROCESS_INDEX;
    else process.env.CARTETHYIA_PROCESS_INDEX = savedIndex;
    expect(resolveProcessTopology().multiProcess).toBe(false);
  });
});
