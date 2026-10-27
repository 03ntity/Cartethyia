/**
 * In-flight provider-dispatch registry — the single source of truth for the
 * live "in flight" gauge. One entry per request that has actually acquired
 * provider-dispatch leases, keyed by `requestId`, carrying the client IP
 * captured at ingress and the hard deadline the flight must not outlive.
 *
 * The registry is *owned* by the `ProxyRequestStateStore` (`state.ts`), which
 * is also the one place that evicts a request, so a flight cannot outlive its
 * state. A separate process-global counter alongside the store's
 * `liveControllers` map would be a second registry able to disagree with it: a
 * flight the store had already torn down would stay counted there forever.
 *
 * The store hands each entry an `expiresAtMs` (the request's hard deadline). A
 * periodic backstop sweep reads `overdue()` and force-releases any flight whose
 * deadline has passed, so the gauge settles even if an abort path never fires.
 *
 * Pub/sub lets the console push the live snapshot over SSE instead of polling.
 * Process-local: each gateway instance reports its own flights.
 */
import { metrics } from "../../observability/metrics";

export interface InFlightSnapshot {
  readonly inFlight: number;
  readonly uniqueIps: number;
  /**
   * How long the longest-lived flight has been tracked, in milliseconds.
   *
   * The count alone cannot tell a healthy queue from a leak: six flights
   * could be six requests in progress or six that never finished. The age
   * separates them — a flight far past its own deadline is the backstop's
   * job, so a growing age with a flat count means the sweep is not running.
   */
  readonly oldestAgeMs: number;
}

interface Flight {
  readonly clientIp: string;
  /** Hard deadline after which the backstop sweep releases this flight. */
  expiresAtMs: number;
  /** When this flight was tracked, for the age reported in a snapshot. */
  readonly startedAtMs: number;
}

export interface InFlightRegistry {
  /** Register a flight once its dispatch leases are acquired. Idempotent per id. */
  track(requestId: string, clientIp: string, expiresAtMs: number): void;
  /** Release a flight. Idempotent; an unknown id is a no-op. */
  untrack(requestId: string): void;
  /** Re-arm a flight's hard deadline (streaming swaps the pre-stream budget). */
  extend(requestId: string, expiresAtMs: number): void;
  snapshot(): InFlightSnapshot;
  count(): number;
  /** Ids whose deadline plus the sweep grace has elapsed — the backstop's worklist. */
  overdue(nowMs: number, graceMs: number): readonly string[];
  subscribe(listener: (snapshot: InFlightSnapshot) => void): () => void;
}

export function createInFlightRegistry(): InFlightRegistry {
  const flights = new Map<string, Flight>();
  const listeners = new Set<(snapshot: InFlightSnapshot) => void>();

  const snapshot = (): InFlightSnapshot => {
    let uniqueIps = 0;
    let oldest = 0;
    const now = Date.now();
    const seen = new Set<string>();
    for (const flight of flights.values()) {
      if (!seen.has(flight.clientIp)) {
        seen.add(flight.clientIp);
        uniqueIps += 1;
      }
      const age = now - flight.startedAtMs;
      if (age > oldest) oldest = age;
    }
    return { inFlight: flights.size, uniqueIps, oldestAgeMs: oldest };
  };

  const publish = (): void => {
    const current = snapshot();
    metrics.proxy_in_flight.set(current.inFlight);
    for (const listener of listeners) listener(current);
  };

  return {
    track(requestId, clientIp, expiresAtMs) {
      flights.set(requestId, {
        clientIp: clientIp.length > 0 ? clientIp : "unknown",
        expiresAtMs,
        startedAtMs: Date.now(),
      });
      publish();
    },
    untrack(requestId) {
      if (!flights.delete(requestId)) return;
      publish();
    },
    extend(requestId, expiresAtMs) {
      const flight = flights.get(requestId);
      if (flight === undefined) return;
      flight.expiresAtMs = expiresAtMs;
    },
    snapshot,
    count() {
      return flights.size;
    },
    overdue(nowMs, graceMs) {
      const ids: string[] = [];
      for (const [requestId, flight] of flights) {
        if (nowMs >= flight.expiresAtMs + graceMs) ids.push(requestId);
      }
      return ids;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
