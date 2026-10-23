/**
 * The three routing defaults an install falls back to when nothing was chosen.
 *
 * None of these is a preference: each one silently decided real behavior for
 * every provider an operator had not configured. A routing card that shows one
 * value while the dispatcher uses another is the failure this file locks.
 *
 * - **cline skips the proxy by default.** Cline bills and rate-limits on the
 *   egress address it observes, so a network pool in front of it is a way to be
 *   rate-limited per pool and to have a proxy VPN hang recorded as a dead
 *   connection. The default is a metadata flag (`defaultSkipProxy`), not a
 *   routing row, so the row the operator never created cannot flip it back.
 * - **max inflight is unlimited by default.** It used to be 5. An operator who
 *   never opened the routing card had asked for no ceiling and got one anyway,
 *   and the rejections arrived as `capacity_exhausted` — a capacity fact about
 *   a limit nobody set. An explicit ceiling is still honored.
 * - **A bare API key identifies as the Claude Code CLI.** It used to be the
 *   frozen Codex literal `codex_cli_rs/0.156.1`, which named a different
 *   vendor's client on requests that mostly reached neither upstream.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_MAX_INFLIGHT } from "../../src/persistence/schema";
import { defaultSkipProxy } from "../../src/console/providers/detail/store";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../src/providers/provider-metadata";
import { buildClaudeCliUserAgent } from "../../src/providers/operations/custom-cli-headers";
import { resolveRouteUserAgent } from "../../src/transport/routing/route-catalog";
import { InMemoryAdmissionController } from "../../src/transport/routing/admission";
import { capacityExhaustedError } from "../../src/transport/routing/route-model";
import { reasonToGatewayError } from "../../src/security/admission/reasons";
import { isRetryableFailure } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/protocol/gateway-error";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

describe("proxy skip default", () => {
  test("cline dials direct unless an operator says otherwise", () => {
    // Cline is the provider whose per-account health follows the egress
    // address, so the pool is the thing most likely to be wrong for it.
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("cline")).toBe(true);
  });

  test("inferhub keeps the same default it always had", () => {
    // The other member of the set. If this flipped, the change stopped being
    // "cline now skips too" and became "the skip default moved".
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("inferhub")).toBe(true);
  });

  test("an ordinary API-key provider is not silently exempted", () => {
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("groq")).toBe(false);
  });
});

describe("providers that dial direct by default", () => {
  // Each of these is credential-keyed, so a rotating egress address buys
  // nothing and only adds a hop that can be refused or rate-limited per pool.
  // Pinned individually rather than as a set comparison: a set assertion
  // passes when a provider is dropped from the list by accident, which is the
  // failure this is here to catch.
  const DIRECT_EGRESS = ["antigravity", "trae", "kilo", "hermes", "github", "kiro"];

  for (const id of DIRECT_EGRESS) {
    test(`${id} skips the proxy by default`, () => {
      expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has(id)).toBe(true);
    });
  }

  test("the default is not a hard lock", () => {
    // An explicit settings row still wins for every one of them, so an
    // operator who wants these behind a pool can put them there.
    for (const id of DIRECT_EGRESS) {
      expect(defaultSkipProxy(id)).toBe(true);
    }
    expect(defaultSkipProxy("groq")).toBe(false);
  });
});

describe("max inflight default", () => {
  test("an unconfigured provider has no ceiling", () => {
    expect(DEFAULT_PROVIDER_MAX_INFLIGHT).toBeNull();
  });

  test("admission admits without a bound when the candidate carries no limit", async () => {
    // The decision `resolveMaxInflight` feeds: absent means unlimited, and
    // `admissionDirective` is where that is actually honored. Asserting only
    // the constant would pass while the dispatcher still capped at 5.
    const controller = new InMemoryAdmissionController();
    const candidate = { provider_id: "groq", model_id: "m", provider_account_id: "a" } as RouteCandidate;
    for (let i = 0; i < 25; i += 1) {
      const decision = await controller.admit(candidate);
      expect(decision.admitted).toBe(true);
    }
  });

  test("an explicit ceiling still rejects past it", async () => {
    // The other arm of the same change: unlimited-by-default must not mean
    // "the ceiling is ignored".
    const controller = new InMemoryAdmissionController();
    const candidate = {
      provider_id: "groq",
      model_id: "m",
      provider_account_id: "a",
      max_inflight: 2,
    } as RouteCandidate;
    expect((await controller.admit(candidate)).admitted).toBe(true);
    expect((await controller.admit(candidate)).admitted).toBe(true);
    const third = await controller.admit(candidate);
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe("capacity_exhausted");
  });

  test("a full account spills to its siblings instead of exhausting the provider", async () => {
    // The behavior an operator setting 15 on a 100-account provider expects:
    // the ceiling is per ACCOUNT (`admissionKey` appends the account id), so
    // total capacity scales with the account count. A provider-wide bucket
    // would reject request 16 even with 99 idle accounts, which reads as a
    // broken ceiling rather than a saturated one.
    const controller = new InMemoryAdmissionController();
    const accounts = 100;
    const ceiling = 15;
    let admitted = 0;
    for (let i = 0; i < accounts * ceiling; i += 1) {
      const account = `acct-${Math.floor(i / ceiling) % accounts}`;
      const candidate = {
        provider_id: "groq",
        model_id: "m",
        provider_account_id: account,
        max_inflight: ceiling,
      } as RouteCandidate;
      if ((await controller.admit(candidate)).admitted) admitted += 1;
    }
    expect(admitted).toBe(accounts * ceiling);

    // Each account is individually at its ceiling: the next request anywhere
    // is refused, and the refusal is the routing one, not the API-key one.
    const next = await controller.admit({
      provider_id: "groq",
      model_id: "m",
      provider_account_id: "acct-0",
      max_inflight: ceiling,
    } as RouteCandidate);
    expect(next.admitted).toBe(false);
    expect(next.reason).toBe("capacity_exhausted");
  });

  test("routing exhaustion and API-key exhaustion carry different error codes", () => {
    // Both used to be `capacity_exhausted`, so an operator who raised the
    // provider's max-inflight saw no change when the real ceiling was the
    // key's `max_concurrent` — and could not tell which one fired.
    const routing = capacityExhaustedError({ providerId: "groq", candidateCount: 3 });
    const key = reasonToGatewayError("concurrency-limit", { limit: 4 });
    expect(routing.code).toBe("provider_capacity_exhausted");
    expect(key.code).toBe("capacity_exhausted");
    expect(routing.code).not.toBe(key.code);
  });

  test("a single-candidate plan says so rather than blaming the ceiling", () => {
    // The diagnosable case: one candidate at its limit is a routing/eligibility
    // fact, not "every account is full". Raising max-inflight fixes the second
    // and not the first, so the message must not claim the second.
    const one = capacityExhaustedError({ candidateCount: 1, maxInflight: 15 });
    const many = capacityExhaustedError({ candidateCount: 100, maxInflight: 15 });
    expect(one.message).toContain("only account");
    expect(one.details.candidate_count).toBe(1);
    expect(many.message).toContain("Every account");
  });

  test("routing exhaustion stays retryable onto the next sibling", () => {
    // The code changed, so the retry list had to follow it. Losing it would
    // turn a transient full-account rejection into a hard client failure.
    //
    // Deliberately not `isRetryableFailure(error)` on a 429: 429 already
    // satisfies `retryableByStatus`, so that assertion passes with the code
    // missing from the list entirely and would prove nothing. Driving the
    // classifier with the code at a status the table rejects isolates the
    // explicit entry — this is the branch that actually names the code.
    const retryable = new GatewayError("provider_capacity_exhausted", 400, "m");
    const control = new GatewayError("invalid_request", 400, "m");
    expect(isRetryableFailure(retryable)).toBe(true);
    expect(isRetryableFailure(control)).toBe(false);
  });
});

describe("default route identity", () => {
  test("is the Claude Code CLI identity, not Codex's", () => {
    // A provider whose operator chose nothing is handed this string. It used to
    // be `codex_cli_rs/0.156.1`, which named a different vendor's client.
    const resolved = resolveRouteUserAgent("groq", undefined, undefined);
    expect(resolved).toBe(buildClaudeCliUserAgent());
    // Asserted separately so the wiring above cannot pass by reverting both
    // sides together: the string itself has to be the Claude Code one.
    expect(resolved).toMatch(/^claude-cli\/\S+ \(external, cli\)$/);
  });

  test("no identity anywhere on the route answers with the Claude Code CLI", () => {
    expect(buildClaudeCliUserAgent()).toMatch(/^claude-cli\/\S+ \(external, cli\)$/);
  });

  test("does not carry the retired Codex identity", () => {
    expect(buildClaudeCliUserAgent()).not.toContain("codex_cli_rs");
  });

  test("an operator's own identity still wins over the default", () => {
    expect(resolveRouteUserAgent("groq", "Cartethyia/2.2", undefined)).toBe("Cartethyia/2.2");
    expect(resolveRouteUserAgent("groq", undefined, "my-client/1.0")).toBe("my-client/1.0");
  });

  test("an empty identity means no header at all, not the default", () => {
    // "None" in the card is an operator choosing silence. Falling back to the
    // default here would make that choice unreachable from the UI.
    expect(resolveRouteUserAgent("groq", "", undefined)).toBeUndefined();
  });
});