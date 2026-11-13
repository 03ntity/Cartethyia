/**
 * Provider-agnostic early arms of the classifier: verdicts that are about
 * transport infrastructure or one (account, model) window rather than any
 * provider family, so they carry no provider-id gate.
 */
import { resolveAccountQuotaCooldownMs } from "../../../config/cooldowns";
import type { AccountErrorRule } from "../account-error-classification";

/**
 * Deployment/proxy infrastructure errors (DEPLOYMENT_DISABLED, etc.) are
 * transport-level proxy pool failures, not account quota exhaustion.
 * Mutating the account parks it for an hour while the pool itself stays
 * healthy — the next request picks the same dying pool and the same error
 * repeats. These must not cooldown the account.
 */
export const deploymentInfraErrorRule: AccountErrorRule = {
  name: "deployment-infra",
  match: (s) => s.deploymentInfraError,
  decide: (s) =>
    s.result(
      "server_error",
      "cooldown",
      60_000,
      null,
      `Proxy deployment error: ${s.message.slice(0, 160)}`,
      false,
    ),
};

/**
 * A (CodeBuddy/WorkBuddy) *frequency* window is a verdict on one
 * (account, model) pair, not on the account: `{"code":"6004","msg":"usage
 * exceeds frequency limit ... your usage will reset at <stamp> UTC+8,
 * alternatively, you can switch to the other models to continue using it."}`.
 * The provider names the remedy itself — use a different model — which is
 * only a remedy if the account still serves every other model. Taken as
 * account-wide `quota_exhausted` it parked the whole account until the reset,
 * so the switch the upstream offered was refused by our own gateway and every
 * sibling model went dark with it; the account also read COOLDOWN /
 * quota_exhausted while only that pair was throttled.
 *
 * Classified `rate_limit_transient` so the writer scopes it to the model:
 * `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
 * account's own status alone. Kept ahead of `quotaSignal`, which matches a
 * *broader* slice of the same wording (`usage exceeds` + `frequency limit`)
 * and would otherwise claim this message as an account-wide quota window.
 * Narrow on purpose — the extra phrase is what says the other models still
 * work; without it the failure stays account-wide.
 */
export const modelFrequencyWindowRule: AccountErrorRule = {
  name: "model-frequency-window",
  match: (s) => s.modelFrequencyWindow,
  decide: (s) => {
    const cooldownMs = s.statedCooldownMs ?? resolveAccountQuotaCooldownMs();
    return s.result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Provider frequency limit for this model"),
      // Provider-scoped evidence still has to reach the writer: a stream frame
      // carries no credential detail, so `canMutate` is false and without this
      // the pair would be retried for the whole window it was closed for.
      s.origin === "upstream" && s.scope === "provider",
    );
  },
};
