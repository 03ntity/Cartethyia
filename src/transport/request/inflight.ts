/**
 * The live "in flight" snapshot shape, shared by the store, the console live
 * domain, and the dashboard. Derived from the request state store's own
 * `liveControllers` map — the single registry that already owns a request's
 * lifetime — so the gauge cannot disagree with what is actually running.
 */
export interface InFlightSnapshot {
  readonly inFlight: number;
  readonly uniqueIps: number;
}
