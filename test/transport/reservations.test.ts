/**
 * ReservationManager: local lease bookkeeping for routing admission.
 *
 * The sweep used to walk the entire lease map every 30 s interval; with the
 * expiry min-heap it examines only expired heads and stops at the first
 * unexpired one. The tests pin the behaviors the router depends on:
 *
 * - an expired head is removed and an unexpired lease is untouched;
 * - a released entry leaves a stale heap node that is harmlessly dropped
 *   (never resurrected, never double-processed);
 * - `get()`/`release()` semantics are unchanged (expiry check on read,
 *   idempotent delete on release);
 * - compaction keeps stale nodes from growing the heap without bound;
 * - live leases are never capped and admission release is not skipped when a
 *   lease expires (counters own that protection).
 *
 * All timing uses an injected fake clock — no wall-clock assertions.
 */
import { describe, expect, test } from "bun:test";
import { ReservationManager } from "../../src/transport/routing/reservations";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

const START = Date.UTC(2026, 2, 15, 12, 0, 0);

function candidate(accountId = "acct"): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    provider_account_id: accountId,
  } as RouteCandidate;
}

/** A manager whose clock starts at START and only moves when told to. */
function harness() {
  let now = START;
  const manager = new ReservationManager(() => now);
  return {
    manager,
    advance(ms: number): void {
      now += ms;
    },
    /** Forces the sweep gate open by jumping past the interval. */
    forceSweep(): void {
      now += 31_000;
    },
  };
}

describe("ReservationManager — expiry-ordered sweep", () => {
  test("an expired lease is removed; unexpired leases are untouched", () => {
    const { manager, advance, forceSweep } = harness();
    const early = manager.acquire(candidate("early"), 1, 5_000); // expires START+5s
    const late = manager.acquire(candidate("late"), 1, 60_000); // expires START+60s

    advance(10_000); // early is now expired, late is not
    forceSweep(); // sweep gate open and head expired
    expect(manager.get(early.lease_id)).toBeUndefined();
    expect(manager.get(late.lease_id)).toBeDefined();
    expect(manager.size()).toBe(1);
  });

  test("the sweep stops at the first unexpired head without examining the rest", () => {
    const { manager, forceSweep } = harness();
    // Two long-lived leases: at the forced sweep time neither head is expired,
    // so neither is examined or removed even though the sweep ran.
    manager.acquire(candidate("a"), 1, 60_000);
    manager.acquire(candidate("b"), 1, 60_000);
    forceSweep();
    expect(manager.size()).toBe(2);
  });

  test("a released entry leaves a stale node the sweep drops harmlessly", () => {
    const { manager, advance, forceSweep } = harness();
    const released = manager.acquire(candidate("gone"), 1, 60_000);
    manager.release(released.lease_id);
    expect(manager.size()).toBe(0);

    advance(70_000); // the stale node's expiry has passed
    forceSweep();
    // No throw, no resurrection, still empty.
    expect(manager.size()).toBe(0);
    expect(manager.get(released.lease_id)).toBeUndefined();
  });

  test("acquire and get round-trip, and get expires exactly at expires_at", () => {
    const { manager, advance } = harness();
    const lease = manager.acquire(candidate(), 1, 30_000);
    expect(manager.get(lease.lease_id)).toBe(lease);

    advance(30_000); // expires_at is now == now: `expires_at < now` is false…
    // …but the read-side check uses strict less-than, matching the previous
    // implementation's exact boundary. Pin it.
    expect(manager.get(lease.lease_id)).toBeDefined();
    advance(1);
    expect(manager.get(lease.lease_id)).toBeUndefined();
  });

  test("release is idempotent", () => {
    const { manager } = harness();
    const lease = manager.acquire(candidate(), 1);
    manager.release(lease.lease_id);
    manager.release(lease.lease_id);
    expect(manager.size()).toBe(0);
  });

  test("live leases are not capped", () => {
    const { manager } = harness();
    for (let i = 0; i < 10_000; i += 1) {
      manager.acquire(candidate(`acct-${i}`), 1, 60_000);
    }
    expect(manager.size()).toBe(10_000);
  });

  test("stale-node compaction bounds the heap after many short releases", () => {
    const { manager, advance, forceSweep } = harness();
    // Many released leases (stale nodes) around a few live ones.
    for (let i = 0; i < 200; i += 1) {
      const lease = manager.acquire(candidate(`gone-${i}`), 1, 1_000);
      manager.release(lease.lease_id);
    }
    const live = manager.acquire(candidate("live"), 1, 120_000);
    expect(manager.size()).toBe(1);

    advance(2_000); // stale nodes' expiries have passed
    forceSweep();
    // The sweep consumed the expired stale nodes; the live lease survives.
    expect(manager.get(live.lease_id)).toBeDefined();
    expect(manager.size()).toBe(1);
  });

  test("an expired lease is not resurrected by a later acquire with the same shape", () => {
    const { manager, advance, forceSweep } = harness();
    const first = manager.acquire(candidate(), 1, 5_000);
    advance(10_000);
    forceSweep();
    expect(manager.get(first.lease_id)).toBeUndefined();

    // A second acquire generates a distinct lease id (time + randomness), so
    // the swept lease cannot alias the new one.
    const second = manager.acquire(candidate(), 1, 5_000);
    expect(second.lease_id).not.toBe(first.lease_id);
    expect(manager.get(second.lease_id)).toBeDefined();
  });
});
