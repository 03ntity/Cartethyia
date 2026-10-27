/**
 * `policy_blocked` split into a ban and a request refusal.
 *
 * One category served two shapes that need opposite remedies:
 *
 * - `11140` with `displayMsg` about the account being restricted is a ban. The
 *   credential is refused, so cooldown cannot help and disabling is the fix.
 * - `11-128` / a safety review refuses the request. The credential is fine, so
 *   cooling the account burns a healthy credential on the gateway's own fault.
 *
 * Collapsed together, both got one cooldown — which left a banned account in
 * the plan burning healthy siblings, and marked a good account dead over one
 * malformed body.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { GatewayError } from "../../src/protocol/gateway-error";

/** The real ban payload: `11140` naming a restriction on the account. */
const BANNED_BODY = JSON.stringify({
  code: 11140,
  msg: "request illegal",
  requestId: "83fbb0b4c03d4268b5b6809142b58824",
  displayMsg: { en: "Your account has been restricted due to unusual activity" },
  displayTips: { en: "We detected unusual activity on this account. Submit feedback to appeal this restriction" },
  actions: ["EDIT_INPUT", "SUBMIT_FEEDBACK"],
});

const buddy = { origin: "upstream", scope: "account", providerId: "cb" } as const;

/**
 * The error as the gateway actually builds it: the message the extractor
 * produces is only "request illegal", and the verdict lives in the body the
 * dispatch path stores at `details.raw`.
 *
 * Passing the raw JSON *as the message* is what let the original bug pass its
 * own tests — the wording was then in the message, so a match on the message
 * alone found it. In production the message never carries it.
 */
function bannedError(): GatewayError {
  return new GatewayError(
    // The code the status table produces for a 403 upstream refusal; the
    // policy decision is made by the classifier from the body, not here.
    "authentication_failed",
    403,
    "request illegal",
    { providerId: "cb", providerCode: "11140", raw: BANNED_BODY },
    "upstream",
  );
}

test("a ban disables the account immediately, with no cooldown", () => {
  const c = classifyAccountError(bannedError(), { ...buddy, providerCode: "11140" });
  expect(c.category).toBe("policy_blocked_banned");
  expect(c.status).toBe("disabled");
  expect(c.mutatesAccount).toBe(true);
  // No window: a ban is not a throttle, so there is nothing to wait out.
  expect(c.cooldownMs).toBe(0);
  expect(c.retryAt).toBeNull();
});

test("a ban is detected from the body, not from the message", () => {
  // The message is the same two words the provider uses for a refused request.
  // Only `displayMsg` says the account was restricted, so a classifier that
  // reads only the message reads every ban as a mere refusal: no category, no
  // disable, and the account keeps serving.
  const c = classifyAccountError(bannedError(), { ...buddy, providerCode: "11140" });
  expect(c.category).toBe("policy_blocked_banned");
});

test("a ban named only by an appeal action still disables", () => {
  // `actions` names the remedy: an appeal can only be offered for a verdict
  // about the account, never for a malformed body.
  const body = JSON.stringify({ code: 11140, msg: "request illegal", actions: ["SUBMIT_FEEDBACK"] });
  const error = new GatewayError(
    "authentication_failed",
    403,
    "request illegal",
    { providerId: "cb", providerCode: "11140", raw: body },
    "upstream",
  );
  const c = classifyAccountError(error, { ...buddy, providerCode: "11140" });
  expect(c.category).toBe("policy_blocked_banned");
  expect(c.status).toBe("disabled");
});

test("a ban carries no deadline, so the recovery sweep cannot revive it", () => {
  // `sweepExpiredCooldowns` selects disabled rows only when `cooldownUntil IS
  // NOT NULL`, and that column is written from `retryAt`. A null retryAt is
  // what keeps a banned account out of rotation until an operator acts.
  const c = classifyAccountError(bannedError(), { ...buddy, providerCode: "11140" });
  expect(c.retryAt).toBeNull();
});

test("a request refusal does not touch the account", () => {
  for (const [message, providerCode] of [
    ["Illegal API invocation from an unapproved channel", "11-128"],
    ["request illegal: did not pass the safety review", "11140"],
    ["Request illegal: Account Suspended.", ""],
  ] as const) {
    const c = classifyAccountError(new Error(message), { ...buddy, providerCode });
    expect(c.category).toBe("policy_blocked_invalid_request");
    expect(c.mutatesAccount).toBe(false);
    expect(c.cooldownMs).toBe(0);
  }
});

test("the ban is told apart by the body, not the code alone", () => {
  // Same code, opposite verdicts: only the body says which.
  const banned = classifyAccountError(bannedError(), { ...buddy, providerCode: "11140" });
  const refused = classifyAccountError(new Error("request illegal"), {
    ...buddy,
    providerCode: "11140",
  });
  expect(banned.category).toBe("policy_blocked_banned");
  expect(refused.category).toBe("policy_blocked_invalid_request");
});

test("a non-buddy provider saying 'restricted' is not disabled", () => {
  // The ban test is gated on the buddy family: an unrelated upstream that
  // happens to use the word must not disable accounts.
  const c = classifyAccountError(bannedError(), {
    origin: "upstream",
    scope: "account",
    providerId: "anthropic",
    providerCode: "11140",
  });
  expect(c.category).not.toBe("policy_blocked_banned");
});

/**
 * A refused CONNECT tunnel is a pool failure, not an account failure.
 *
 * `Proxy CONNECT failed: 403 Forbidden` fell through to the unclassified
 * provider arm, which stamped every account behind that pool with a cooldown —
 * so one dead front door on opencode took codebuddy down with it.
 */
test("a proxy CONNECT refusal is scoped to the pool, not the account", () => {
  const c = classifyAccountError(
    new Error("Unclassified provider failure: Proxy CONNECT failed: 403 Forbidden"),
    { origin: "upstream", scope: "account", providerId: "opencode" },
  );
  expect(c.category).toBe("model_unreachable");
  expect(c.mutatesAccount).toBe(false);
  expect(c.cooldownMs).toBe(0);
});

test("a proxy CONNECT refusal never cools the account, whatever scope it arrives with", () => {
  const error = new Error("Proxy CONNECT failed: 403 Forbidden");
  for (const scope of ["account", "provider", "model"] as const) {
    const c = classifyAccountError(error, { origin: "upstream", scope, providerId: "opencode" });
    expect(c.category).toBe("model_unreachable");
    expect(c.mutatesAccount).toBe(false);
  }
});
