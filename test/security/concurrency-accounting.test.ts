/**
 * The concurrency counter must be refunded to the key it was charged to.
 *
 * A share child reserves under its own id (`rpmConcurrencyKeyId`) while the
 * reservation is recorded against its parent, so the counter was incremented
 * under one key and decremented under another. The child's count never fell:
 * after `limit` requests it was permanently full and refused everything, which
 * is the "never invoked again" symptom. Nothing about that is visible from the
 * outside — the store looked correct and every rejection was individually
 * correct — so it is pinned here at the counter.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryAdmissionCounterStore } from "../../src/security/admission/in-memory-store";
import type { AdmissionReserveRequest } from "../../src/security/admission/contracts";

function request(overrides: Partial<AdmissionReserveRequest> = {}): AdmissionReserveRequest {
  return {
    reservationId: crypto.randomUUID(),
    apiKeyId: "parent-key",
    rpmConcurrencyKeyId: "child-key",
    now: Date.now(),
    estimatedTokens: 0,
    rpmLimit: null,
    dailyLimit: null,
    monthlyLimit: null,
    lifetimeBudget: null,
    lifetimeConsumed: 0,
    concurrencyLimit: 5,
    tenantId: "tenant",
    tenantConcurrencyLimit: null,
    ...overrides,
  };
}

describe("concurrency accounting is key-correct", () => {
  test("a share child's slot is returned to the child, not the parent", async () => {
    // Charge and refund 100 times against a limit of 5. With the counter
    // refunded to the parent, the child's count climbed to 5 and stayed there,
    // so this loop could not get past five iterations.
    const store = new InMemoryAdmissionCounterStore();
    for (let i = 0; i < 100; i += 1) {
      const req = request({ reservationId: `r-${i}` });
      await store.reserve(req);
      await store.release(req.apiKeyId, 0, req.reservationId);
    }
    // The 101st still fits inside the limit of 5, which is only possible if
    // every earlier slot was refunded.
    await store.reserve(request({ reservationId: "r-101" }));
  });

  test("the counter never goes negative when refunded twice", async () => {
    // `commitUsage` and `release` are both reachable for one request (an abort
    // racing a normal finish), so a refund that overran would drive the count
    // below zero and admit more than the limit.
    const store = new InMemoryAdmissionCounterStore();
    const req = request({ concurrencyLimit: 1 });
    await store.reserve(req);
    await store.release(req.apiKeyId, 0, req.reservationId);
    await store.release(req.apiKeyId, 0, req.reservationId).catch(() => undefined);
    await store.reserve(request({ reservationId: "next" }));
  });

  test("different keys never share a counter", async () => {
    // The scope rule: the counter is per key, so one key's five in-flight
    // requests must not block another key.
    const store = new InMemoryAdmissionCounterStore();
    for (let i = 0; i < 5; i += 1) {
      await store.reserve(
        request({ reservationId: `a-${i}`, apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      );
    }
    await store.reserve(
      request({ reservationId: "b-0", apiKeyId: "key-b", rpmConcurrencyKeyId: "key-b" }),
    );
  });

  test("only the request above the limit is refused", async () => {
    const store = new InMemoryAdmissionCounterStore();
    for (let i = 0; i < 5; i += 1) {
      await store.reserve(
        request({ reservationId: `r-${i}`, apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      );
    }
    // Exactly one refusal, at the sixth — the five already admitted are
    // untouched and never revisited.
    let refused = 0;
    for (let i = 5; i < 12; i += 1) {
      await store
        .reserve(
          request({ reservationId: `r-${i}`, apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
        )
        .catch(() => {
          refused += 1;
        });
    }
    expect(refused).toBe(7);
  });

  test("tolerance widens the ceiling by exactly its value", async () => {
    // limit 5 + tolerance 3 = 8 concurrent, and the 9th is refused.
    const store = new InMemoryAdmissionCounterStore();
    const base = { concurrencyLimit: 5, concurrencyTolerance: 3 } as const;
    for (let i = 0; i < 8; i += 1) {
      await store.reserve(
        request({ ...base, reservationId: `r-${i}`, apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      );
    }
    await expect(
      store.reserve(
        request({ ...base, reservationId: "r-9", apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      ),
    ).rejects.toThrow();
  });

  test("without tolerance the ceiling is the configured limit", async () => {
    const store = new InMemoryAdmissionCounterStore();
    for (let i = 0; i < 5; i += 1) {
      await store.reserve(
        request({ reservationId: `r-${i}`, apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      );
    }
    await expect(
      store.reserve(
        request({ reservationId: "r-6", apiKeyId: "key-a", rpmConcurrencyKeyId: "key-a" }),
      ),
    ).rejects.toThrow();
  });
});
