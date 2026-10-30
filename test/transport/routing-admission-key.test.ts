/**
 * The admission bucket must scope shared accounts globally and tenant-owned
 * accounts per owner — the "who is speaking" identity of the concurrency
 * ceiling. A second copy of this format would drift and quietly deprioritize
 * the wrong accounts.
 */
import { expect, test } from "bun:test";
import { admissionKey } from "../../src/transport/routing/admission";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

function candidate(overrides: Partial<RouteCandidate>): RouteCandidate {
  return {
    provider_id: "provider-a",
    model_id: "model-x",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    ...overrides,
  } as RouteCandidate;
}

test("shared account (no owner) buckets per provider:model:account", () => {
  const key = admissionKey(candidate({ provider_account_id: "acct-1" }));
  expect(key).toBe("provider-a:model-x:acct-1");
});

test("tenant-owned account buckets include the owner tenant", () => {
  const key = admissionKey(
    candidate({ provider_account_id: "acct-1", owner_tenant_id: "tenant-1" }),
  );
  expect(key).toBe("provider-a:model-x:acct-1:tenant-1");
});

test("two tenants owning different accounts get distinct buckets", () => {
  const a = admissionKey(
    candidate({ provider_account_id: "acct-1", owner_tenant_id: "tenant-1" }),
  );
  const b = admissionKey(
    candidate({ provider_account_id: "acct-1", owner_tenant_id: "tenant-2" }),
  );
  expect(a).not.toBe(b);
});

test("credential-less candidates bucket per provider:model", () => {
  expect(admissionKey(candidate({}))).toBe("provider-a:model-x");
});
