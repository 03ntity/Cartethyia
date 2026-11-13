/**
 * Characterization contract for the admin `GET /system/performance` route.
 *
 * The route reports process-global figures (adapter load time, model-catalog
 * load time, outbound network latency, sampled memory) read from the
 * in-memory performance registry, and it is guarded by `platform:admin`
 * because those figures describe this instance's own module graph and egress
 * rather than any tenant's data.
 *
 * Reachability note: `createPerformanceRoutes` is not currently registered in
 * `console-router.ts`/`domain-registration.ts`, so the gateway composition
 * root cannot serve `/console/api/system/performance` yet. Until the route is
 * (re)mounted, this suite pins the route factory's wire contract directly on
 * a minimal Elysia app with an injected access decision — the same pattern
 * `account-batch-delete.test.ts` uses for the platform-admin route a tenant
 * API key can never hold. The import stays on `performance.ts` only, so the
 * suite survives the contracts file being folded into it.
 *
 * The response contract under characterization:
 * - no access decision       -> 401 `unauthorized`
 * - session without the scope -> 403 `insufficient_scope`
 * - `platform:admin` session -> 200 with exactly the four bounded series,
 *   each a flat `Record<string, number>` of finite values
 * - two consecutive calls    -> identical bodies (a snapshot, not a probe;
 *   this suite deliberately asserts no timing figures)
 */
import { describe, expect, test } from "bun:test";
import { Elysia, type AnyElysia } from "elysia";
import { createPerformanceRoutes } from "../../src/console/observability/performance";
import { createAccessDecision, type AccessScope } from "../../src/security/access-control";

/** The four series the snapshot contract guarantees, always present. */
const SNAPSHOT_SERIES = [
  "adapter_load_ms",
  "model_catalog_load_ms",
  "network_call_latency_ms",
  "memory_bytes",
] as const;

function performanceApp(access: AccessDecisionLike | undefined): AnyElysia {
  return new Elysia().use(
    createPerformanceRoutes({ accessResolver: () => access }),
  );
}

type AccessDecisionLike = ReturnType<typeof createAccessDecision>;

function decision(scopes: readonly AccessScope[]): AccessDecisionLike {
  return createAccessDecision({
    id: `perf-test-${Math.random().toString(16).slice(2)}`,
    tenantId: null,
    scopes,
  });
}

async function get(app: AnyElysia): Promise<Response> {
  return app.handle(new Request("http://cartethyia.test/system/performance"));
}

describe("GET /system/performance", () => {
  test("an unauthenticated request is refused with 401 unauthorized", async () => {
    const app = performanceApp(undefined);
    const response = await get(app);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("unauthorized");
  });

  test("a session without platform:admin is refused with 403 insufficient_scope", async () => {
    const app = performanceApp(decision(["dashboard:read", "dashboard:write"]));
    const response = await get(app);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("insufficient_scope");
  });

  test("a platform:admin session receives the four-series snapshot", async () => {
    const app = performanceApp(decision(["platform:admin"]));
    const response = await get(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...SNAPSHOT_SERIES].sort());
    for (const series of SNAPSHOT_SERIES) {
      const values = body[series];
      expect(values).toBeInstanceOf(Object);
      expect(Array.isArray(values)).toBe(false);
      for (const value of Object.values(values as Record<string, unknown>)) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  test("two consecutive calls return identical snapshots", async () => {
    const app = performanceApp(decision(["platform:admin"]));
    const first = await get(app);
    expect(first.status).toBe(200);
    const second = await get(app);
    expect(second.status).toBe(200);
    // A snapshot reflects the registry at read time; with nothing recording
    // between the two reads, the bodies must be identical.
    expect(await second.json()).toEqual(await first.json());
  });
});
