/**
 * A buddy-family channel rejection must not be treated as a healthy request.
 *
 * `11-128` ("Illegal API invocation from an unapproved channel") is the
 * upstream refusing the calling channel for a whole account, not one prompt —
 * it repeats on every invocation. It used to fall through to `unknown` with
 * `mutates=false`, so the account stayed in rotation and failed every request;
 * with every account failing the same way the pool looked dead and nothing was
 * ever parked, so routing never moved on.
 *
 * It is now classified as {@link policy_blocked_invalid_request}: the upstream
 * refused the *request*, and the account's credential is not implicated. A
 * banned account (`11140`) is the shape that disables.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

const evidence = {
  origin: "upstream",
  scope: "account",
  statusCode: 400,
  credentialEvidence: true,
} as const;

function classify(message: string, providerCode: string, providerId: string) {
  return classifyAccountError(new Error(message), {
    ...evidence,
    providerId,
    providerCode,
  });
}

describe("buddy channel rejection 11-128", () => {
  test("is classified as an invalid request and does not mutate the account", () => {
    const c = classify("invalid_request: Illegal API invocation from an unapproved channel", "11-128", "cb");
    expect(c.category).toBe("policy_blocked_invalid_request");
    expect(c.mutatesAccount).toBe(false);
    expect(c.cooldownMs).toBe(0);
  });

  test("is recognised from the message when no provider code is present", () => {
    const c = classify("Illegal API invocation from an unapproved channel", "", "workbuddy");
    expect(c.category).toBe("policy_blocked_invalid_request");
    expect(c.mutatesAccount).toBe(false);
  });

  test("carries no retry window: nothing about the account is wrong", () => {
    // Zero cooldown and a null retryAt are the point — a request refusal must
    // not attach a wait to a credential the upstream never faulted.
    const c = classify("Illegal API invocation from an unapproved channel", "11-128", "cbcn");
    expect(c.cooldownMs).toBe(0);
    expect(c.retryAt).toBeNull();
  });

  test("an upstream account suspension is a request refusal too", () => {
    // The buddy family reports a suspended account as "Request illegal:
    // Account Suspended." — a bare "Account Suspended" carries no provider
    // code, so it is matched on its text rather than a new code constant.
    for (const message of [
      "Request illegal: Account Suspended.",
      "Account Suspended",
    ]) {
      const c = classify(message, "", "cb");
      expect(c.category).toBe("policy_blocked_invalid_request");
      expect(c.mutatesAccount).toBe(false);
    }
  });
  test("stays account-wide only for the buddy family", () => {
    // accounts on a code we have only verified on the buddy family.
    const c = classify("Illegal API invocation from an unapproved channel", "11128", "anthropic");
    expect(c.mutatesAccount).toBe(false);
  });

  test("leaves a malformed-parameter rejection alone", () => {
    // 11133 is a bad *request*, not a bad account: parking every account for
    // one oversized payload would be wrong.
    const c = classify("invalid_request: Invalid request parameters", "11133", "cb");
    expect(c.category).toBe("unknown");
    expect(c.mutatesAccount).toBe(false);
  });
});

describe("buddy credit exhaustion 14018", () => {
  test("is a hard quota cooldown recovered by the twelve-hour sweep", () => {
    const c = classify("Credits exhausted. Please visit the link below to purchase add-on packs", "14018", "cb");
    expect(c.category).toBe("quota_exhausted");
    expect(c.status).toBe("cooldown");
    expect(c.mutatesAccount).toBe(true);
    expect(c.cooldownMs).toBe(12 * 60 * 60 * 1000);
    expect(c.retryAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
  });
});

/**
 * The penalty's *size*, which the assertions above deliberately leave open.
 *
 * This block was a flat 6h here and 24h for the sibling `11140` content block,
 * both applied on the first observation. Both codes are ambiguous from the
 * response alone: `workbuddy/shared.ts` records that the wrong desktop
 * `User-Agent` brand also answers `11140`, and a channel rejection is purely
 * about the calling channel we built — neither says anything about the
 * credential being unusable for a day.
 *
 * A flat day meant that after we fixed a header regression, every buddy account
 * stayed dead for up to a further 24h. As a short base the consecutive-failure
 * ladder decides instead, which is the evidence that actually separates the
 * causes: an account the upstream genuinely refuses is refused again on its very
 * next request and escalates to the cap within minutes, while one bad prompt or
 * one bad header costs five minutes.
 */
/**
 * Neither buddy policy code attaches a wait any more.
 *
 * These used to share one backoff knob on the reasoning that the credential
 * was valid and the block cleared on its own. That reasoning was right about
 * the cause and wrong about the remedy: a cooldown keeps the account in the
 * plan, and a client's retry budget is spent in seconds, so an account the
 * upstream refuses burns healthy siblings for the whole window.
 *
 * A request refusal now costs nothing, and a ban disables outright — so
 * neither shape needs a tunable.
 */
describe("buddy policy codes carry no cooldown", () => {
  test("a request refusal attaches no window to the credential", () => {
    const channel = classify("Illegal API invocation from an unapproved channel", "11-128", "cb");
    expect(channel.cooldownMs).toBe(0);
    expect(channel.retryAt).toBeNull();
    const policy = classify("request illegal: did not pass the safety review", "11140", "cb");
    expect(policy.cooldownMs).toBe(0);
    expect(policy.retryAt).toBeNull();
  });

  test("only a ban disables, and it disables without a window", () => {
    // `disabled`, not `cooldown`: the upstream refuses the account itself, so
    // there is nothing for a sweep to recover from.
    const banned = classify(
      '{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity"}}',
      "11140",
      "cb",
    );
    expect(banned.category).toBe("policy_blocked_banned");
    expect(banned.status).toBe("disabled");
    expect(banned.cooldownMs).toBe(0);
    expect(banned.retryAt).toBeNull();
  });
});

describe("buddy request-scoped codes do not cool the account", () => {
  // Each of these is a verdict on the body or the session, not the credential.
  // Falling through to the generic 400 used to burn a cooldown on a healthy
  // account for a request that fails the same way on every other account.
  const cases = [
    ["11148", "tool_call_sequence_broken"],
    ["11135", "Please start a new conversation, replace the image, and try again."],
    ["11133", "the request parameters were rejected by the model provider"],
    ["11101", "Unmarshal chat params failed with error: unexpected EOF"],
    ["12153", "Offline user session not found"],
    ["14017", "The trial version is not yet activated"],
  ] as const;

  for (const [code, message] of cases) {
    test(`${code} does not mutate the account`, () => {
      const c = classify(message, code, "cb");
      expect(c.mutatesAccount).toBe(false);
      expect(c.cooldownMs).toBe(0);
      expect(c.retryAt).toBeNull();
    });
  }

  test("the same code on a non-buddy provider is left to the generic path", () => {
    // The codes are a buddy-family contract. Applying the exemption everywhere
    // would hide a real account fault on a provider that happens to reuse a number.
    const c = classify("tool_call_sequence_broken", "11148", "anthropic");
    expect(c.category).not.toBe("policy_blocked");
  });

  test("a message match is enough when the code is absent", () => {
    const c = classify("Unmarshal chat params failed with error: unexpected EOF", "", "workbuddy");
    expect(c.mutatesAccount).toBe(false);
  });
});
