/**
 * Process-wide concurrency cap.
 *
 * Per-key and per-tenant caps already exist, and they are the right place for
 * a fair share. They do not bound the process: a hundred keys each inside
 * their own cap still open a hundred upstream calls at once, and the event
 * loop, the database pool, and the upstream all feel that as one burst.
 *
 * This admits requests into this process and refuses past the cap with 503 and
 * a retry hint. It is deliberately not a queue: queueing would hold the
 * connection open and make the overload look like latency. A client that
 * retries after the hint lands on a process that has drained.
 *
 * The cap is now DERIVED — see `config/resources.ts` — rather than a constant,
 * because a constant cap admits the same concurrency on a 512 MiB container as
 * on a 4 GiB one, and only the latter can actually hold it.
 */
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import { resolveProcessConcurrency } from "../../config/resources";
import { resolveMemoryLimitBytes } from "../../observability/runtime-metrics";
import { fastPathname } from "../pathname";

/** In-flight `/v1` requests one process will carry before refusing. */
export const PROCESS_CONCURRENCY_CAP = resolveProcessConcurrency(
  resolveMemoryLimitBytes() ?? 512 * 1024 * 1024,
);
const PROCESS_CONCURRENCY_RETRY_MS = 3_000;

/**
 * A bounded set of in-flight tokens.
 *
 * Owned by the caller rather than held in a module global: the previous shape
 * was one `let inFlight` for the whole module, so two middleware instances
 * (tests, or a second app in one process) shared and corrupted a single count.
 */
export interface ProcessConcurrencyController {
  /**
   * Takes a token, or returns `undefined` when the process is full.
   *
   * The returned release function is idempotent — released twice still frees
   * exactly one token — because a request can reach more than one completion
   * path (an abort racing a normal finish).
   */
  tryAcquire(): (() => void) | undefined;
  /** Tokens currently held. */
  activeCount(): number;
  /** The effective cap. */
  limit(): number;
}

export function createProcessConcurrencyController(
  limit: number = PROCESS_CONCURRENCY_CAP,
): ProcessConcurrencyController {
  const effective = Math.min(64, Math.max(1, Math.trunc(limit)));
  let active = 0;
  return {
    tryAcquire() {
      if (active >= effective) return undefined;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (active > 0) active -= 1;
      };
    },
    activeCount() {
      return active;
    },
    limit() {
      return effective;
    },
  };
}

/**
 * The controller the middleware below uses when none is injected.
 *
 * Exported so the metrics sampler can publish its live count: in-flight
 * concurrency is the number that explains both a latency rise and a shed, and
 * a gauge nobody sets is worse than no gauge.
 */
export const defaultProcessConcurrencyController = createProcessConcurrencyController();

/**
 * The middleware.
 *
 * The token is keyed by the Request object in a `WeakMap` and released only if
 * one was actually taken. The previous code decremented a module-global count
 * in `afterResponse` for every `/v1` request — including the ones this guard
 * had just REJECTED, which never incremented it. Under sustained overload that
 * drove the count down spuriously and let more requests through than the cap
 * allows, which is the opposite of what a cap is for.
 */
export function createProcessConcurrencyMiddleware(
  controller: ProcessConcurrencyController = defaultProcessConcurrencyController,
): Elysia {
  const tokens = new WeakMap<Request, () => void>();
  return new Elysia()
    .beforeHandle(({ request }) => {
      const path = fastPathname(request.url);
      // Only the gateway surface counts. Console reads and health probes must
      // still answer while the process is saturated, or an operator cannot
      // see why it is refusing.
      if (!path.startsWith("/v1/")) return;
      const release = controller.tryAcquire();
      if (release === undefined) {
        throw new GatewayError(
          "platform_unavailable",
          503,
          "The gateway is at its concurrency limit. Retry shortly.",
          { retryAfterMs: PROCESS_CONCURRENCY_RETRY_MS },
        );
      }
      tokens.set(request, release);
    })
    .afterResponse(({ request }: { request: Request }) => {
      const release = tokens.get(request);
      if (release === undefined) return;
      tokens.delete(request);
      release();
    })
    .as("plugin");
}
