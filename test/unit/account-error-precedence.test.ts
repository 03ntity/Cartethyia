import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

/**
 * One expectation per arm of the ordered classifier, plus the precedence pairs
 * that decide between arms matching the same message.
 *
 * The chain is order-sensitive by construction: a later arm is a *broader*
 * match than the arm above it, so an earlier arm only wins because it is
 * reached first. Several arms (price refusal, deployment-infra, hosted-tool,
 * entitlement, model-unreachable) had no direct test at all — only the
 * incidents that motivated them. Any reordering or re-scoping in the
 * classifier has to fail here, not in production.
 */

function classify(
  message: string,
  options: Partial<{
    statusCode: number;
    providerCode: string;
    providerId: string;
    credentialEvidence: boolean;
    credentialKind: string;
    staticToken: boolean;
    modelId: string;
  }> = {},
): ReturnType<typeof classifyAccountError> {
  return classifyAccountError(new Error(message), {
    origin: "upstream",
    scope: "account",
    ...options,
  } as never);
}

describe("classifyAccountError — every arm classifies once", () => {
  test("a price refusal is quota-shaped but never cools the account", () => {
    // 402 + a bid the upstream would not match: the caller's ceiling is at
    // fault, so the cooldown is zero and no deadline is stamped.
    const c = classify("no provider's ask matches your max-per-mtok bid", { statusCode: 402 });
    expect(c.category).toBe("quota_exhausted");
    expect(c.cooldownMs).toBe(0);
    expect(c.retryAt).toBeNull();
    expect(c.mutatesAccount).toBe(false);
  });

  test("a deployment error is a short transport cooldown with no deadline", () => {
    // The pool is dying, not the account: parking the account leaves the pool
    // healthy and the next request repeats the failure.
    const c = classify("DEPLOYMENT_DISABLED for this region");
    expect(c.category).toBe("server_error");
    expect(c.cooldownMs).toBe(60_000);
    expect(c.retryAt).toBeNull();
    expect(c.mutatesAccount).toBe(false);
  });

  test("a model frequency window is scoped to the model, not the account", () => {
    const c = classify(
      "usage exceeds frequency limit, alternatively, you can switch to the other models",
      { statusCode: 429, providerCode: "6004", providerId: "cb" },
    );
    expect(c.category).toBe("rate_limit_transient");
    expect(c.retryAt).not.toBeNull();
  });

  test("a buddy content-policy rejection is a request refusal, not an account ban", () => {
    const c = classify("request illegal: did not pass the safety review", {
      statusCode: 403,
      providerCode: "11140",
      providerId: "cb",
    });
    // A safety review refuses this request; the account is fine. Cooling it
    // was the bug that made one malformed body look like a dead credential.
    expect(c.category).toBe("policy_blocked_invalid_request");
    expect(c.mutatesAccount).toBe(false);
    expect(c.cooldownMs).toBe(0);
  });

  test("a buddy account ban disables the account immediately", () => {
    const c = classify(
      '{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity"},"actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}',
      { statusCode: 403, providerCode: "11140", providerId: "cb" },
    );
    // A ban is a verdict on the credential, not a throttled window: disabled
    // with no cooldown, so it cannot burn healthy siblings while "cooling".
    expect(c.category).toBe("policy_blocked_banned");
    expect(c.status).toBe("disabled");
    expect(c.mutatesAccount).toBe(true);
    expect(c.cooldownMs).toBe(0);
  });

  test("a request-scoped buddy code is recorded without a cooldown", () => {
    const c = classify("tool_call_sequence_broken", {
      statusCode: 400,
      providerCode: "11148",
      providerId: "cb",
    });
    expect(c.category).toBe("unknown");
    expect(c.cooldownMs).toBe(0);
    expect(c.mutatesAccount).toBe(false);
  });

  test("a channel rejection is a request refusal, not an account ban", () => {
    const c = classify("Illegal API invocation from an unapproved channel", {
      providerCode: "11-128",
      providerId: "cb",
    });
    expect(c.category).toBe("policy_blocked_invalid_request");
    expect(c.mutatesAccount).toBe(false);
  });

  test("a hosted tool failure is never an auth verdict", () => {
    // Surfaced as 403, which the auth arm would otherwise claim as account
    // evidence; refreshing a token cannot repair a search backend.
    const c = classify("web_search tool invocation failed", {
      statusCode: 403,
      credentialEvidence: true,
    });
    expect(c.category).not.toBe("auth_invalidated");
    expect(c.mutatesAccount).toBe(false);
  });

  test("a model entitlement rejection is scoped to the model", () => {
    const c = classify("You do not have a valid license of this product", {
      statusCode: 403,
      credentialEvidence: true,
      modelId: "claude-opus-4-6",
    });
    expect(c.category).toBe("model_unreachable");
    expect(c.mutatesAccount).toBe(true);
  });

  test("a queued 403 is capacity, not an auth verdict", () => {
    const c = classify('{"isQueued":true,"modelKey":"dfmodel","queueCount":1395}', {
      statusCode: 403,
      providerCode: "10605",
      providerId: "qoder",
      credentialEvidence: true,
    });
    expect(c.category).toBe("model_capacity");
  });

  test("an unsupported model is reported as unsupported so the writer escalates", () => {
    const c = classify("service info not found", {
      statusCode: 400,
      providerCode: "11102",
      providerId: "cb",
      modelId: "glm-5.2",
    });
    expect(c.category).toBe("model_unreachable");
    expect(c.modelUnsupported).toBe(true);
  });

  test("a plan-gated Qoder 112 is model-scoped, not a balance verdict", () => {
    const c = classify('{"pricingUrl":"https://qoder.com/pricing"}', {
      providerCode: "112",
      providerId: "qoder",
      modelId: "claude-opus-4-6",
    });
    expect(c.category).toBe("model_unreachable");
  });

  test("a rate limit cools the account down", () => {
    const c = classify("rate limit exceeded", { statusCode: 429 });
    expect(c.category).toBe("rate_limit_transient");
    expect(c.cooldownMs).toBeGreaterThan(0);
  });

  test("a 5xx transport fault is a short cooldown", () => {
    const c = classify("fetch failed", { statusCode: 502 });
    expect(c.category).toBe("server_error");
    expect(c.mutatesAccount).toBe(true);
  });

  test("a timeout is its own category", () => {
    const c = classify("request timeout", { statusCode: 504 });
    expect(c.category).toBe("timeout");
  });

  test("an unrecognised failure still gets a bounded backoff", () => {
    const c = classify("something the classifier has never seen");
    expect(c.category).toBe("unknown");
    expect(c.cooldownMs).toBeGreaterThan(0);
    expect(c.retryAt).not.toBeNull();
  });
});

describe("classifyAccountError — precedence between overlapping arms", () => {
  test("a price refusal beats the quota arm that also matches it", () => {
    // Both arms match a 402: `quotaSignal` includes `statusCode === 402`, so
    // the refusal is only non-mutating because it is classified first.
    const refusal = classify("no provider's ask matches your max-per-mtok bid", { statusCode: 402 });
    const plain = classify("payment required", { statusCode: 402 });
    expect(refusal.cooldownMs).toBe(0);
    expect(plain.cooldownMs).toBeGreaterThan(0);
    expect(plain.category).toBe("quota_exhausted");
  });

  test("the narrow model window beats the account-wide quota wording", () => {
    const narrow = classify(
      "usage exceeds frequency limit, alternatively, you can switch to the other models",
      { statusCode: 429, providerId: "cb" },
    );
    const broad = classify("usage exceeds frequency limit", { statusCode: 429, providerId: "cb" });
    expect(narrow.category).toBe("rate_limit_transient");
    expect(broad.category).toBe("quota_exhausted");
  });

  test("a revoked token disables; a bare rejection cools down", () => {
    const revoked = classify("token revoked", { credentialEvidence: true, credentialKind: "oauth" });
    const bare = classify("invalid api key", { statusCode: 401, credentialEvidence: true });
    expect(revoked.status).toBe("disabled");
    expect(revoked.category).toBe("auth_invalidated");
    expect(bare.status).toBe("cooldown");
  });

  test("a static token is never disabled, even when revoked", () => {
    const c = classify("token revoked", {
      credentialEvidence: true,
      credentialKind: "oauth",
      staticToken: true,
    });
    expect(c.status).toBe("cooldown");
  });

  test("a named revocation outranks the request-scoped exclusions", () => {
    // `token revoked` also reads as an auth phrase; the auth arm runs after
    // the buddy request-scoped arm, which is provider-gated and must not claim it.
    const c = classify("token revoked", { providerId: "cb" });
    expect(c.category).toBe("auth_invalidated");
  });

  test("model-unreachable beats the 5xx arm it would otherwise fall into", () => {
    const c = classify("model not found", { statusCode: 404, providerCode: "not_found" });
    expect(c.category).toBe("model_unreachable");
  });

  test("a Trae quota body beats the 502 status it arrives on", () => {
    const c = classify("Your requests have exceeded the quota.", {
      statusCode: 502,
      providerId: "trae",
    });
    expect(c.category).toBe("quota_exhausted");
  });
});
