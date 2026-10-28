/**
 * Qoder's `110` "Billing daily count exceeded" must cool the account as quota,
 * never invalidate the credential.
 *
 * `{"code":"110","message":"Billing daily count exceeded"}` is a spend/limit
 * verdict — the daily billing allowance is exhausted — not an auth one. The
 * status wrapper (often 403) used to fall through to the generic credential
 * arm, so a healthy account was parked as `auth_invalidated` / "Re-login
 * required" and an operator was sent to re-authenticate a credential that was
 * never rejected. The same principle applies to any unmapped numeric provider
 * code: never invalidate on unknown codes — cooldown is the safe default.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";
import { classifyUpstreamError } from "../../src/transport/failure-policy";
import { GatewayError } from "../../src/protocol/gateway-error";

const BILLING_DAILY = '{"code":"110","message":"Billing daily count exceeded"}';
const UPSTREAM = { origin: "upstream" as const, scope: "account" as const };

test("Qoder code-110 billing-limit refusals classify as quota cooldown", () => {
  const classification = classifyAccountError(new Error(BILLING_DAILY), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "110",
    statusCode: 403,
    credentialEvidence: true,
  });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.status).toBe("cooldown");
  expect(classification.category).not.toBe("auth_invalidated");
});

test("Qoder code-110 is never credential invalidation", () => {
  const classification = classifyAccountError(new Error(BILLING_DAILY), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "110",
    statusCode: 401,
    credentialEvidence: true,
  });
  expect(classification.category).not.toBe("auth_invalidated");
});

test("the billing phrase is recognised even when the numeric code is not parsed", () => {
  // The probe path may deliver only the message text.
  const classification = classifyAccountError(new Error("Billing daily count exceeded"), {
    ...UPSTREAM,
    providerId: "qoder",
    statusCode: 403,
  });
  expect(classification.category).toBe("quota_exhausted");
  expect(classification.status).toBe("cooldown");
});

test("upstream classification maps code 110 to quota, not auth", () => {
  const classification = classifyUpstreamError(403, "110");
  expect(classification.code).toBe("quota_exceeded");
  expect(classification.credentialEvidence).toBeUndefined();
});

test("an unknown numeric provider code never invalidates the credential", () => {
  const classification = classifyAccountError(new Error("some opaque error"), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "999",
    statusCode: 403,
    credentialEvidence: true,
  });
  expect(classification.category).not.toBe("auth_invalidated");
  // Unknown → safe cooldown, never a parked/disabled account.
  expect(classification.status).toBe("cooldown");
});

test("textual auth rejection still invalidates the credential", () => {
  const error = new GatewayError(
    "authentication_failed" as never,
    403,
    "invalid api key",
    {} as never,
    "upstream" as never,
  );
  const classification = classifyAccountError(error, {
    origin: "upstream",
    scope: "account",
    providerId: "qoder",
  });
  expect(classification.category).toBe("auth_invalidated");
});
