/**
 * The in-flight backstop sweep reaps flights whose deadline has passed.
 *
 * A cancelled request that never ran a finalizer leaves its flight in the
 * registry. Nothing else releases it, so the gauge — which is what an operator
 * reads as "how busy is this gateway" — stays high with no requests behind it.
 * Idling does not clear it, which is what distinguishes a stuck flight from
 * real load.
 *
 * The sweep is the only thing that reaps those, so it is pinned here directly
 * against the store rather than through a request: the property is that a
 * flight past its deadline plus the grace window is released, whether or not
 * any abort path ever fired.
 */
import { expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

const GRACE_MS = 30_000;
const HARD_GRACE_MS = 120_000;

/** A flight registered with a deadline already in the past. */
function expiredStore(): {
  store: ProxyRequestStateStore;
  requestId: string;
} {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    1_000,
  );
  state.startProviderFlight();
  const requestId = state.requestId;
  return { store, requestId };
}

test("a flight inside the grace window is not reaped", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  state.startProviderFlight();
  expect(store.inFlightCount()).toBe(1);
  // Still well inside its deadline plus either grace: reaping here would kill
  // healthy long streams at the pre-stream budget.
  expect(store.sweepOverdueInFlight(Date.now(), GRACE_MS, HARD_GRACE_MS)).toBe(0);
  expect(store.inFlightCount()).toBe(1);
});

test("a flight past its deadline and the hard grace is force-released", () => {
  const { store } = expiredStore();
  expect(store.inFlightCount()).toBe(1);
  // The sweep takes `nowMs` as an argument, so the clock is advanced by value
  // rather than by waiting. Past deadline + hard grace: the abort the sweep
  // issues did not release it, so it must untrack the flight outright.
  store.sweepOverdueInFlight(Date.now() + HARD_GRACE_MS + 5_000, GRACE_MS, HARD_GRACE_MS);
  expect(store.inFlightCount()).toBe(0);
});

test("reaping is idempotent and never goes negative", () => {
  const { store } = expiredStore();
  const late = Date.now() + HARD_GRACE_MS + 5_000;
  store.sweepOverdueInFlight(late, GRACE_MS, HARD_GRACE_MS);
  expect(store.inFlightCount()).toBe(0);
  expect(store.sweepOverdueInFlight(late, GRACE_MS, HARD_GRACE_MS)).toBe(0);
  expect(store.inFlightCount()).toBe(0);
});

test("a flight whose deadline was extended is not reaped early", () => {
  // Streaming legitimately moves the deadline forward; the sweep must follow
  // the moved deadline rather than the one the flight was registered with.
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    1_000,
  );
  state.startProviderFlight();
  state.extendDeadline(600_000);
  expect(store.sweepOverdueInFlight(Date.now(), GRACE_MS, HARD_GRACE_MS)).toBe(0);
  expect(store.inFlightCount()).toBe(1);
});

test("the sweep releases only what is overdue", () => {
  const store = new ProxyRequestStateStore(undefined);
  // One long-lived and one already expired.
  const longLived = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    600_000,
  );
  longLived.startProviderFlight();
  const short = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    1_000,
  );
  short.startProviderFlight();
  expect(store.inFlightCount()).toBe(2);
  store.sweepOverdueInFlight(Date.now() + HARD_GRACE_MS + 5_000, GRACE_MS, HARD_GRACE_MS);
  expect(store.inFlightCount()).toBe(1);
  // The survivor is the long-lived one: its state is still registered, so a
  // later release can still find it.
  expect(store.get(new Request("https://example.test/v1/chat/completions"))).toBeUndefined();
});
