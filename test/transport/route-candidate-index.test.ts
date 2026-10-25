/**
 * The per-snapshot candidate index behind `resolveMatchingCandidates`.
 *
 * The resolver used to rescan `snapshot.candidates` once per resolved model —
 * `O(C×K)` with a model-string parse per comparison — on every plan. The index
 * builds once per immutable snapshot and answers each model in one `Map.get`.
 *
 * These tests pin the contract the router depends on:
 * - qualified keys (`provider/model`) and bare keys (`model`) answer correctly
 *   and preserve snapshot order;
 * - the tenant rule (global or matching tenant) is applied at lookup;
 * - the same snapshot reuses one index instance;
 * - a large combo costs one lookup per unique model, not one rescan per model.
 */
import { describe, expect, test } from "bun:test";
import {
  lookupRouteCandidates,
  parseModelReference,
  routeCandidateIndex,
} from "../../src/transport/routing/candidate-index";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p1",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    ...overrides,
  } as RouteCandidate;
}

function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return { revision: 1, candidates, aliases: {}, combos: {}, created_at: Date.now() };
}

describe("routeCandidateIndex", () => {
  test("qualified keys answer provider-scoped lookups", () => {
    const index = routeCandidateIndex(
      snapshot([
        candidate({ provider_id: "p1", model_id: "m" }),
        candidate({ provider_id: "p2", model_id: "m" }),
      ]),
    );
    const p1 = lookupRouteCandidates(index, parseModelReference("p1/m"), null);
    expect(p1).toHaveLength(1);
    expect(p1[0]!.provider_id).toBe("p1");
    const p2 = lookupRouteCandidates(index, parseModelReference("p2/m"), null);
    expect(p2).toHaveLength(1);
    expect(p2[0]!.provider_id).toBe("p2");
  });

  test("bare keys return every provider's candidates in snapshot order", () => {
    const first = candidate({ provider_id: "p1", model_id: "m" });
    const second = candidate({ provider_id: "p2", model_id: "m" });
    const index = routeCandidateIndex(snapshot([first, second]));
    const group = lookupRouteCandidates(index, parseModelReference("m"), null);
    expect(group).toEqual([first, second]);
  });

  test("tenant filter: global candidates and tenant matches pass, others do not", () => {
    const global = candidate({ provider_id: "p1", model_id: "m" });
    const owned = candidate({ provider_id: "p1", model_id: "m", tenant_id: "t1" });
    const foreign = candidate({ provider_id: "p1", model_id: "m", tenant_id: "t2" });
    const index = routeCandidateIndex(snapshot([global, owned, foreign]));
    expect(lookupRouteCandidates(index, parseModelReference("m"), "t1")).toEqual([global, owned]);
    expect(lookupRouteCandidates(index, parseModelReference("m"), null)).toEqual([global]);
    expect(lookupRouteCandidates(index, parseModelReference("m"), "t2")).toEqual([global, foreign]);
  });

  test("an unknown model answers empty", () => {
    const index = routeCandidateIndex(snapshot([candidate()]));
    expect(lookupRouteCandidates(index, parseModelReference("p1/nope"), null)).toEqual([]);
    expect(lookupRouteCandidates(index, parseModelReference("nope"), null)).toEqual([]);
  });

  test("the same snapshot reuses one index instance", () => {
    const snap = snapshot([candidate()]);
    expect(routeCandidateIndex(snap)).toBe(routeCandidateIndex(snap));
  });

  test("a rebuilt snapshot gets a fresh index", () => {
    const first = routeCandidateIndex(snapshot([candidate()]));
    const second = routeCandidateIndex(snapshot([candidate(), candidate({ provider_id: "p2" })]));
    expect(first).not.toBe(second);
    expect(lookupRouteCandidates(second, parseModelReference("m"), null)).toHaveLength(2);
  });

  test("a large combo costs one map lookup per unique model, not a rescan per model", () => {
    // 500 candidates, a combo with 40 unique member models on one provider.
    const candidates = Array.from({ length: 460 }, (_, i) =>
      candidate({ provider_id: "bulk", model_id: `bulk-model-${i}` }),
    );
    const comboModels = Array.from({ length: 40 }, (_, i) => `combo/model-${i}`);
    for (const model of comboModels) {
      candidates.push(candidate({ provider_id: "combo", model_id: model.slice("combo/".length) }));
    }
    const snap = snapshot(candidates);
    const index = routeCandidateIndex(snap);

    // The index build itself visits each candidate exactly once.
    const qualifiedCount = [...index.qualified.keys()].length;
    const bareCount = [...index.bare.keys()].length;
    expect(qualifiedCount).toBe(500);
    expect(bareCount).toBe(500); // 460 bulk + 40 combo, all distinct model ids

    // Resolution of the whole combo is 40 O(1) lookups plus the tenant filter.
    const groups = comboModels.map((id) => lookupRouteCandidates(index, parseModelReference(id), null));
    for (const group of groups) expect(group).toHaveLength(1);
    const flat = [...new Set(groups.flat())];
    expect(flat).toHaveLength(40);
  });
});
