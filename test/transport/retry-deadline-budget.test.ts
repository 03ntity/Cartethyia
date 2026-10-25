/**
 * A retry must not start an attempt the deadline will kill mid-flight.
 *
 * The pre-dispatch phase (credential, admission, pool slot, prepare) has to be
 * paid again on every retry. On a slow upstream that phase alone measured 60s+
 * against a 120s budget, so the second attempt began past the halfway mark and
 * was cut by the same deadline before the upstream could answer — the loop
 * spent the whole request on an attempt that could never have returned
 * anything, and the client saw that attempt's timeout instead of the first
 * attempt's real error.
 *
 * These drive `runAttemptLoop` with a short deadline and count the attempts
 * that actually start, so the proof is the attempt sequence rather than a
 * classifier. The budget guard is a wall-clock check, so the deadline is set
 * directly on the state instead of through env config.
 */
import { expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { runAttemptLoop } from "../../src/transport/dispatch/attempt-loop";
import type { RouteCandidate } from "../../src/transport/routing/route-model";
import { attemptCandidate as candidate, attemptLeaseSource, attemptState, prepareAttempt } from "../helpers/attempt-loop";

/** Retryable, so failover would otherwise walk to the next candidate. */
function timeout(): GatewayError {
  return new GatewayError("deadline_exceeded", 504, "request deadline exceeded", {}, "upstream");
}

/**
 * Runs the loop with every candidate failing retryably, and returns the
 * candidates actually attempted plus the error the loop finally threw.
 */
async function runUntilExhausted(deadlineMs: number): Promise<{
  readonly attempted: readonly string[];
  readonly thrown: unknown;
}> {
  const previousBase = process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
  process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = "0";
  try {
    const seen: string[] = [];
    let thrown: unknown;
    const candidates = [candidate("wb", "wb-1"), candidate("wb", "wb-2"), candidate("wb", "wb-3")];
    await runAttemptLoop<string, unknown>({
      state: attemptState("req-deadline-budget", Date.now() + deadlineMs),
      deps: { db: {} as never },
      leaseSource: attemptLeaseSource(candidates, "deepseek-v4.1-flash"),
      candidates,
      tenantId: "tenant-1",
      strictPoolSelection: false,
      prepare: prepareAttempt,
      attempt: async (context: { readonly candidate: RouteCandidate }) => {
        seen.push(context.candidate.provider_account_id ?? "");
        throw timeout();
      },
      exhaustedError: new GatewayError("accounts_unavailable", 503, "exhausted"),
    }).catch((error: unknown) => {
      thrown = error;
    });
    return { attempted: seen, thrown };
  } finally {
    if (previousBase === undefined) delete process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"];
    else process.env["CARTETHYIA_FALLBACK_RETRY_BASE_MS"] = previousBase;
  }
}

test("a retry with too little deadline left does not dial another candidate", async () => {
  // 5s left is below the retry budget: the second attempt would be cut by the
  // deadline mid-flight, so the loop stops after the first.
  const { attempted } = await runUntilExhausted(5_000);
  expect(attempted).toEqual(["wb-1"]);
});

test("a retry with room left still dials the next candidate", async () => {
  // Generous deadline: the guard must not suppress failover that can finish.
  const { attempted } = await runUntilExhausted(600_000);
  expect(attempted.length).toBeGreaterThan(1);
});

test("the suppressed retry surfaces the first attempt's own error", async () => {
  const { thrown } = await runUntilExhausted(5_000);
  // Not the sentinel: the client is told why the first attempt failed.
  expect(thrown).toBeInstanceOf(GatewayError);
  expect((thrown as GatewayError).code).toBe("deadline_exceeded");
  expect((thrown as GatewayError).message).not.toContain("exhausted");
});
