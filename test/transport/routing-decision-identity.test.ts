/**
 * Plan decisions are keyed per candidate identity, not per admission bucket.
 *
 * The pool-account fan-out (`route-catalog.ts`) emits one credential-less
 * candidate per network pool for the same (provider, model) — every one of
 * them shares the `provider:model` admission bucket. When `plan()` keyed its
 * decision map by that bucket, one candidate's health verdict overwrote its
 * sibling's: depending on snapshot order, a disabled pool either inherited the
 * healthy sibling's decision (and got dialed) or excluded the healthy sibling
 * (and the plan failed). Decisions must be distinct per candidate.
 */
import { describe, expect, test } from "bun:test";
import {
  RoutingEngine,
} from "../../src/transport/routing/routing-engine";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

function poolCandidate(poolId: string, extra: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "poolprov",
    model_id: "pool-model",
    wire_family: "chat",
    endpoint: "/v1/chat",
    capability_profile: {},
    tenant_id: null,
    requires_account: false,
    network_pool_ids: [poolId],
    ...extra,
  } as unknown as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

describe("plan decisions keyed per candidate identity", () => {
  test("a disabled pool candidate keeps its own decision and does not exclude its healthy sibling", async () => {
    const healthy = poolCandidate("pool-a");
    const disabled = poolCandidate("pool-b", { health_status: "disabled" });
    const engine = new RoutingEngine();
    const plan = await engine.plan("pool-model", snapshot([healthy, disabled]));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toBe(healthy);
    expect(plan.decisions.size).toBe(2);
    expect(plan.decisions.get(healthy)?.eligible).toBe(true);
    expect(plan.decisions.get(disabled)?.eligible).toBe(false);
    expect(plan.decisions.get(disabled)?.reason).toBe("disabled");
  });

  test("a disabled pool candidate is excluded even when it is evaluated first", async () => {
    const disabled = poolCandidate("pool-b", { health_status: "disabled" });
    const healthy = poolCandidate("pool-a");
    const engine = new RoutingEngine();
    const plan = await engine.plan("pool-model", snapshot([disabled, healthy]));

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toBe(healthy);
    expect(plan.decisions.size).toBe(2);
    expect(plan.decisions.get(disabled)?.eligible).toBe(false);
    expect(plan.decisions.get(healthy)?.eligible).toBe(true);
  });

  test("two healthy pool candidates hold two distinct decisions", async () => {
    const first = poolCandidate("pool-a");
    const second = poolCandidate("pool-b");
    const engine = new RoutingEngine();
    const plan = await engine.plan("pool-model", snapshot([first, second]));

    expect(plan.candidates).toHaveLength(2);
    expect(plan.decisions.size).toBe(2);
    expect(plan.decisions.get(first)).toBeDefined();
    expect(plan.decisions.get(second)).toBeDefined();
    expect(plan.decisions.get(first)).not.toBe(plan.decisions.get(second));
  });
});
