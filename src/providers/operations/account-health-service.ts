import { healthEventBuffer } from "../../persistence/health-event-flush";
// Account health: error classification, failure/success recording, recovery and cooldown sweeps.
import { and, count, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { affectedRows, pruneExpiredCooldowns } from "../../persistence/dialect";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { isRecord } from "../../protocol/codecs";
import { GatewayError } from "../../protocol/gateway-error";
import { BUDDY_PROVIDER_IDS } from "../provider-metadata";
import { healthEvents, providerAccounts } from "../../persistence/schema";

import { parseProviderResetDuration, parseUpstreamBackoff } from "../../transport/failure-policy";
import {
  resolveAccountAuthRejectedCooldownMs,
  resolveAccountCooldownEscalationMaxMs,
  resolveAccountDisabledRecoveryMs,
  resolveAccountModelCapacityCooldownMs,
  resolveAccountPolicyBlockCooldownMs,
  resolveAccountQuotaCooldownMs,
  resolveAccountRateLimitCooldownMs,
  resolveAccountTransientCooldownMs,
  resolveAccountUnclassifiedCooldownMs,
} from "../../config/cooldowns";
// ===== health/constants.ts =====
/**
 * Account status is authoritative for routing: `disabled` is a hard exclusion
 * until an operator restores it, while `cooldown` is a *soft* one — the account
 * is deprioritized behind every healthy sibling and reached only when nothing
 * better is left, so a cooling credential still serves rather than parking the
 * model entirely.
 *
 * Every delay below is a *fallback*: an upstream `Retry-After`/reset header or
 * a duration stated in the provider message always wins. They are read through
 * `src/config/cooldowns.ts` so an operator can tune the health machine without a code
 * change (`CARTETHYIA_ACCOUNT_*_COOLDOWN_MS`).
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = resolveAccountRateLimitCooldownMs;
// Fallback when the error states no usable duration: deliberately short (1h,
// not 24h) — quota state is re-probed on the next failure, so an unknown
// reset cadence self-corrects instead of parking the account for a day.
const DEFAULT_QUOTA_COOLDOWN_MS = resolveAccountQuotaCooldownMs;
const MODEL_CAPACITY_COOLDOWN_MS = resolveAccountModelCapacityCooldownMs;
const TRANSIENT_ERROR_COOLDOWN_MS = resolveAccountTransientCooldownMs;
/**
 * Accounts one cooldown-recovery pass brings back. The sweep ticks every 30s,
 * so a larger backlog drains over successive passes rather than one statement
 * covering every expired row.
 */
const COOLDOWN_RECOVERY_BATCH = 500;
/**
 * Backoff for a failure no rule matched. Short on purpose: an unclassified
 * error is more likely a new upstream shape than a broken account, so the
 * account returns to rotation quickly.
 */
const UNCLASSIFIED_COOLDOWN_MS = resolveAccountUnclassifiedCooldownMs;
/**
 * xAI Grok Build's free tier resets on a rolling 24-hour window, so its
 * exhaustion is a full-day quota cooldown — never the generic 1h fallback,
 * which let the account re-enter rotation inside the window.
 */
const GROK_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * The buddy family's policy/channel block (`11140`, `11128`) is a *base* backoff,
 * not a flat penalty — see {@link resolveAccountPolicyBlockCooldownMs}. It used
 * to be two constants, 24h for the content block and 6h for the channel one,
 * both applied on the first observation. That was wrong in the direction that
 * costs most: `11140` is also what a wrong desktop `User-Agent` brand answers
 * (`workbuddy/shared.ts`), so after we fixed a header regression every buddy
 * account stayed dead for up to a further day, and one prompt that failed a
 * safety review cost a whole account a day. As a base it escalates through the
 * consecutive-failure ladder, which tells the two causes apart by what they do
 * next — a genuinely blocked account is refused again immediately and parks
 * itself within minutes.
 */
/**
 * Backoff for a model the upstream says does not exist for this account
 * (Cursor answers Connect `not_found` for a model the credential's plan does
 * not reach). Long, because the verdict is a property of the plan and will not
 * change on the next request — but bounded, so a plan upgrade is picked up
 * without an operator clearing it by hand.
 */
const MODEL_UNREACHABLE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/**
 * Backoff for a model the upstream does not serve at all (buddy family
 * business code `11102` — `service info not found` — or a `model ... not
 * found/supported` message). Mirrors the reference gateways'
 * `MODEL_SITE_BLOCK_S` → `MODEL_SITE_BLOCK_MAX_S`.
 *
 * Escalating rather than flat: the pair is re-dialled after the first window
 * and answers the same thing, so a flat 6h let a permanently unsupported model
 * consume a request every six hours forever. The ladder tops out at a day,
 * which is long enough to stop the redial and short enough that a backend that
 * starts serving the model is picked up without an operator clearing it.
 *
 * This is the one place the references' *strict* behaviour is adopted as a
 * backoff rather than as a 400: nothing currently succeeds through it, so no
 * client is broken by it.
 */
const UNSUPPORTED_MODEL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const UNSUPPORTED_MODEL_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
/** How many doublings an unsupported-model cooldown may take before the cap. */
const UNSUPPORTED_MODEL_MAX_LEVEL = 8;

/**
 * The cooldown for the *nth* consecutive unsupported-model report (`hits` is
 * the new total, so the first report is `hits === 1`).
 *
 * Exported because the writer, not the classifier, is the only place that
 * reads the authoritative hit count — the classifier sees only the count the
 * caller supplied, which is absent on the first report of a pair.
 */
export function unsupportedModelCooldownMs(hits: number): number {
  const level = Math.min(Math.max(0, Math.round(hits) - 1), UNSUPPORTED_MODEL_MAX_LEVEL);
  return Math.min(
    UNSUPPORTED_MODEL_COOLDOWN_MS * 2 ** level,
    UNSUPPORTED_MODEL_COOLDOWN_MAX_MS,
  );
}

/**
 * The wording an upstream uses for "we do not serve this model at all", as
 * opposed to "this account cannot reach it" (403 entitlement, above) or "this
 * route does not exist" (404 `upstream_not_found`).
 */
const UNSUPPORTED_MODEL_MESSAGE =
  /service info not found|model\s.{0,80}?\bnot\s+(?:found|supported)\b/;

/**
 * True when the evidence says the upstream does not serve the model.
 *
 * Narrow on purpose, and narrower than `model_unreachable`: only a 400/404
 * carrying the buddy family's `11102` or one of the two phrasings above. A
 * 4xx that merely *mentions* a model is far more often a payload the caller
 * got wrong, and cooling a pair for six hours over that takes a working model
 * out of rotation for a request bug.
 */
function isUnsupportedModelEvidence(
  statusCode: number | null,
  providerCode: string,
  lower: string,
): boolean {
  if (statusCode !== 400 && statusCode !== 404) return false;
  return providerCode === "11102" || UNSUPPORTED_MODEL_MESSAGE.test(lower);
}

// ===== health/account-recorder.ts =====
export interface AccountHealthEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly modelId: string | null;
  readonly createdAt: string;
}

export type AccountErrorCategory =
  | "quota_exhausted"
  | "rate_limit_transient"
  | "model_capacity"
  | "model_unreachable"
  | "auth_invalidated"
  | "policy_blocked"
  | "server_error"
  | "timeout"
  | "unknown";
export type AccountFailureOrigin = "cartethyia" | "upstream" | "network";
export type AccountFailureScope =
  | "account"
  | "provider"
  | "model"
  | "pool"
  | "tenant"
  | "request"
  | "network"
  | "unknown";

export interface AccountFailureEvidence {
  readonly origin?: AccountFailureOrigin;
  readonly scope?: AccountFailureScope;
  readonly credentialKind?: string;
  /**
   * The account's credential is a static bearer token used as issued and never
   * refreshed. An auth rejection against a static token is not a refreshable
   * fault: refreshing cannot help, and disabling the account discards a token
   * that may still be valid for other requests. Such a failure cools the
   * account down instead of parking it.
   */
  readonly staticToken?: boolean;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number | null;
  readonly headers?: Headers | Record<string, string> | null;
  readonly modelId?: string;
  /**
   * Provider that produced the failure. Used only for the one
   * provider-family-specific policy rule (the buddy family's `11140`
   * content-policy block), never to broaden what disables an account.
   */
  readonly providerId?: string;
  /**
   * How many times this (account, model) pair has already been reported
   * unsupported, when the caller has read them. Best-effort: the classifier
   * states the base window without it, and the writer recomputes against the
   * count it reads itself.
   */
  readonly modelBlockHits?: number;
  /**
   * The upstream's own error body, when the caller has it.
   *
   * Providers state a reset window in structured fields far more reliably than
   * in prose — a body carrying `resets_at`, `resets_in_seconds` or
   * `limit_window_minutes` is an exact statement, while the same body's
   * `message` ("The usage limit has been reached") names no window at all.
   * Without this the classifier falls back to a fixed 15-minute cooldown for a
   * limit the provider said resets in 23 days.
   */
  readonly upstreamBody?: unknown;
}

export interface AccountErrorClassification {
  readonly category: AccountErrorCategory;
  readonly status: "cooldown" | "disabled";
  readonly cooldownMs: number;
  readonly reason: string;
  readonly retryAt: Date | null;
  readonly mutatesAccount: boolean;
  /**
   * True when this write changed a field the routing snapshot actually reads.
   *
   * The snapshot projects `provider_accounts.status` and
   * `.cooldownUntil` and nothing else (`route-catalog.ts:286-287`), so only a
   * write that moves one of those has to drop it. Everything else a failure
   * persists — the failure streak, the error text, the category, a
   * model-scoped cooldown — is invisible to routing, and invalidating for it
   * forced the next request to rebuild an 11-SELECT snapshot for no reason.
   *
   * That made a failure wave self-sustaining: N failed attempts produced N
   * invalidations, and every following request paid the full rebuild.
   */
  readonly routesVisible: boolean;
  /**
   * True when `cooldownMs` came from the provider's own statement — a parsed
   * `Retry-After`-family header, or a reset quoted in its message — rather than
   * from one of this module's fallback constants.
   *
   * A property of the *evidence*, not of the category, so it is the same for
   * every branch of one classification. Only {@link escalateFallbackCooldown}
   * reads it: a provider-stated window is the truth and is never multiplied.
   */
  readonly providerStated?: boolean;
  /**
   * True when the upstream reported the model as one it does not serve (the
   * buddy family's `11102`), rather than one this account merely cannot reach.
   *
   * A property of the classification, because both verdicts land in the same
   * `model_unreachable` category and the writer cannot otherwise tell them
   * apart — it needs to know whether to count the hit and escalate the window.
   */
  readonly modelUnsupported?: boolean;
}

/**
 * How many doublings a fallback cooldown may take before the cap takes over.
 *
 * Four is enough to reach the cap from every fallback default (the longest is
 * the 1h quota fallback, which reaches it on the first doubling) while keeping
 * the ladder short enough to reason about.
 */
const COOLDOWN_ESCALATION_MAX_LEVEL = 4;

/**
 * Escalates a *fallback* cooldown for an account that keeps failing.
 *
 * `consecutiveFailures` has been incremented on every account failure since the
 * health machine was written, but nothing ever read it — so a broken upstream
 * was re-dialled once a minute forever, and an account whose quota had an
 * unstated reset came straight back into rotation every time its short fallback
 * lapsed. The count is now a backoff level: each further consecutive failure
 * doubles the fallback, clamped to {@link resolveAccountCooldownEscalationMaxMs}.
 *
 * Two guards keep it from overriding the provider. A duration the provider
 * *stated* is never multiplied — that window is the truth. And the caller writes
 * the result through a monotonic maximum, so a burst of concurrent in-flight
 * failures advances the deadline to the longest of them instead of compounding
 * once per failure.
 */
function escalateFallbackCooldown(
  cooldownMs: number,
  providerStated: boolean,
  consecutiveFailures: number,
): number {
  if (providerStated || cooldownMs <= 0) return cooldownMs;
  const level = Math.min(Math.max(0, consecutiveFailures), COOLDOWN_ESCALATION_MAX_LEVEL);
  return Math.min(cooldownMs * 2 ** level, resolveAccountCooldownEscalationMaxMs());
}

/**
 * The later of a candidate deadline and the one already recorded.
 *
 * Every fallback duration is recomputed from *now* on each failure, so writing
 * it unconditionally let a fresh short failure *shorten* a longer window already
 * in force: a 60-second unclassified cooldown overwrote the provider's own
 * "Try again in 11h" and released the pair back into rotation inside a window
 * the upstream had closed, where it failed again — once a minute, forever.
 * A cooling deadline may only ever move later.
 */
function latestDeadlineMs(...candidates: readonly (number | undefined | null)[]): number {
  let latest = 0;
  for (const value of candidates) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value > latest) latest = value;
  }
  return latest;
}

/**
 * The account-wide deadline to write, or `null` for "no deadline".
 *
 * {@link latestDeadlineMs} cannot express *no* deadline — it floors at 0 — and
 * the account-wide write has one state that needs it. With
 * `CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS=0` an automatic disable is meant to
 * be terminal again, and the classifier correctly reports `retryAt: null`.
 * Deriving the deadline from `Date.now() + cooldownMs` instead stamps *now*.
 * The recovery sweep then treats that elapsed deadline as
 * an automatic disable awaiting recovery and returns the row to rotation on its
 * next tick — the escape hatch enabled exactly the behavior it documents
 * itself as disabling.
 *
 * A candidate only exists when there is a real window to state. Monotonicity is
 * preserved: a deadline already in force still wins over a new `null`.
 */
function accountDeadlineMs(
  candidates: readonly (number | undefined | null)[],
): Date | null {
  const latest = latestDeadlineMs(...candidates);
  return latest > 0 ? new Date(latest) : null;
}

/**
 * Bounded to a day, matching `MAX_COOLDOWN_MS` in the failure policy: a stated
 * window longer than that is a monthly or plan-level limit, and parking an
 * account for a month on one upstream field is a decision for the operator,
 * not an automatic one.
 */
const MAX_UPSTREAM_STATED_COOLDOWN_MS = 24 * 3600 * 1000;

/** Parses the stored upstream text as JSON. Returns `undefined` when it is not. */
function tryParseUpstreamBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a reset window the upstream stated in structured fields.
 *
 * A body like `{"error":{"type":"usage_limit_reached","resets_at":1795019113,
 * "resets_in_seconds":2072028}}` states the window exactly, while its own
 * `message` ("The usage limit has been reached") states none — so parsing only
 * prose leaves a 23-day limit cooling for the 15-minute fallback, and the
 * account re-enters rotation hours before it can serve.
 *
 * Both spellings are read because providers use both: an absolute epoch
 * (`resets_at`, seconds or milliseconds) and a relative delay
 * (`resets_in_seconds`). The later of the two wins, since they are the same
 * claim computed at slightly different instants.
 */
function parseUpstreamBodyReset(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  // Some providers nest under `error`, some return it at the top level.
  const candidates = [record, (record["error"] as Record<string, unknown> | undefined) ?? undefined];
  let best: number | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const now = Date.now();

    const absolute = candidate["resets_at"] ?? candidate["reset_at"];
    if (typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0) {
      // Seconds vs milliseconds: a plausible epoch in seconds is ~10 digits, in
      // milliseconds ~13, and the two are four orders of magnitude apart — so
      // the smaller is scaled up rather than guessed from a threshold date.
      const epochMs = absolute < 1e11 ? absolute * 1000 : absolute;
      const delay = epochMs - now;
      if (delay > 0) best = best === null ? delay : Math.max(best, delay);
    }

    const relative =
      candidate["resets_in_seconds"] ??
      candidate["reset_in_seconds"] ??
      candidate["retry_after_seconds"];
    if (typeof relative === "number" && Number.isFinite(relative) && relative > 0) {
      const delay = relative * 1000;
      best = best === null ? delay : Math.max(best, delay);
    }

    const minutes = candidate["limit_window_minutes"] ?? candidate["reset_in_minutes"];
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
      const delay = minutes * 60_000;
      best = best === null ? delay : Math.max(best, delay);
    }
  }
  return best === null ? null : Math.min(MAX_UPSTREAM_STATED_COOLDOWN_MS, Math.round(best));
}


interface AccountErrorContext {
  readonly message: string;
  readonly lower: string;
  readonly folded: string;
  readonly statusCode: number | null;
  readonly origin: AccountFailureOrigin;
  readonly scope: AccountFailureScope;
  readonly revocationNamed: boolean;
  readonly accountEvidence: boolean;
  readonly canMutate: boolean;
  readonly providerCode: string;
  readonly statedCooldownMs: number | null;
  readonly reason: (prefix: string) => string;
  readonly result: (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount?: boolean,
    modelUnsupported?: boolean,
  ) => AccountErrorClassification;
}

/**
 * One arm of the classifier: an ordered `(match, decide)` pair.
 *
 * The arms are **not** independent predicates. Later arms are deliberately
 * broader than earlier ones — `quotaSignal` matches every price refusal, and
 * `authSignal` matches a superset of the request-scoped codes — so a match
 * only wins because it is tried first. That is why they live in one ordered
 * list rather than behind a dispatch map or a set of independent `if`s: the
 * list is the precedence, and reading it top to bottom is reading the
 * decision.
 *
 * `match` is a pure function of the shared signals (no closure over the
 * classifier's locals, no allocation per classification): the table is built
 * once per call from values already computed for every arm.
 */
interface AccountErrorRule {
  readonly name: string;
  readonly match: (signals: AccountErrorSignals) => boolean;
  readonly decide: (signals: AccountErrorSignals) => AccountErrorClassification;
}

/** The shared signals every arm reads, computed once per classification. */
interface AccountErrorSignals {
  readonly message: string;
  readonly lower: string;
  readonly folded: string;
  readonly statusCode: number | null;
  readonly origin: AccountFailureOrigin;
  readonly scope: AccountFailureScope;
  readonly providerCode: string;
  readonly statedCooldownMs: number | null;
  readonly reason: (prefix: string) => string;
  readonly result: AccountErrorContext["result"];
  readonly canMutate: boolean;
  readonly accountEvidence: boolean;
  readonly revocationNamed: boolean;
  /** Echo of the caller's evidence; read only by the arms that need it. */
  readonly modelId: string | undefined;
  readonly modelBlockHits: number;
  readonly staticToken: boolean;
  readonly credentialKind: string | undefined;
  /** Buddy-family provider: the only family with provider-specific codes below. */
  readonly buddy: boolean;
  readonly priceRefusal: boolean;
  readonly deploymentInfraError: boolean;
  readonly quotaSignal: boolean;
  readonly policyRejection: boolean;
  readonly requestScoped: boolean;
  readonly channelRejection: boolean;
  readonly hostedToolFailure: boolean;
  readonly modelEntitlementFailure: boolean;
  readonly queuedUpstream: boolean;
}

/** Build the request-independent evidence consumed by the ordered classifier. */
function accountErrorContext(error: unknown, options?: AccountFailureEvidence): AccountErrorContext {
  const errorRecord = isRecord(error) ? error : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof errorRecord?.message === "string"
          ? errorRecord.message
          : String(error ?? "Unknown error");
  const lower = message.toLowerCase();
  const statusCode =
    options?.statusCode ??
    (typeof errorRecord?.status === "number" ? errorRecord.status : null);
  const origin = options?.origin ?? "cartethyia";
  const scope = options?.scope ?? "unknown";
  // Providers write the same phrase with different separators: codex reports
  // `token_revoked`, others `token revoked` or `token-revoked`. Folding the
  // separators once lets every match below see one spelling.
  const folded = lower.replace(/[_-]+/g, " ");
  // A revocation named in the message is evidence about the credential itself,
  // whichever scope the caller could establish. A stream error frame carries
  // no `credentialEvidence` detail and classifies at provider scope, so without
  // this the account stays in rotation: the phrase is recognised and then
  // discarded because nothing mutates on provider scope.
  const revocationNamed = folded.includes("token revoked") || folded.includes("invalidated oauth token");
  const accountEvidence =
    options?.credentialEvidence === true ||
    revocationNamed ||
    (options?.origin === "upstream" && options.scope === "account");
  // A named revocation mutates even at provider scope: the message is the
  // evidence, and provider scope is what a frame with no credential detail
  // classifies as. Every other signal still needs account scope.
  const canMutate = origin === "upstream" && (revocationNamed || (scope === "account" && accountEvidence));
  const providerCode = options?.providerCode?.toLowerCase() ?? "";

  const getHeader = (name: string): string | null => {
    const headers = options?.headers;
    if (!headers) return null;
    if ("get" in headers && typeof headers.get === "function") return headers.get(name);
    const wanted = name.toLowerCase();
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1] ?? null;
  };

  const headerCooldown =
    options?.retryAfterMs ??
    parseUpstreamBackoff({ get: getHeader });
  const messageCooldown = parseProviderResetDuration(message);
  const rawUpstreamResponse =
    origin === "upstream" &&
    error instanceof GatewayError &&
    typeof error.details.raw === "string"
      ? error.details.raw
      : undefined;
  // The body's own fields, when they can be reached. Checked alongside the
  // header and the prose rather than instead of them: a provider may state the
  // window in any of the three, and the longest honest statement wins.
  //
  // `details.raw` is tried even when no caller passed a parsed body, because
  // that is where the upstream's JSON actually reaches this function — the
  // dispatch path stores the response text there. A structured window read from
  // it is the difference between a 15-minute fallback and the 23 days the
  // provider stated.
  const bodyCooldown =
    parseUpstreamBodyReset(options?.upstreamBody) ??
    (rawUpstreamResponse === undefined ? null : parseUpstreamBodyReset(tryParseUpstreamBody(rawUpstreamResponse)));
  // Whether the provider itself named a window. Decided once, from the
  // evidence, so every branch of this classification agrees about it.
  const providerStated =
    headerCooldown !== null || messageCooldown !== null || bodyCooldown !== null;
  const statedCooldownMs =
    [headerCooldown, messageCooldown, bodyCooldown].reduce<number | null>(
      (best, value) => (value === null ? best : best === null ? value : Math.max(best, value)),
      null,
    );
  const reason = (prefix: string): string => `${prefix}: ${message.slice(0, 160)}`;
  const result = (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount = canMutate,
    modelUnsupported = false,
  ): AccountErrorClassification => ({
    category,
    status,
    cooldownMs,
    reason: origin === "upstream" ? rawUpstreamResponse ?? message.slice(0, 160) : explanation,
    retryAt,
    mutatesAccount,
    // Set below by the caller that knows which columns it wrote, not here:
    // the same classification feeds both the account-wide path (status +
    // cooldownUntil — routing-visible) and the model-scoped path (neither —
    // invisible). Defaulting true keeps existing callers conservative.
    routesVisible: true,
    providerStated,
    modelUnsupported,
  });

  return {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    revocationNamed,
    accountEvidence,
    canMutate,
    providerCode,
    statedCooldownMs,
    reason,
    result,
  };
}

export function classifyAccountError(
  error: unknown,
  options?: AccountFailureEvidence,
): AccountErrorClassification {
  const {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    revocationNamed,
    accountEvidence,
    canMutate,
    providerCode,

    statedCooldownMs,
    reason,
    result,
  } = accountErrorContext(error, options);
  const modelId = options?.modelId;
  const modelBlockHits = Math.max(1, Math.floor(options?.modelBlockHits ?? 1));
  const staticToken = options?.staticToken === true;
  const credentialKind = options?.credentialKind;
  const buddy = BUDDY_PROVIDER_IDS.has(options?.providerId?.toLowerCase() ?? "");

  // A price refusal is a verdict on the *request*, not on the account. inferhub
  // answers 402 with `no provider's ask matches your max-per-mtok bid`: the
  // caller's own price ceiling was below every upstream ask, which says nothing
  // about the credential or its balance. Classified as quota it cooled a
  // fully-credited account down for an hour and the operator reported it as
  // "blocked, unusable at all". Detected before the quota branch and recorded
  // without mutating the account, so only that request fails.
  const priceRefusal =
    lower.includes("max-per-mtok") ||
    lower.includes("no provider's ask") ||
    (lower.includes("ask") && lower.includes("bid"));
  // Deployment/proxy infrastructure errors (DEPLOYMENT_DISABLED, etc.) are
  // transport-level proxy pool failures, not account quota exhaustion.
  // Mutating the account parks it for an hour while the pool itself stays
  // healthy — the next request picks the same dying pool and the same error
  // repeats. These must not cooldown the account.
  const deploymentInfraError =
    lower.includes("deployment_disabled") ||
    lower.includes("deployment disabled") ||
    (lower.includes("sin1::") && lower.includes("deployment"));
  if (deploymentInfraError) {
    return result("server_error", "cooldown", 60_000, null, `Proxy deployment error: ${message.slice(0, 160)}`, false);
  }
  // A (CodeBuddy/WorkBuddy) *frequency* window is a verdict on one
  // (account, model) pair, not on the account: `{"code":"6004","msg":"usage
  // exceeds frequency limit ... your usage will reset at <stamp> UTC+8,
  // alternatively, you can switch to the other models to continue using it."}`.
  // The provider names the remedy itself — use a different model — which is
  // only a remedy if the account still serves every other model. Taken as
  // account-wide `quota_exhausted` it parked the whole account until the reset,
  // so the switch the upstream offered was refused by our own gateway and every
  // sibling model went dark with it; the account also read COOLDOWN /
  // quota_exhausted while only that pair was throttled.
  //
  // Classified `rate_limit_transient` so the writer scopes it to the model:
  // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
  // account's own status alone. Kept ahead of `quotaSignal`, which matches a
  // *broader* slice of the same wording (`usage exceeds` + `frequency limit`)
  // and would otherwise claim this message as an account-wide quota window.
  // Narrow on purpose — the extra phrase is what says the other models still
  // work; without it the failure stays account-wide.
  const modelFrequencyWindow =
    lower.includes("frequency limit") && lower.includes("switch to the other models");
  if (modelFrequencyWindow) {
    const cooldownMs = statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS();
    return result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      reason("Provider frequency limit for this model"),
      // Provider-scoped evidence still has to reach the writer: a stream frame
      // carries no credential detail, so `canMutate` is false and without this
      // the pair would be retried for the whole window it was closed for.
      origin === "upstream" && scope === "provider",
    );
  }

  // Quota-shaped provider codes/messages (e.g. xAI's
  const quotaSignal =
    !priceRefusal &&
    !deploymentInfraError &&
    (statusCode === 402 ||
      // Qoder answers an exhausted credit balance with
      // `{"code":"112","message":"{\"pricingUrl\":...}"}` — the body points at
      // the pricing page, i.e. "buy more", which is a balance verdict, not an
      // auth one. It fell through to `auth_invalidated` and the console showed
      // "Re-login required" on an account whose credential was fine, sending
      // operators to re-authenticate instead of topping up.
      // Recognising it here keeps it out of `auth_invalidated`; the branch
      // below scopes the resulting cooldown to the model, because the account
      // keeps serving its other models.
      providerCode === "112" ||
      providerCode === "insufficient_quota" ||
      providerCode === "quota_exceeded" ||
      providerCode === "subscription:free-usage-exhausted" ||
      providerCode === "14018" ||
      // CodeBuddy/WorkBuddy rate limit: `{"code":"6004","msg":"usage exceeds
      // frequency limit ... your usage will reset at <stamp> UTC+8"}`. The
      // message names a reset, so this is a parked window, not a transient
      // 429 — without it the account fell through to `unknown` with
      // `mutates=false`, stayed in rotation, and was re-picked for every
      // request inside the window the provider had actually named.
      //
      // Matched on the message's own wording, not on the `6004` code: that code
      // is not unique to this surface (the artifact-release API reuses it), so a
      // code match would sweep an unrelated failure into a quota cooldown. The
      // phrase is the reliable key, and `usage exceeds` + `frequency limit` is
      // the pair this family actually prints.
      (lower.includes("usage exceeds") && lower.includes("frequency limit")) ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota_exceeded") ||
      lower.includes("usage_limit_reached") ||
      lower.includes("usage-exhausted") ||
      lower.includes("usage_exhausted") ||
      lower.includes("usage exhausted") ||
      lower.includes("usage exceeds") ||
      lower.includes("frequency limit") ||
      lower.includes("free-usage") ||
      lower.includes("free usage") ||
      lower.includes("exceeded your current quota") ||
      // Trae answers an exhausted quota with **HTTP 502** and the body `Your
      // requests have exceeded the quota.` The status is what misled the
      // classifier: 502 read as a gateway failure, so this fell through to
      // `server_error` — a 30s cooldown that does not mutate the account, so
      // the account stayed in rotation and every other model on it kept being
      // invoked inside a window the provider had already closed. The body is
      // the verdict; the 502 is incidental. Matched on the phrase, not on the
      // status, which is why this sits in `quotaSignal` ahead of the 5xx arm.
      lower.includes("have exceeded the quota") ||
      lower.includes("balance exhausted") ||
      lower.includes("insufficient balance") ||
      lower.includes("out of credits") ||
      lower.includes("credits exhausted") ||
      lower.includes("spending limit") ||
      // Same Qoder family reached by body text when the code is not parsed out.
      (lower.includes("pricingurl") && lower.includes("qoder.com/pricing")));
  // A deterministic content-policy rejection is NOT credential invalidation.
  // CodeBuddy returns HTTP 403 with provider code 11140 ("request illegal",
  // "did not pass the safety review") — refreshing the token cannot change
  // that outcome and the account itself is healthy, so it must never flip the
  // account to auth_invalidated/disabled. Only real auth signals do.
  const policyRejection =
    providerCode === "11140" ||
    lower.includes("safety review") ||
    lower.includes("content did not pass") ||
    lower.includes("request illegal") ||
    lower.includes("content blocked") ||
    lower.includes("account suspended");
  const policyBlock =
    policyRejection &&
    options?.providerId !== undefined &&
    BUDDY_PROVIDER_IDS.has(options.providerId.toLowerCase());
  if (policyBlock) {
    const policyBlockMs = resolveAccountPolicyBlockCooldownMs();
    return result(
      "policy_blocked",
      "cooldown",
      policyBlockMs,
      new Date(Date.now() + policyBlockMs),
      reason("Provider content-policy block"),
      origin === "upstream",
    );
  }
  // These codes are a verdict on the request, not the account. Cooling the
  // account for them burns a healthy credential on a body that will fail the
  // same way on every other account:
  //
  // - `11148` tool-call/result mismatch — the transcript is broken; the
  //   pre-payload repair is supposed to prevent it, and a slip is still the
  //   body's fault.
  // - `11135` the image cannot be processed, `11133` the model rejected a
  //   parameter, `11101` the body failed to parse — deterministic for that
  //   payload.
  // - `12153` the session is dead — a refresh problem, not a reason to park
  //   the account on the first observation.
  // - `14017` trial not activated — the account may recover once registration
  //   finishes, so a hard cooldown would keep it out after it becomes usable.
  //
  // Recognised before the auth and quota branches: several of these arrive as
  // 401/403/429, which those branches would otherwise treat as account evidence.
  const requestScoped =
    providerCode === "11148" ||
    providerCode === "11135" ||
    providerCode === "11133" ||
    providerCode === "11101" ||
    providerCode === "12153" ||
    providerCode === "14017" ||
    lower.includes("tool_call_sequence_broken") ||
    lower.includes("unmarshal chat params failed") ||
    lower.includes("invalid image_url content") ||
    lower.includes("offline user session not found") ||
    lower.includes("trial not activated") ||
    lower.includes("trial version is not yet activated");
  if (requestScoped && BUDDY_PROVIDER_IDS.has(options?.providerId?.toLowerCase() ?? "")) {
    return result(
      "unknown",
      "cooldown",
      0,
      null,
      reason("Request-scoped upstream rejection"),
      false,
    );
  }
  // A channel rejection (`11128`) is the same shape: the upstream is refusing
  // the caller for this account, not this particular prompt, and it keeps
  // refusing on every invocation. Classifying it as `unknown` with
  // `mutates=false` would leave the account in rotation failing every request —
  // and since every account fails the same way, the whole pool looks dead with
  // nothing ever parked.
  const channelRejection =
    providerCode === "11128" || lower.includes("unapproved channel");
  const channelBlock =
    channelRejection &&
    options?.providerId !== undefined &&
    BUDDY_PROVIDER_IDS.has(options.providerId.toLowerCase());
  if (channelBlock) {
    const channelBlockMs = resolveAccountPolicyBlockCooldownMs();
    return result(
      "policy_blocked",
      "cooldown",
      channelBlockMs,
      new Date(Date.now() + channelBlockMs),
      reason("Provider channel rejection"),
      origin === "upstream",
    );
  }
  // server-side tool (web search, x search, web fetch), not evidence about the
  // credential or the account's quota. Some providers surface it as 403, which
  // would otherwise look like an auth signal — refreshing the token cannot fix
  // a search backend, so it must never disable the account.
  const hostedToolFailure =
    lower.includes("web_search") ||
    lower.includes("web search") ||
    lower.includes("web_search_preview") ||
    lower.includes("x_search") ||
    lower.includes("web_fetch") ||
    lower.includes("tool invocation") ||
    lower.includes("tool call failed") ||
    lower.includes("search backend");
  // A model-scoped license or entitlement rejection is NOT credential invalidation.
  // Google Cloud Code / Antigravity answers HTTP 403 with "You do not have a valid
  // license of this product" when an account lacks entitlement for one specific model
  // (e.g. claude-opus-4-6), while the account itself and its tokens remain fully valid
  // for all other models. Disabling the whole account breaks healthy models.
  const modelEntitlementFailure =
    statusCode === 403 &&
    (lower.includes("not have a valid license") ||
      lower.includes("valid license of this product") ||
      lower.includes("model not supported") ||
      lower.includes("not entitled to") ||
      lower.includes("no access to model") ||
      lower.includes("model_not_supported") ||
      lower.includes("not available in your region"));
  /**
   * The upstream accepted the request and put it in a queue behind other
   * callers — it is busy, not rejecting the caller's credential.
   *
   * Qoder answers `403 {"code":"10605","message":"{\"isQueued\":true,
   * \"modelKey\":\"dfmodel\",\"queueCount\":1395,...}"}`. The 403 is what made
   * this misclassify: the generic `(401 || 403) && accountEvidence` arm claimed
   * it as `auth_invalidated`, so a healthy account was parked as "Re-login
   * required" purely because the provider was busy, and an operator was sent
   * to re-authenticate a credential that was never rejected.
   *
   * Matched on the queue evidence rather than on the bare `10605`, so an
   * unrelated 403 that happens to share the code is not swept in. The bodies
   * are nested JSON, so the tell is the key, not a parse of the envelope.
   */
  const queuedUpstream =
    providerCode === "10605" ||
    lower.includes("isqueued") ||
    lower.includes("queuecount") ||
    lower.includes("queuetype") ||
    (lower.includes("queue") && lower.includes("modelkey"));

  const signals: AccountErrorSignals = {
    message,
    lower,
    folded,
    statusCode,
    origin,
    scope,
    providerCode,
    statedCooldownMs,
    reason,
    result,
    canMutate,
    accountEvidence,
    revocationNamed,
    modelId,
    modelBlockHits,
    staticToken,
    credentialKind,
    buddy,
    priceRefusal,
    deploymentInfraError,
    quotaSignal,
    policyRejection,
    requestScoped,
    channelRejection,
    hostedToolFailure,
    modelEntitlementFailure,
    queuedUpstream,
  };

  for (const rule of ACCOUNT_ERROR_RULES) {
    if (rule.match(signals)) return rule.decide(signals);
  }

  // Same reasoning as above, with the shortest backoff: an unmapped failure
  // must still be retried automatically rather than parked forever.
  const unclassifiedMs = UNCLASSIFIED_COOLDOWN_MS();
  return result(
    "unknown",
    "cooldown",
    unclassifiedMs,
    new Date(Date.now() + unclassifiedMs),
    reason("Unclassified provider failure"),
    false,
  );
}

/**
 * The ordered arms of {@link classifyAccountError}, tried top to bottom; the
 * first match decides. Order is behavior, not presentation — see
 * {@link AccountErrorRule}.
 */
const ACCOUNT_ERROR_RULES: readonly AccountErrorRule[] = [
  {
    // Must precede "rate-limit": this rejection is a 429 whose own text says
    // "rate limit", so the broader arm claimed it and cooled the account for
    // the full 15-minute rate-limit window.
    //
    // A full max-inflight is a statement about the gateway's own routing, not
    // about the credential: every account serving the model is busy right now.
    // Cooling them marks healthy accounts as `cooldown` for a limit their
    // provider never applied, which is what made every account read busy while
    // incoming requests piled up — the accounts were never the problem, the
    // ceiling was.
    name: "gateway-capacity-exhausted",
    match: (s) =>
      s.lower.includes("at its concurrency limit") ||
      s.lower.includes("every proxy pool for this provider is at its concurrency limit") ||
      s.lower.includes("the gateway is at its concurrency limit"),
    decide: (s) =>
      s.result(
        "model_capacity",
        // `status` is the status the account would move to; it is never
        // applied because `mutatesAccount` is false below, so this names the
        // shape rather than a transition. Zero cooldown is the point: no wait
        // is attached to the account, so the next request may use it at once.
        "cooldown",
        0,
        null,
        s.reason("Gateway concurrency ceiling reached; no account was at fault"),
        // Never mutates: there is nothing wrong with the account to record.
        false,
      ),
  },
  {
    name: "deployment-infrastructure",
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
  },
  {
    name: "model-frequency-window",
    match: (s) => s.lower.includes("frequency limit") && s.lower.includes("switch to the other models"),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS();
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
  },
  {
    name: "content-policy-block",
    match: (s) => s.policyRejection && s.buddy,
    decide: (s) => {
      const policyBlockMs = resolveAccountPolicyBlockCooldownMs();
      return s.result(
        "policy_blocked",
        "cooldown",
        policyBlockMs,
        new Date(Date.now() + policyBlockMs),
        s.reason("Provider content-policy block"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "request-scoped-rejection",
    match: (s) => s.requestScoped && s.buddy,
    decide: (s) =>
      s.result("unknown", "cooldown", 0, null, s.reason("Request-scoped upstream rejection"), false),
  },
  {
    name: "channel-rejection",
    match: (s) => s.channelRejection && s.buddy,
    decide: (s) => {
      const channelBlockMs = resolveAccountPolicyBlockCooldownMs();
      return s.result(
        "policy_blocked",
        "cooldown",
        channelBlockMs,
        new Date(Date.now() + channelBlockMs),
        s.reason("Provider channel rejection"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "credential-rejected",
    match: (s) =>
      !s.quotaSignal &&
      !s.policyRejection &&
      !s.hostedToolFailure &&
      !s.modelEntitlementFailure &&
      !s.queuedUpstream &&
      (s.providerCode === "authentication_failed" ||
        s.folded.includes("invalid api key") ||
        s.folded.includes("incorrect api key") ||
        s.folded.includes("invalid token") ||
        s.folded.includes("token revoked") ||
        s.folded.includes("invalidated oauth token") ||
        s.folded.includes("reauthorization required") ||
        s.folded.includes("account deactivated") ||
        ((s.statusCode === 401 || s.statusCode === 403) && s.accountEvidence)),
    decide: (s) => {
      // A static token has no refresh to run, so an auth rejection must not park
      // the account: disabling it throws away a token that may still work (a
      // single upstream 401 can be transient). A cooldown lets the next attempt
      // retry the same token without losing the account.
      const oauthRecovery =
        !s.staticToken &&
        s.credentialKind === "oauth" &&
        (s.lower.includes("expired") || s.lower.includes("refresh"));
      // A *named* revocation is the one auth outcome that still parks the account.
      // The upstream said the credential itself is dead — not that it expired, not
      // that this request was refused — so there is no window to wait out and no
      // refresh to run, and a cooldown would only return it to rotation to fail
      // again. Every other auth rejection is weak evidence (clock skew, a key
      // rotated a moment ago, an edge answering before the credential loads) and
      // cools down instead.
      //
      // This distinction is the whole fix. Reaching `disabled` from the generic
      // `401`/`403` branch would be unrecoverable by any sweep, so one transient
      // rejection would remove the account from rotation until an operator
      // noticed — the exact outcome the comment above says a static token must
      // not suffer.
      const revoked = s.revocationNamed;
      const recoverable = s.staticToken || oauthRecovery || !revoked;
      // An automatic disable is **not** terminal any more, but the deadline is what
      // makes that safe: `sweepExpiredCooldowns` recovers a disabled row only when
      // its `cooldownUntil` has elapsed, and an operator-disabled row keeps that
      // column null. So the machine can undo its own verdict while an operator's
      // decision still outranks it — see `resolveAccountDisabledRecoveryMs`.
      const disabledRecoveryMs = resolveAccountDisabledRecoveryMs();
      const disabledRetryAt =
        disabledRecoveryMs > 0 ? new Date(Date.now() + disabledRecoveryMs) : null;
      const cooldownMs = recoverable ? resolveAccountAuthRejectedCooldownMs() : disabledRecoveryMs;
      return s.result(
        "auth_invalidated",
        recoverable ? "cooldown" : "disabled",
        cooldownMs,
        recoverable ? new Date(Date.now() + cooldownMs) : disabledRetryAt,
        s.reason(
          !revoked
            ? "Provider credential rejected; retrying after a backoff"
            : s.staticToken
              ? "Static token rejected; retrying without a refresh"
              : oauthRecovery
                ? "OAuth credential requires refresh"
                : "Provider credential revoked",
        ),
        s.canMutate,
      );
    },
  },
  {
    name: "price-refusal",
    match: (s) => s.priceRefusal,
    decide: (s) =>
      s.result("quota_exhausted", "cooldown", 0, null, s.reason("Request price refused by the provider"), false),
  },
  {
    name: "model-plan-gated",
    match: (s) => s.quotaSignal && s.providerCode === "112",
    decide: (s) => {
      const cooldownMs = unsupportedModelCooldownMs(s.modelBlockHits);
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model not included in this account's plan"),
        s.origin === "upstream" && s.modelId !== undefined,
        true,
      );
    },
  },
  {
    name: "quota-exhausted",
    match: (s) => s.quotaSignal,
    decide: (s) => {
      // xAI Grok Build's free tier resets on a rolling window. Use a duration
      // stated by the provider when present; otherwise park for the conservative
      // 24-hour fallback.
      const grokFreeTier =
        s.providerCode === "subscription:free-usage-exhausted" ||
        s.providerCode.startsWith("subscription:") ||
        s.lower.includes("free-usage") ||
        s.lower.includes("free usage") ||
        s.lower.includes("included free usage") ||
        s.lower.includes("rolling 24-hour") ||
        s.lower.includes("rolling 24 hour");
      const buddyCreditsExhausted =
        s.providerCode === "14018" || s.lower.includes("credits exhausted");
      const cooldownMs = grokFreeTier
        ? (s.statedCooldownMs ?? GROK_QUOTA_COOLDOWN_MS)
        : buddyCreditsExhausted
          ? (s.statedCooldownMs ?? 12 * 60 * 60 * 1000)
          : (s.statedCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS());
      // The caller records against the concrete account that just failed
      // upstream, so a provider-scoped quota error still cools THAT account
      // down (enables fallback to the next account). Local-origin quota must
      // never mutate an upstream account.
      return s.result(
        "quota_exhausted",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider quota exhausted"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "rate-limit",
    match: (s) =>
      s.statusCode === 429 ||
      s.providerCode === "rate_limit_exceeded" ||
      s.lower.includes("rate_limit") ||
      s.lower.includes("rate limit") ||
      s.lower.includes("too many requests") ||
      s.lower.includes("requests per minute") ||
      s.lower.includes("tokens per minute") ||
      s.lower.includes("tpm limit") ||
      s.lower.includes("rpm limit"),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS();
      // Same per-account reasoning as quota above: the failing account (or
      // its model, when modelId is present) backs off so routing tries the
      // next candidate instead of hammering the same key.
      return s.result(
        "rate_limit_transient",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider rate limit"),
        s.origin === "upstream",
      );
    },
  },
  {
    name: "model-capacity",
    match: (s) =>
      s.statusCode === 503 ||
      s.statusCode === 529 ||
      s.providerCode === "model_capacity" ||
      s.queuedUpstream ||
      s.lower.includes("model overloaded") ||
      s.lower.includes("capacity exceeded") ||
      s.lower.includes("temporarily unavailable"),
    decide: (s) => {
      const cooldownMs = s.statedCooldownMs ?? MODEL_CAPACITY_COOLDOWN_MS();
      const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
      return s.result(
        "model_capacity",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Provider model capacity"),
        modelScopedMutation,
      );
    },
  },
  {
    name: "model-unsupported",
    match: (s) => isUnsupportedModelEvidence(s.statusCode, s.providerCode, s.folded),
    decide: (s) => {
      const cooldownMs = unsupportedModelCooldownMs(s.modelBlockHits);
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model not supported by this upstream"),
        s.origin === "upstream" && s.modelId !== undefined,
        true,
      );
    },
  },
  {
    name: "model-unreachable",
    match: (s) => s.providerCode === "not_found" || s.modelEntitlementFailure,
    decide: (s) => {
      const cooldownMs = MODEL_UNREACHABLE_COOLDOWN_MS;
      // Not credential evidence, so `classifyUpstreamFailure` scopes this to the
      // provider and the `scope === "account"` gate the throttles use would
      // forbid the mutation outright — leaving the probe reporting a failure that
      // cooled nothing. The verdict is still about one (account, model) pair:
      // `recordAccountFailure` writes `modelCooldowns[modelId]` and leaves the
      // account's own status untouched, so all that is required is a model to
      // write against.
      const modelScopedMutation = s.origin === "upstream" && s.modelId !== undefined;
      return s.result(
        "model_unreachable",
        "cooldown",
        cooldownMs,
        new Date(Date.now() + cooldownMs),
        s.reason("Model unreachable for this account"),
        modelScopedMutation,
      );
    },
  },
  {
    name: "transport-fault",
    match: (s) =>
      (s.statusCode !== null && s.statusCode >= 500 && s.statusCode <= 504) ||
      s.lower.includes("timeout") ||
      s.lower.includes("abort") ||
      s.lower.includes("econnrefused") ||
      s.lower.includes("fetch failed"),
    decide: (s) => {
      // A transport-shaped fault clears on its own, so it is a cooldown with a
      // deadline rather than a state needing an operator. The deadline matters:
      // `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so a row
      // parked without one is never recovered and stays out of rotation.
      //
      // `canMutate` rather than a flat `false`: a 5xx whose failure the caller
      // scoped to the account (an edge/WAF challenge answered to one account's
      // requests while its siblings on the same egress served fine) must cool
      // that account down, or it stays `active` and is re-dialled for as long as
      // the block lasts. Provider-scoped 5xx does not: the upstream is
      // indiscriminately failing and no single account is at fault.
      const transientMs = TRANSIENT_ERROR_COOLDOWN_MS();
      return s.result(
        s.lower.includes("timeout") ? "timeout" : "server_error",
        "cooldown",
        transientMs,
        new Date(Date.now() + transientMs),
        s.reason(`Provider ${s.statusCode ?? "network"} failure`),
        s.canMutate,
      );
    },
  },
];

/** Persists one classified failure to the account row and appends a health event. */
export async function recordAccountFailure(
  db: CartethyiaDatabase,
  accountId: string,
  error: unknown,
  options?: AccountFailureEvidence,
): Promise<AccountErrorClassification | null> {
  const classification = classifyAccountError(error, options);
  /**
   * Logged even when the classification does not mutate the account.
   *
   * `rate_limit_transient` seen on a stream frame carries no credential
   * detail, so it classifies at provider scope and `mutatesAccount` is false
   * — nothing is cooled and the account stays `active`. That part is correct:
   * the upstream's own remedy ("switch to the other models") only works if the
   * account keeps serving. But this returned without writing anything, so a
   * rate-limited request showed up in the request log while the account's
   * health log stayed empty — a symptom with no recorded cause.
   *
   * The row is the whole point of this branch: it records the failure without
   * moving the account. Both status sides are the classification's own, so the
   * dialog names the cause without claiming a transition that never happened.
   */
  if (!classification.mutatesAccount) {
    void writeHealthEvent(db, {
      entityKind: "account",
      accountId,
      fromStatus: classification.status,
      toStatus: classification.status,
      reason: classification.reason,
      errorCategory: classification.category,
      modelId: options?.modelId ?? null,
      createdAt: new Date(),
    }).catch(() => undefined);
    return classification;
  }

  const persist = async (client: CartethyiaDatabase): Promise<AccountErrorClassification | null> => {
    // Projected, not a bare `select()`: this runs on *every* attempt outcome,
    // and a full row drags `credential_ciphertext` (the largest thing stored
    // per account) and `auth_state` over the wire to read a status and a
    // counter. `RouteCatalogRepository` already projects for the same reason.
    const accountRows = await client
      .select({
        status: providerAccounts.status,
        staticToken: providerAccounts.staticToken,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        modelCooldowns: providerAccounts.modelCooldowns,
        // Read only for the unsupported-model ladder; NULL means "never
        // counted", which is the common case and must stay cheap.
        modelBlockHits: providerAccounts.modelBlockHits,
        cooldownUntil: providerAccounts.cooldownUntil,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account || account.status === "disabled") return null;

    // Re-classify with the account's own static-token flag. The caller's
    // evidence is request-scoped and does not carry it, but an auth rejection
    // against a static token must cool the account down rather than park it —
    // there is no refresh to run, and the token may still be valid.
    const effective = account.staticToken
      ? classifyAccountError(error, { ...options, staticToken: true })
      : classification;

    const fromStatus = account.status;
    const now = new Date();

    const modelId = options?.modelId;
    // Every category here is a verdict about one (account, model) pair rather
    // than about the credential, so all three back off that pair and leave the
    // account routable for every other model. `model_unreachable` joins the two
    // throttles on the same reasoning: an upstream that reports the model does
    // not exist for this account will report it again on the next request.
    const isThrottle =
      effective.category === "rate_limit_transient" ||
      effective.category === "model_capacity" ||
      effective.category === "model_unreachable";
    const shouldModelCooldown = modelId !== undefined && isThrottle;
    // The account-wide streak, escalated for a provider-stated window. Read once
    // so the model-scoped and account-wide paths below cannot disagree about it:
    // this is the count *before* this failure, which the UPDATE below increments.
    const streak = Math.max(0, account.consecutiveFailures ?? 0);
    const escalatedCooldownMs = escalateFallbackCooldown(
      effective.cooldownMs,
      effective.providerStated === true,
      streak,
    );

    // The unsupported-model ladder, computed before the branch: the classifier
    // could only state the base window because the authoritative hit count
    // lives on the row, and it is read here. `hits` is the new total for this
    // pair, so the first report is 1 and gets the base window.
    const blockHits = (account.modelBlockHits as Record<string, number> | null) ?? {};
    const unsupportedHits =
      effective.modelUnsupported === true && modelId !== undefined
        ? Math.max(1, (blockHits[modelId] ?? 0) + 1)
        : undefined;
    // An unsupported-model window is stated by *us*, not by the provider, so it
    // would otherwise be multiplied a second time by `escalateFallbackCooldown`
    // (which reads `consecutiveFailures`, an account-wide counter). The two
    // ladders are different things: one counts how many times this pair was
    // reported unsupported, the other how many failures this account produced.
    const unsupportedCooldownMs =
      unsupportedHits === undefined ? undefined : unsupportedModelCooldownMs(unsupportedHits);

    if (shouldModelCooldown) {
      const existing = (account.modelCooldowns as Record<string, string> | null) ?? {};
      // Monotonic: never move an in-force window earlier (see `latestDeadlineMs`).
      // A provider-stated deadline wins outright because it is already the later
      // of the two whenever the provider really parked the pair longer.
      const nextUntil = new Date(
        latestDeadlineMs(
          effective.retryAt?.getTime(),
          Date.now() + (unsupportedCooldownMs ?? escalatedCooldownMs),
          existing[modelId] ? Date.parse(existing[modelId]!) : undefined,
        ),
      ).toISOString();
      const previousUntil = existing[modelId];
      // A re-statement is not an event: what the audit row reports is the
      // *entry* into a cooling episode, and the deadline itself is not a
      // column — so a row can only ever say "this pair started cooling for
      // this reason". The upstream answers the same "Try again in 11h" on
      // every retry (and an unstated reset is recomputed from now each time),
      // so writing per failure produced seven identical rows in twenty minutes
      // and read as an account flapping when nothing had changed. The entry is
      // still refreshed below — its error fields are what the dialog explains
      // the cooldown with — while an entry that is still in force suppresses
      // the duplicate row.
      const alreadyCooling =
        previousUntil !== undefined && new Date(previousUntil).getTime() > Date.now();
      // `status`/`cooldownUntil` stay untouched: only this (account, model)
      // pair backs off, and the account remains routable for every other model.
      // The error fields ARE written, because they are what provider detail and
      // the health dialog read to explain *why* a model is cooling — without
      // them the row showed "1 model cooling" with no reason at all.
      //
      // The streak advances here too. Without it the most common throttle — a
      // model-scoped rate limit — never escalated, because the counter was only
      // incremented on the account-wide path below, and `consecutiveFailures`
      // stays honest about what it always claimed to count: how many failures in
      // a row this account has just produced.
      await client
        .update(providerAccounts)
        .set({
          modelCooldowns: { ...existing, [modelId]: nextUntil },
          // Counted only for the unsupported-model ladder, and only when this
          // failure is that verdict — so a rate limit or a capacity refusal
          // never advances it. `model_cooldowns`' own shape is untouched, so
          // routing and the console keep parsing it exactly as before.
          ...(unsupportedHits === undefined
            ? {}
            : { modelBlockHits: { ...blockHits, [modelId]: unsupportedHits } }),
          consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
          lastError: effective.reason,
          lastErrorCategory: effective.category,
          lastErrorAt: now,
        })
        .where(eq(providerAccounts.id, accountId));
      if (!alreadyCooling) {
        await writeHealthEvent(client, {
          entityKind: "account",
          accountId,
          // The account's own status, on both sides: a model-scoped throttle
          // never moved it, and writing the classification's status here
          // claimed an `active → cooldown` transition that never happened — the
          // dialog showed "Account status: ACTIVE" above a list of transitions
          // to `cooldown`. The row still names the model and the reason, which
          // is what makes it worth keeping.
          fromStatus: fromStatus as "active" | "cooldown" | "disabled",
          toStatus: fromStatus as "active" | "cooldown" | "disabled",
          reason: effective.reason,
          errorCategory: effective.category,
          modelId: modelId ?? null,
          createdAt: now,
        });
      }
      // `status` and `cooldownUntil` are untouched on this path — only the
      // (account, model) pair backed off — so the snapshot is still accurate
      // and must not be dropped.
      return { ...classification, routesVisible: false };
    }

    await client
      .update(providerAccounts)
      .set({
        status: effective.status,
        consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
        lastError: effective.reason,
        lastErrorCategory: effective.category,
        lastErrorAt: now,
        // Monotonic against the account's own in-force deadline, for the same
        // reason as the model path: an unclassified 60-second failure must not
        // release an account the provider parked for hours.
        //
        // A `0` duration contributes no candidate rather than stamping *now*
        // (see `accountDeadlineMs`): the one state that asks for it is a
        // terminal automatic disable, and an elapsed deadline there would hand
        // the row straight back to the recovery sweep.
        cooldownUntil: accountDeadlineMs([
          effective.retryAt?.getTime(),
          escalatedCooldownMs > 0 ? Date.now() + escalatedCooldownMs : undefined,
          account.cooldownUntil?.getTime?.(),
        ]),
      })
      .where(eq(providerAccounts.id, accountId));

    {
      await writeHealthEvent(client, {
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: effective.status,
        reason: effective.reason,
        errorCategory: effective.category,
        modelId: modelId ?? null,
        createdAt: now,
      });
    }
    // This path wrote `status` and `cooldownUntil`, both of which the snapshot
    // projects, so routing has to see it.
    return { ...classification, routesVisible: true };
  };

  try {
    // Kept as a capability probe, not a correctness guard: this function is
    // reachable with a partially-implemented database handle (the dispatch
    // tests pass a narrow double), and a transaction is an optimization here,
    // not a requirement — the same writes are correct without one.
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => persist(tx as CartethyiaDatabase));
    }
    return await persist(db);
  } catch {
    return null;
  }
}

/** Clears failure state after a successful dispatch; true when the account changed. */
export async function recordAccountSuccess(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<boolean> {
  const mutate = async (client: CartethyiaDatabase): Promise<boolean> => {
    // `recordAccountSuccess` runs on every successful dispatch, and for a
    // healthy account `hadFailures` is false — the row was fetched purely to
    // decide nothing. Projected so that no-op path does not pull the
    // credential ciphertext across the wire.
    const rows = await client
      .select({
        status: providerAccounts.status,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        // Read only to decide whether there is anything to clear: the common
        // case (no unsupported-model hit ever recorded) must not write.
        modelBlockHits: providerAccounts.modelBlockHits,
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = rows[0];
    if (!account || account.status === "disabled") return false;
    const fromStatus = account.status;
    const hadFailures = (account.consecutiveFailures ?? 0) > 0 || account.status !== "active";
    const now = new Date();
    // The unsupported-model escalation restarts after a success: a model that
    // just served is not "not supported", so the next report of it must start
    // from the base window again rather than from wherever the ladder had
    // reached. `modelCooldowns` is deliberately NOT cleared — an in-force
    // window the provider stated survives, which is the existing behavior and
    // the reference gateways' too.
    const blockHits = account.modelBlockHits as Record<string, number> | null;
    const hasBlockHits = blockHits !== null && Object.keys(blockHits).length > 0;
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastSuccessAt: now,
        ...(hadFailures ? { lastRecoveredAt: now } : {}),
        ...(hasBlockHits ? { modelBlockHits: {} } : {}),
      })
      .where(eq(providerAccounts.id, accountId));
    if (hadFailures && typeof client.insert === "function") {
      await client.insert(healthEvents).values({
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: "active",
        reason: "Request dispatched successfully",
        errorCategory: null,
        createdAt: now,
      });
    }
    return hadFailures;
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => mutate(tx as CartethyiaDatabase));
    }
    return await mutate(db);
  } catch {
    return false;
  }
}

/** Operator-initiated recovery: forces the account back to active and logs the transition. */
export async function recoverAccount(
  db: CartethyiaDatabase,
  accountId: string,
  reason = "manual_operator_recovery",
): Promise<boolean> {
  const recover = async (client: CartethyiaDatabase): Promise<boolean> => {
    const accountRows = await client
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account) return false;
    const fromStatus = account.status;
    const now = new Date();
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastRecoveredAt: now,
        // Recovery is the operator asserting the account works now, so it must
        // clear EVERY routing exclusion, not just the account-wide ones. A
        // per-model cooldown entry excludes the (account, model) pair in
        // `route-catalog.ts`, so leaving it behind kept the account blocked for
        // that model through `/v1` even though the account read `active` and a
        // direct probe (which addresses the account by id, bypassing routing
        // eligibility) succeeded. Clearing the error fields for the same reason:
        // a stale reason on a recovered row misreports the current state.
        modelCooldowns: {},
        lastError: null,
        lastErrorCategory: null,
        lastErrorAt: null,
      })
      .where(eq(providerAccounts.id, accountId));
    {
      await writeHealthEvent(client, {
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "cooldown" | "disabled",
        toStatus: "active",
        reason,
        errorCategory: null,
        createdAt: now,
      });
    }
    return true;
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => recover(tx as CartethyiaDatabase));
    }
    return await recover(db);
  } catch {
    return false;
  }
}

/** Recovers accounts whose cooldown elapsed and prunes expired per-model keys. */
export async function sweepExpiredCooldowns(db: CartethyiaDatabase): Promise<number> {
  const recover = async (client: CartethyiaDatabase): Promise<number> => {
    const now = new Date();
    const nowIso = now.toISOString();
    const expired = await client
      .select({
        id: providerAccounts.id,
        status: providerAccounts.status,
      })
      .from(providerAccounts)
      .where(
        or(
          // An ordinary cooldown, recovered as soon as its window elapses.
          and(
            eq(providerAccounts.status, "cooldown"),
            isNotNull(providerAccounts.cooldownUntil),
            lte(providerAccounts.cooldownUntil, now),
          ),
          // An **automatic** disable. Selected only when it carries a deadline:
          // an operator's disable leaves
          // `cooldownUntil` null, so a human's decision still outranks the
          // machine and is never swept away. The deadline is written by the two
          // paths that disable on evidence — the classifier's revocation branch
          // and a definitively rejected refresh grant.
          and(
            eq(providerAccounts.status, "disabled"),
            isNotNull(providerAccounts.cooldownUntil),
            lte(providerAccounts.cooldownUntil, now),
          ),
        ),
      )
      // One pass recovers a bounded batch. The sweep runs every 30s, so a
      // backlog larger than this drains over successive ticks instead of one
      // statement covering every expired row — that statement holds its locks
      // for as long as the backlog takes.
      .limit(COOLDOWN_RECOVERY_BATCH);
    if (expired.length > 0) {
      await client
        .update(providerAccounts)
        .set({
          status: "active",
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastRecoveredAt: now,
          // Cleared with the state it described. A recovered row that kept
          // `auth_invalidated` still rendered the console's "Re-login required"
          // pill above an `active` status, so the account read healthy to
          // routing and broken to the operator at the same time.
          lastErrorCategory: null,
        })
        .where(inArray(providerAccounts.id, expired.map((account) => account.id)));
      if (typeof client.insert === "function") {
        for (let offset = 0; offset < expired.length; offset += 500) {
          await client.insert(healthEvents).values(
            expired.slice(offset, offset + 500).map((account) => ({
              entityKind: "account" as const,
              accountId: account.id,
              fromStatus: account.status,
              toStatus: "active" as const,
              reason: "Cooldown period elapsed — auto-recovered",
              errorCategory: null,
              createdAt: now,
            })),
          );
        }
      }
    }

    // Prune per-model cooldowns: remove entries whose ISO timestamp has passed.
    //
    // One set-based UPDATE rather than a SELECT followed by an UPDATE per row.
    // The per-row form issued one statement per account holding any cooldown —
    // on a deployment where many accounts are throttled at once that is the
    // sweep's dominant cost, and it all runs inside this transaction, holding
    // its locks for the whole pass. Recomputing the object in SQL does the same
    // work in one statement.
    //
    // `jsonb_typeof(...) = 'object'` guards the shape: a malformed value must
    // not abort the whole sweep. `IS DISTINCT FROM` keeps the update from
    // rewriting rows it
    // did not change, so the returned row count is the number of accounts whose
    // cooldown set actually shrank — the same thing the loop counted.
    const pruning = pruneExpiredCooldowns(sql`${providerAccounts.modelCooldowns}`, sql`${nowIso}`);
    const pruned = await client
      .update(providerAccounts)
      .set({ modelCooldowns: pruning.value })
      .where(pruning.changed);
    return expired.length + affectedRows(pruned);
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => recover(tx as CartethyiaDatabase));
    }
    return await recover(db);
  } catch {
    return 0;
  }
}

/**
 * Single attempt health reporter: one home for the success/failure writes
 * every dispatch attempt ends with. Success records recovery; failure
 * records with caller-supplied evidence (origin/scope classification plus
 * model id). A mutating write invalidates the route snapshot so the next
 * plan sees fresh health. Never throws — health must not fail requests.
 */
export interface AttemptHealthReport {
  readonly accountId: string | undefined;
  readonly modelId?: string;
  readonly error?: unknown;
  readonly evidence?: AccountFailureEvidence;
  readonly snapshotService?: { invalidate(): unknown };
}

/**
 * Writes one health audit row, off the request path when a buffer is installed.
 *
 * `health_events` is append-only and read by nobody in the request path, so it
 * does not need to land before the request finishes — unlike the
 * `provider_accounts` UPDATE beside it, which routing reads and which therefore
 * stays synchronous and transactional.
 */
async function writeHealthEvent(
  client: CartethyiaDatabase,
  row: {
    readonly entityKind: "account";
    readonly accountId: string;
    readonly fromStatus: string;
    readonly toStatus: string;
    readonly reason: string;
    readonly errorCategory: string | null;
    readonly modelId?: string | null;
    readonly createdAt: Date;
  },
): Promise<void> {
  const buffer = healthEventBuffer();
  if (buffer !== undefined) {
    buffer.enqueue({ ...row, modelId: row.modelId ?? null });
    return;
  }
  if (typeof client.insert !== "function") return;
  await client.insert(healthEvents).values(row as never);
}

export async function reportAttemptOutcome(
  db: CartethyiaDatabase,
  report: AttemptHealthReport,
): Promise<void> {
  if (!report.accountId) return;
  if (report.error === undefined) {
    const recovered = await recordAccountSuccess(db, report.accountId).catch(() => false);
    if (recovered) await report.snapshotService?.invalidate();
    return;
  }
  const classification = await recordAccountFailure(db, report.accountId, report.error, {
    ...report.evidence,
    ...(report.modelId === undefined ? {} : { modelId: report.modelId }),
  }).catch(() => null);
  // Gated on `routesVisible`, not on `mutatesAccount`: a failure that only
  // cooled one (account, model) pair, or only advanced the streak, changed
  // nothing routing reads. Invalidating for those rebuilt an 11-SELECT snapshot
  // on the next request, and under a failure wave each rebuild fed the next
  // invalidation.
  if (classification?.routesVisible) await report.snapshotService?.invalidate();
}

export async function listAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
  limit = 50,
): Promise<readonly AccountHealthEventRecord[]> {
  try {
    const rows = await db
      .select()
      .from(healthEvents)
      .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
      .orderBy(desc(healthEvents.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId as string,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      modelId: r.modelId ?? null,
      reason: r.reason,
      errorCategory: r.errorCategory,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Every stored row across accounts and pools — the size the purge offers to delete. */
export async function countAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  try {
    const rows = await db.select({ total: count() }).from(healthEvents);
    return rows[0]?.total ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Deletes stored health & error rows.
 *
 * Unlike the read above, a failed delete surfaces: an operator who purged
 * believes the trail is gone, so "it failed" must not read as "it succeeded
 * with zero rows". Callers own the flush-buffer barrier (`drain`) so a queued
 * write cannot land after these rows are gone.
 */
export async function deleteAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<number> {
  const rows = await db
    .delete(healthEvents)
    .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
    .returning({ id: healthEvents.id });
  return rows.length;
}

export async function deleteAllHealthEvents(db: CartethyiaDatabase): Promise<number> {
  const rows = await db.delete(healthEvents).returning({ id: healthEvents.id });
  return rows.length;
}
