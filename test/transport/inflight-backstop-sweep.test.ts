/**
 * The in-flight backstop sweep aborts requests whose deadline has passed.
 *
 * A request whose abort path never fired (a half-closed socket that neither
 * pulls, cancels, nor aborts) stays in the store past its deadline. Nothing
 * else unblocks it, so the fetch — and the slot the operator reads as
 * "in flight" — hangs. The sweep aborts those; the request's own cleanup then
 * drops every entry it owns, so the gauge cannot disagree with the lifecycle.
 *
 * The sweep is pinned here directly against the store rather than through a
 * request: the property is that a flight past its deadline plus the grace
 * window is aborted, whether or not any abort path ever fired.
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

test("a flight inside the grace window is not touched", () => {
  const store = new ProxyRequestStateStore(undefined);
  const state = store.initialize(
    new Request("https://example.test/v1/chat/completions", { method: "POST" }),
    Date.now(),
    60_000,
  );
  state.startProviderFlight();
  expect(store.inFlightCount()).toBe(1);
  // Still well inside its deadline plus grace: aborting here would kill
  // healthy long streams at the pre-stream budget.
  expect(store.sweepOverdueInFlight(Date.now(), GRACE_MS, HARD_GRACE_MS)).toBe(0);
  expect(store.inFlightCount()).toBe(1);
});

test("a flight past its deadline plus grace is aborted and released", () => {
  const { store } = expiredStore();
  expect(store.inFlightCount()).toBe(1);
  // The sweep takes `nowMs` as an argument, so the clock is advanced by value
  // rather than by waiting. The abort unwinds the controller and the state's
  // cleanup drops the flight entry with it.
  store.sweepOverdueInFlight(Date.now() + HARD_GRACE_MS + 5_000, GRACE_MS, HARD_GRACE_MS);
  expect(store.inFlightCount()).toBe(0);
});

test("the sweep is idempotent", () => {
  const { store } = expiredStore();
  const late = Date.now() + HARD_GRACE_MS + 5_000;
  store.sweepOverdueInFlight(late, GRACE_MS, HARD_GRACE_MS);
  expect(store.inFlightCount()).toBe(0);
  expect(store.sweepOverdueInFlight(late, GRACE_MS, HARD_GRACE_MS)).toBe(0);
  expect(store.inFlightCount()).toBe(0);
});

test("a flight whose deadline was extended is not aborted early", () => {
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

test("the sweep touches only what is overdue", () => {
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
