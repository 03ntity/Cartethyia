/**
 * Zcode Start Plan (`zcode-start`) classification: the named trial refusal.
 * Start Plan is a separate provider — its named trial refusal rests only that
 * model.
 */
import { resolveAccountQuotaCooldownMs } from "../../../config/cooldowns";
import type { AccountErrorRule } from "../account-error-contracts";

/** The model name a Start Plan refusal named in its message, if any. */
function refusedTrialModel(statusCode: number | null, message: string): string | undefined {
  return statusCode === 400
    ? /no active limited quota for ([\w.-]+)/i.exec(message)?.[1]
    : statusCode === 429
      ? /limited quota(?: for)? ([\w.-]+)(?: is)? exhausted/i.exec(message)?.[1]
      : undefined;
}

/**
 * True when the failure is a Start Plan refusal naming the selected model
 * (ignoring the `-trial` suffix on either spelling). The provider id is
 * resolved by the caller: it may live on the thrown error rather than on the
 * caller's evidence, so it is passed in rather than read from `signals`.
 */
export function zcodeTrialRefusal(
  providerId: string | undefined,
  statusCode: number | null,
  message: string,
  modelId: string | undefined,
): boolean {
  if (providerId !== "zcode-start" || modelId === undefined) return false;
  const refusedModel = refusedTrialModel(statusCode, message);
  return (
    refusedModel !== undefined &&
    refusedModel.toLowerCase().replace(/-trial$/, "") === modelId.toLowerCase().replace(/-trial$/, "")
  );
}

export const zcodeStartPlanTrialRule: AccountErrorRule = {
  name: "zcode-start-plan-trial",
  match: (s) => s.zcodeTrialRefused,
  decide: (s) => {
    const cooldownMs = s.statedCooldownMs ?? resolveAccountQuotaCooldownMs();
    return s.result(
      "model_unreachable",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      s.reason("Start Plan trial unavailable for this model"),
      s.origin === "upstream",
    );
  },
};
