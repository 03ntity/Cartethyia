/**
 * Qoder's code-112 pricing refusal must cool the *model*, never the account.
 *
 * `{"code":"112","message":"{\"pricingUrl\":...}"}` is a "this model is not
 * included in your plan, buy more" verdict for one (account, model) pair. If
 * it were treated as account-wide quota exhaustion, every other model on the
 * account goes dark with it — the exact symptom reported: one gated model
 * parked the whole account. The classifier must produce a model-scoped
 * verdict (`model_unreachable`, mutating so the writer writes
 * `modelCooldowns[modelId]`), and stay non-mutating when no model is known so
 * an unknown-pair refusal never parks the account either.
 */
import { expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

const QODER_112 = '{"code":"112","message":"{\\"pricingUrl\\":\\"https://qoder.com/pricing?client=qoder\\"}"}';
const UPSTREAM = { origin: "upstream" as const, scope: "provider" as const };

test("Qoder code-112 refusals cool the model, not the account", () => {
  const classification = classifyAccountError(new Error(QODER_112), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "112",
    statusCode: 400,
    modelId: "deepseek-v4.1-flash",
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.status).toBe("cooldown");
  // Mutating = the writer records `modelCooldowns[modelId]` and leaves the
  // account routable for its other models.
  expect(classification.mutatesAccount).toBe(true);
});

test("Qoder code-112 with a virtual/auto model id still scopes to that model", () => {
  const classification = classifyAccountError(new Error(QODER_112), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "112",
    statusCode: 400,
    modelId: "auto",
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.mutatesAccount).toBe(true);
});

test("Qoder code-112 without a model id never parks the account", () => {
  const classification = classifyAccountError(new Error(QODER_112), {
    ...UPSTREAM,
    providerId: "qoder",
    providerCode: "112",
    statusCode: 400,
  });
  expect(classification.category).toBe("model_unreachable");
  expect(classification.mutatesAccount).toBe(false);
});
