import { expect, test } from "bun:test";
import { ProxyRequestStateStore } from "../../src/transport/request/state";

test("in-flight snapshot tracks requests and distinct client IPs until cleanup", () => {
  const store = new ProxyRequestStateStore();
  const first = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  const second = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  first.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };
  second.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };

  first.startProviderFlight();
  second.startProviderFlight();
  // The age is asserted as a bound, not a literal: it is wall-clock, so an
  // exact 0 is a flaky assertion on a loaded machine while the count is not.
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 2, uniqueIps: 1 });
  expect(store.inFlightSnapshot().oldestAgeMs).toBeLessThan(1_000);

  first.cleanup();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 1, uniqueIps: 1 });

  second.cleanup();
  expect(store.inFlightSnapshot()).toMatchObject({ inFlight: 0, uniqueIps: 0 });
  // Nothing tracked, so nothing can be old.
  expect(store.inFlightSnapshot().oldestAgeMs).toBe(0);
});

test("a snapshot reports how long the oldest flight has been tracked", () => {
  // The count cannot tell a healthy queue from a leak: six flights could be
  // six requests in progress or six that never finished. The age separates
  // them, and a flight far past its own deadline is the backstop's job — so a
  // growing age beside a flat count is how a stopped sweep becomes visible.
  const store = new ProxyRequestStateStore();
  const state = store.initialize(new Request("http://localhost/v1/chat/completions"), Date.now(), 60_000);
  state.clientIdentity = { address: "192.0.2.1", source: "tcp-peer" };
  state.startProviderFlight();

  expect(store.inFlightSnapshot().oldestAgeMs).toBe(0);
  state.extendDeadline(60_000);
  // Still zero: an extension moves the deadline, not the start time, so the
  // age keeps measuring how long the flight has been open.
  expect(store.inFlightSnapshot().oldestAgeMs).toBeLessThan(1_000);

  state.cleanup();
  expect(store.inFlightSnapshot().oldestAgeMs).toBe(0);
});
