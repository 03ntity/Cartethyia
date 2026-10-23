/**
 * Lightweight fan-out for completed gateway requests.
 *
 * `notifyRequestCompleted` is called once per terminal request (same site as
 * `telemetryBuffer.enqueue`). Subscribers receive a minimal summary — just
 * enough for the dashboard SSE stream to trigger a targeted refetch rather
 * than polling.
 */

export interface RequestCompletedNotice {
  readonly tenantId: string;
  readonly requestId: string;
  readonly status: string;
  readonly httpStatus: number;
}

type Listener = (notice: RequestCompletedNotice) => void;

const listeners = new Set<Listener>();

/** Notify all subscribers that a request has reached a terminal state. */
export function notifyRequestCompleted(notice: RequestCompletedNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch {
      // Listener failures must not affect the request path.
    }
  }
}

/** Subscribe to per-request terminal notifications; returns unsubscribe. */
export function subscribeRequestCompleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear all subscribers. */
export function resetRequestNotifyForTests(): void {
  listeners.clear();
}
