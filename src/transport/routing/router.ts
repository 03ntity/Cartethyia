// Routing model resolution and route planning.
import { log } from "../../observability/logger";
import { GatewayError } from "../../protocol/gateway-error";
import {
  accountsRateLimitedError,
  accountsUnavailableError,
  ambiguousModelError,
  capacityExhaustedError,
  modelNotFoundError,
  type AdmissionController,
  type ComboDefinition,
  type RouteCandidate,
  type RoutedCandidate,
  type RoutePlan,
  type Reservation,
  type RouteContinuationAffinity,
  type RouteSnapshot,
  type RoutingDecision,
  ROUTING_RANK,
} from "./route-model";
import {
  candidateSupportsRequest,
  type RequiredCapability,
} from "../../protocol/translation/capabilities";
import { planAllowsCandidate } from "./plan-gate";
import { accountReservePct, routingStickyWarmMs, routingStickyMaxSessions } from "../../config/routing";
import { InMemoryAdmissionController, admissionKey } from "./admission";
import { ReservationManager } from "./reservations";
import { createRoundRobinMap, RoundRobinState, StickySessionStore } from "./round-robin";
import { drainScore, isInReserve } from "./drain-reserve";
import {
  lookupRouteCandidates,
  parseModelReference,
  routeCandidateIndex,
} from "./candidate-index";
import type { ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import { getCachedQuotaEntries, quotaLens, type CachedQuotaEntry } from "../../providers/quota/cache";
import { readQuotaSnapshots } from "../../providers/quota/snapshot";
import type { ProviderQuotaResultSnapshot } from "../../persistence/schema";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { sharedClaudeSlowLanes } from "../../providers/integrations/claude/claude-slow-lane";
import {
  EligibilityEvaluator,
  creditPriority,
  earliestResetMs,
  exhaustedResetMs,
  filterCandidateQuotaWindows,
  hotWindow,
  normalizeQuotaFact,
} from "./candidate-evaluation";
import {
  applyProviderRoutingSorted as applyProviderRoutingSortedPlan,
  resolveProviderRouting as resolveProviderRoutingSetting,
} from "./provider-routing";

// Public API preserved across the candidate-evaluation / provider-routing
// split: importers of router.ts keep working unchanged.
export {
  EligibilityEvaluator,
  QUOTA_FRESHNESS_HORIZON_MS,
  accountRemainingCredit,
  allWindowsExhausted,
  creditPriority,
  earliestResetMs,
  exhaustedResetMs,
  filterCandidateQuotaWindows,
  hotWindow,
  normalizeQuotaFact,
  spreadDeadline,
  usageFloorStateFor,
} from "./candidate-evaluation";

/**
 * Normalizes a requested model name before alias lookup. Coding-agent CLIs
 * version their model ids with variant suffixes (`claude-opus-5[1m]`,
 * effort tags, …) that must never each become a mapping row. Normalization
 * is a pure lookup fallback — verbatim match always wins, and an
 * unrecognized name still resolves to itself (then fails downstream as
 * `model_not_found`, exactly like today).
 */
function normalizeAliasKey(requested: string, aliasMap: Record<string, string> | undefined): string {
  if (!aliasMap || aliasMap[requested] !== undefined) return requested;
  // 1. Strip a trailing `[...]` variant (`claude-opus-5[1m]` → `claude-opus-5`).
  let base = requested;
  const bracket = requested.indexOf("[");
  if (bracket > 0) {
    base = requested.slice(0, bracket);
    if (aliasMap[base] !== undefined) return base;
  }
  // 2. Family-slot fallback: `claude-<slot>-…` resolves through the slot
  // alias (`claude-opus-5` → `opus`, `claude-opus` → `opus`) so a full model
  // id honors the same mapping as the short slot name without per-variant
  // rows. Only fires when the full name has no mapping of its own.
  if (base.startsWith("claude-")) {
    const rest = base.slice("claude-".length);
    if (aliasMap[rest] !== undefined) return rest;
    const dash = rest.indexOf("-");
    if (dash > 0) {
      const slot = rest.slice(0, dash);
      if (aliasMap[slot] !== undefined) return slot;
    }
  }
  return base;
}

/**
 * Resolves one requested name to its alias target for pre-routing policy
 * checks. CLI mappings are opt-in per API key; ordinary tenant aliases always
 * remain available. `keyId` is required to read the key's own CLI routes —
 * without it CLI mappings are silently skipped even when `allowCliMappings`
 * is true.
 */
export function resolveAliasTarget(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  requested: string,
  allowCliMappings = false,
  keyId?: string,
): string {
  try {
    return resolveAlias(requested, snapshot, tenantId, allowCliMappings, keyId).model;
  } catch {
    return requested;
  }
}

/**
 * Merged alias maps cached per snapshot object. `plan()` resolves the requested
 * model plus every combo member through `resolveAlias`, and each call used to
 * re-merge the tenant and CLI alias records — O(members × aliases) per plan.
 * Snapshots are immutable per revision, so the merge is cached on the snapshot
 * itself; the returned record is read-only by contract (resolvers only index
 * it, never write).
 */
const aliasMapCache = new WeakMap<
  RouteSnapshot,
  Map<string, Record<string, string> | undefined>
>();

function aliasMapFor(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings: boolean,
  keyId?: string,
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const cacheKey = JSON.stringify([tenantId, allowCliMappings, keyId ?? null]);
  let perSnapshot = aliasMapCache.get(snapshot);
  if (perSnapshot === undefined) {
    perSnapshot = new Map();
    aliasMapCache.set(snapshot, perSnapshot);
  }
  if (perSnapshot.has(cacheKey)) return perSnapshot.get(cacheKey);
  const aliases = snapshot.aliases?.[tenantId];
  const cliAliases = allowCliMappings
    ? keyId
      ? snapshot.cli_aliases?.[`${tenantId}:${keyId}`] ?? snapshot.cli_aliases?.[tenantId]
      : snapshot.cli_aliases?.[tenantId]
    : undefined;
  const merged =
    !aliases && !cliAliases ? undefined : { ...(aliases ?? {}), ...(cliAliases ?? {}) };
  perSnapshot.set(cacheKey, merged);
  return merged;
}

function resolveAlias(
  requested: string,
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings = false,
  keyId?: string,
): { model: string; chain: readonly string[] } {
  const aliasMap = aliasMapFor(snapshot, tenantId, allowCliMappings, keyId);
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizeAliasKey(requested, aliasMap);
  while (aliasMap?.[current] !== undefined) {
    if (seen.has(current))
      throw new Error(`routing alias cycle: ${[...chain, current].join(" -> ")}`);
    if (chain.length >= 16)
      throw new Error(`routing alias depth exceeded: ${[...chain, current].join(" -> ")}`);
    const target = aliasMap[current];
    if (target === undefined) break;
    seen.add(current);
    chain.push(current);
    current = target;
  }
  return { model: current, chain };
}

export class RoutingEngine {
  private readonly _roundRobinByCombo = createRoundRobinMap();
  private readonly _roundRobinByProvider = createRoundRobinMap();
  private readonly eligibility = new EligibilityEvaluator();
  private readonly reservations = new ReservationManager();
  private readonly sticky = new StickySessionStore(routingStickyMaxSessions());

  constructor(
    private readonly admission: AdmissionController = new InMemoryAdmissionController(),
    private readonly redis?: RedisClient,
    private readonly db?: CartethyiaDatabase,
  ) {}

  private getRoundRobin(key: string): RoundRobinState {
    const existing = this._roundRobinByCombo.get(key);
    if (existing) return existing;
    const created = new RoundRobinState();
    this._roundRobinByCombo.set(key, created);
    return created;
  }

  private getProviderRoundRobin(key: string): RoundRobinState {
    const existing = this._roundRobinByProvider.get(key);
    if (existing) return existing;
    const created = new RoundRobinState();
    this._roundRobinByProvider.set(key, created);
    return created;
  }

  /** Observable bounded-collection sizes for the runtime metrics sampler. */
  roundRobinEntries(): { readonly combo: number; readonly provider: number } {
    return { combo: this._roundRobinByCombo.size, provider: this._roundRobinByProvider.size };
  }

  /**
   * Live admission counters for the buckets the given candidates draw from.
   *
   * Takes candidates rather than returning a fleet-wide snapshot: the scoped
   * read is what keeps `plan()` off Redis `KEYS` (the fleet-wide read had no
   * other implementation) and bounds the console's per-provider read to the
   * accounts it will actually report on. Both controllers hand back a fresh
   * map, so no defensive copy here — this feeds an admin read, not a mutation
   * site.
   */
  async accountInflightSnapshot(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    return this.admission.readAccountInflight(candidates);
  }

  /**
   * Which candidates are already at their concurrency ceiling.
   *
   * The admission controller already holds these counters and will refuse the
   * account the moment it is asked; reading them here lets the plan *order*
   * use the same fact, so the first attempt goes to an account with room
   * instead of to one that is certain to answer 429.
   *
   * A counter read is a snapshot, so it can be a little stale — a slot freed
   * between here and `admit()` only costs a retry, which is the behavior
   * today anyway. A candidate with no configured ceiling is never saturated:
   * admission treats it as unlimited.
   */
  private async saturatedCandidates(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlySet<RouteCandidate>> {
    const bounded = candidates.filter(
      (candidate) => typeof candidate.max_inflight === "number" && candidate.max_inflight > 0,
    );
    if (bounded.length === 0) return new Set();
    // Only the bounded candidates can be saturated, so only their buckets are
    // read. A failed ordering read must never fail routing — the admission
    // attempt itself is the real gate; this read only optimizes attempt order.
    const snapshot = await this.accountInflightSnapshot(bounded).catch(
      () => new Map<string, number>(),
    );
    if (snapshot.size === 0) return new Set();
    const saturated = new Set<RouteCandidate>();
    for (const candidate of bounded) {
      const limit = candidate.max_inflight;
      if (limit === undefined) continue;
      const inflight = snapshot.get(admissionKey(candidate));
      if (inflight !== undefined && inflight >= limit) {
        saturated.add(candidate);
      }
    }
    return saturated;
  }

  /**
   * Stamps one candidate with its provider's usage floor + quota windows (the
   * per-candidate half of the old `applyUsageFloor`).
   */
  private applyUsageFloorToCandidate(
    candidate: RouteCandidate,
    snapshot: RouteSnapshot,
    tenantId: string | null,
    quotaCache: ReadonlyMap<string, CachedQuotaEntry>,
    snapshotMap: ReadonlyMap<string, ProviderQuotaResultSnapshot>,
  ): RouteCandidate {
    const accountId = candidate.provider_account_id;
    if (accountId === undefined) return candidate;
    const setting = resolveProviderRoutingSetting(
      snapshot,
      candidate.provider_id,
      candidate.tenant_id ?? tenantId,
    );
    const cached = quotaCache.get(accountId);
    // The live cache is authoritative when warm; when it is cold (e.g. right
    // after a restart, before the sweep re-reads accounts), fall back to the
    // persisted quota snapshot — the durable source of truth — so routing
    // still prefers accounts that actually have remaining credit. The snapshot
    // is never fresher than the cache, but a stale balance beats an unknown
    // one for ordering, and the sweep refreshes it on schedule.
    let quota = cached?.quota;
    let stored: { readonly fetchedAt: string; readonly quota: ProviderQuotaResult } | null = null;
    if (quota === undefined) {
      const snap = snapshotMap.get(accountId);
      if (snap !== undefined) {
        stored = { fetchedAt: snap.fetchedAt, quota: snap.quota };
        quota = snap.quota;
      }
    }
    const rawWindows = quota?.windows;
    // The cache is authoritative when it has a reading; when it does not,
    // keep whatever the candidate already carried (the credit ordering reads
    // these windows, and a miss must not erase a stamped value).
    const quotaWindows =
      rawWindows === undefined
        ? undefined
        : candidate.provider_id === "zcode-start" ? rawWindows : filterCandidateQuotaWindows(rawWindows, candidate);
    const stamped: RoutedCandidate = {
      ...candidate,
      ...(setting?.usageFloor == null
        ? {}
        : { usage_floor: setting.usageFloor, usage_floor_unit: setting.usageFloorUnit }),
      // When no cache/snapshot evidence exists, the candidate's own stamped
      // windows ride through `...candidate` untouched — a miss must not erase
      // a stamped value.
      ...(quotaWindows === undefined ? {} : { quota_windows: quotaWindows }),
      ...(quota?.source === "zcode-start" && quota.error === null ? { quota_entitlements_known: true } : {}),
    };
    // Drain urgency and reserve are derived from the same windows the credit
    // ordering already reads. They are ordering preferences, never exclusions:
    // an account in reserve or with a zero drain score stays eligible and
    // routed. `RoutedCandidate` declares these fields mutable, so stamping them
    // directly avoids a second full candidate copy per plan.
    const derivedWindows = quotaWindows ?? candidate.quota_windows;
    if (derivedWindows !== undefined) {
      stamped.drain_score = drainScore(derivedWindows);
      stamped.in_reserve = isInReserve(derivedWindows, accountReservePct());
    }
    stamped.quota_fact = normalizeQuotaFact(stamped, cached, stored);
    return stamped;
  }

  /**
   * One merged evaluation of a candidate: health/cooldown eligibility, slow
   * lane, usage floor, plan gate, and capability support. Returns the candidate
   * and the single `RoutingDecision` every downstream layer reads.
   */
  private evaluateCandidate(
    candidate: RouteCandidate,
    _snapshot: RouteSnapshot,
    _tenantId: string | null,
    requiredCapabilities: readonly RequiredCapability[] | undefined,
  ): { candidate: RouteCandidate; decision: RoutingDecision } {
    const eligibility = this.eligibility.evaluate(candidate);
    if (!eligibility.eligible) {
      const reason = eligibility.reason;
      const rank =
        reason === "model_cooldown" || reason === "cooldown_hard"
          ? ROUTING_RANK.COOLING
          : ROUTING_RANK.SATURATED;
      return {
        candidate,
        decision: {
          eligible: false,
          rank,
          reason,
          ...(eligibility.cooldown_until !== undefined
            ? { cooldown_until: eligibility.cooldown_until }
            : {}),
          floor_blocked: reason === "quota_exhausted",
        },
      };
    }
    // Slow lane.
    const accountId = (candidate as RouteCandidate & { readonly provider_account_id?: string })
      .provider_account_id;
    if (accountId !== undefined && sharedClaudeSlowLanes.isActive(accountId)) {
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.SLOW,
          reason: "slow",
        },
      };
    }
    // Unified decision engine: normalized quota/plan fact.
    const fact = candidate.quota_fact;
    if (fact !== undefined) {
      if (fact.quotaState === "exhausted" || fact.usageFloorState === "below") {
        const reset = exhaustedResetMs(candidate.quota_windows);
        return {
          candidate,
          decision: {
            eligible: false,
            rank: ROUTING_RANK.SATURATED,
            reason: "quota_exhausted",
            floor_blocked: fact.usageFloorState === "below",
            saturated: false,
            ...(reset === undefined ? {} : { cooldown_until: reset }),
          },
        };
      }
    }
    // Plan gate (free plan).
    if (!planAllowsCandidate(candidate)) {
      return {
        candidate,
        decision: {
          eligible: false,
          rank: ROUTING_RANK.SATURATED,
          reason: "plan_gate",
          plan_gate_blocked: true,
        },
      };
    }
    // Capability.
    if (requiredCapabilities !== undefined && requiredCapabilities.length > 0) {
      if (!candidateSupportsRequest(candidate, requiredCapabilities)) {
        return {
          candidate,
          decision: {
            eligible: false,
            rank: ROUTING_RANK.SATURATED,
            reason: "capability_unsupported",
            capability_blocked: true,
          },
        };
      }
    }
    // A soft cooldown is a deprioritization, not an exclusion: the evaluator
    // returned it eligible (so a single-account deployment still routes), but
    // it must still behind every fresh/slow sibling. Without this branch the
    // candidate falls through to the quota classification below, which labels
    // it FRESH_KNOWN/FRESH_UNKNOWN and lets it sort ahead of healthy accounts —
    // the "still hit a cooled-down account, never failed over" report. The raw
    // `reason` stays `"cooldown"` so `ELIGIBILITY_REASON_LABELS` and the
    // envelope `reasons` stream are untouched, and the reset deadline rides
    // along for the all-cooling 429 answer.
    if (eligibility.reason === "cooldown") {
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.COOLING,
          reason: "cooldown",
          ...(eligibility.cooldown_until !== undefined
            ? { cooldown_until: eligibility.cooldown_until }
            : {}),
        },
      };
    }
    // Unified engine: unknown quota is eligible but lower-rank than known-available.
    if (fact !== undefined) {
      if (fact.quotaState === "unknown") {
        return {
          candidate,
          decision: {
            eligible: true,
            rank: ROUTING_RANK.FRESH_UNKNOWN,
            reason: "quota_unknown",
          },
        };
      }
      return {
        candidate,
        decision: {
          eligible: true,
          rank: ROUTING_RANK.FRESH_KNOWN,
          reason: "healthy",
        },
      };
    }
    return {
      candidate,
      decision: {
        eligible: true,
        rank: ROUTING_RANK.FRESH_KNOWN,
        reason: "healthy",
      },
    };
  }

  /**
   * Rotates accounts within the same rank group only. The rank is the primary
   * sort key, so rotation can never float a cooling/saturated account ahead of
   * a fresh one — the old double-sort is gone by construction.
   */
  private applyProviderRoutingSorted(
    eligible: readonly RouteCandidate[],
    decisions: ReadonlyMap<RouteCandidate, RoutingDecision>,
    snapshot: RouteSnapshot,
    tid: string | null,
  ): RouteCandidate[] {
    return applyProviderRoutingSortedPlan(
      eligible,
      decisions,
      snapshot,
      tid,
      (key) => this.getProviderRoundRobin(key),
    );
  }

  /**
   * Applies continuation affinity as a hard pin (or a rebase pass-through).
   *
   * Returns a plan when the pinned account is present and eligible, `null`
   * when the continuation is rebaseable and the pin is empty (so the caller
   * continues with ordinary routing), and throws the strict 400 when the pin
   * is a hard constraint with no matching candidate.
   */
  private resolveContinuationPlan(
    affinity: RouteContinuationAffinity,
    matching: readonly RouteCandidate[],
    requestedModel: string,
    resolvedModel: string,
    snapshot: RouteSnapshot,
  ): RoutePlan | null {
    const pinned = matching.filter(
      (candidate) =>
        candidate.provider_id === affinity.providerId &&
        candidate.provider_account_id === affinity.providerAccountId,
    );
    if (pinned.length === 0) {
      if (affinity.rebaseable) return null;
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result belongs to a Cursor account that is no longer routable (request {requestId}). Reconnect the account, or resend the complete conversation. The session went cold — reconnect or resend 🔌",
        {
          providerId: affinity.providerId,
          accountId: affinity.providerAccountId,
        },
      );
    }
    // The pinned account owns the live session, so it is the only correct
    // target for this tool result — but health still applies. Forcing a
    // session whose account is hard-cooling (quota exhausted) reproduces the
    // refusal that cooled it, which is how "still hit a cooled-down account"
    // leaked through continuation affinity. Evaluate the pin before
    // returning: time-bounded cooling answers 429 with the real reset; an
    // account that is disabled/locked answers a clear 400.
    const pinnedDecisions = pinned.map((candidate) => this.eligibility.evaluate(candidate));
    const blocked = pinnedDecisions.find((decision) => !decision.eligible);
    if (blocked !== undefined) {
      // A rebaseable continuation (complete conversation replay) is not owed
      // to this account: the recorded exchange may travel as history to a
      // fresh Run on an eligible account. Cooling/blocked pinned account must
      // not turn that into a hard refusal — fall through to normal routing.
      if (affinity.rebaseable) return null;
      const reason = blocked.reason;
      if (
        reason === "cooldown_hard" ||
        reason === "model_cooldown" ||
        (reason === "quota_exhausted" && typeof blocked.cooldown_until === "number")
      ) {
        throw accountsRateLimitedError(requestedModel, resolvedModel, earliestResetMs(pinnedDecisions));
      }
      throw new GatewayError(
        "invalid_request",
        400,
        "This tool result belongs to an account that is no longer routable (request {requestId}). Reconnect the account, or resend the complete conversation. The session went cold — reconnect or resend 🔌",
        {
          providerId: affinity.providerId,
          accountId: affinity.providerAccountId,
        },
      );
    }
    const decisions = new Map<RouteCandidate, RoutingDecision>();
    for (const candidate of pinned) {
      const decision = pinnedDecisions.find((d) => d.candidate === candidate);
      decisions.set(candidate, {
        eligible: true,
        rank: ROUTING_RANK.FRESH_KNOWN,
        reason: "healthy",
        ...(decision?.cooldown_until !== undefined
          ? { cooldown_until: decision.cooldown_until }
          : {}),
      });
    }
    return {
      revision: snapshot.revision,
      candidates: pinned,
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      provider_id: pinned[0]!.provider_id,
      decisions,
    };
  }

  async plan(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tenantId?: string | null,
    requiredCapabilities?: readonly RequiredCapability[],
    allowCliMappings = false,
    keyId?: string,
    continuationAffinity?: RouteContinuationAffinity,
    sessionId?: string,
  ): Promise<RoutePlan> {
    const tid = tenantId ?? null;
    const { resolved, matching, unmatchedMembers } = this.resolveMatchingCandidates(
      requestedModel,
      snapshot,
      tid,
      allowCliMappings,
      keyId,
    );
    // Continuation affinity is applied first and absolutely.
    //
    // A request carrying a tool result for a provider session this process is
    // holding MUST reach the exact live account that owns that session. Routing
    // it anywhere else is not a degraded choice — it is a correctness failure:
    // the result would be written onto a different account's upstream turn
    // (corrupting both conversations and leaking the first account's context),
    // or into a fresh turn that never asked for the call. So the candidate set
    // is restricted before any health, cooling, or rotation logic runs, and an
    // empty result is a refusal rather than a fallback to normal routing.
    //
    // The one exception is a *rebaseable* continuation: when the conversation
    // is complete (every tool result is answered in the history) and the pinned
    // account is no longer routable for the requested model, the request may
    // fall through to normal routing so the adapter starts a fresh Run carrying
    // the recorded history. This is what makes model switches across accounts
    // work — see `resolveContinuationPlan` and `preparer.ts`.
    if (continuationAffinity !== undefined) {
      const continuationPlan = this.resolveContinuationPlan(
        continuationAffinity,
        matching,
        requestedModel,
        resolved.model,
        snapshot,
      );
      if (continuationPlan !== null) return continuationPlan;
    }
    // ── One evaluation pass ──────────────────────────────────────────────
    // Every filter that used to run as a separate pass (usage floor, slow lane,
    // health/cooldown eligibility, plan gate, capability) is merged into a
    // single per-candidate decision. `plan()` then sorts once by rank and
    // hands the full `decisions` map downstream, so no later layer re-derives
    // a competing ordering.
    //
    // Quota evidence is read in batch before the per-candidate pass: one
    // in-memory/Redis `MGET` per lens and one DB query for the accounts the
    // cache did not answer, instead of a serial round trip per candidate. The
    // per-candidate stamping below then consumes the shared maps, keeping the
    // live-cache-authoritative / snapshot-fallback semantics identical.
    const quotaCacheByAccount = new Map<string, CachedQuotaEntry>();
    const lensToAccounts = new Map<string, string[]>();
    for (const candidate of matching) {
      const accountId = candidate.provider_account_id;
      if (accountId === undefined) continue;
      const lens = quotaLens(candidate.tenant_id ?? tid);
      const accounts = lensToAccounts.get(lens);
      if (accounts === undefined) lensToAccounts.set(lens, [accountId]);
      else accounts.push(accountId);
    }
    for (const [lens, accountIds] of lensToAccounts) {
      const entries = await getCachedQuotaEntries(lens, accountIds, this.redis).catch(
        () => new Map<string, CachedQuotaEntry>(),
      );
      for (const [accountId, entry] of entries) quotaCacheByAccount.set(accountId, entry);
    }
    const snapshotByAccount = new Map<string, ProviderQuotaResultSnapshot>();
    if (this.db !== undefined) {
      const needingSnapshot = matching
        .map((candidate) => candidate.provider_account_id)
        .filter((accountId): accountId is string => accountId !== undefined && !quotaCacheByAccount.has(accountId));
      if (needingSnapshot.length > 0) {
        const snaps = await readQuotaSnapshots(this.db, needingSnapshot).catch(
          () => new Map<string, ProviderQuotaResultSnapshot>(),
        );
        for (const [accountId, snap] of snaps) snapshotByAccount.set(accountId, snap);
      }
    }
    const evaluations = matching.map((candidate) => {
      const stamped = this.applyUsageFloorToCandidate(
        candidate,
        snapshot,
        tid,
        quotaCacheByAccount,
        snapshotByAccount,
      );
      return this.evaluateCandidate(stamped, snapshot, tid, requiredCapabilities);
    });
    const decisions = new Map<RouteCandidate, RoutingDecision>();
    for (const evaluation of evaluations) {
      decisions.set(evaluation.candidate, evaluation.decision);
    }
    // Saturation is read once (inflight counters) and merged into the same
    // decision map rather than a second sort pass.
    const saturated = await this.saturatedCandidates(matching);
    for (const candidate of saturated) {
      const existing = decisions.get(candidate);
      if (existing !== undefined) {
        decisions.set(candidate, {
          ...existing,
          eligible: existing.eligible,
          rank: ROUTING_RANK.SATURATED,
          saturated: true,
        });
      }
    }
    let eligible = evaluations
      .map((evaluation) => evaluation.candidate)
      .filter((candidate) => decisions.get(candidate)?.eligible === true);

    if (eligible.length === 0) {
      // Time-bounded exclusions answer 429, not 503. See the long comment that
      // used to live here: cooldown/floor exclusions with a stated reset are
      // "not until then", not "down". Only a floor with no stated reset stays
      // 503.
      const rateLimited = [...decisions.values()].some(
        (d) =>
          d.reason === "cooldown_hard" ||
          d.reason === "model_cooldown" ||
          (d.reason === "quota_exhausted" && typeof d.cooldown_until === "number"),
      );
      if (rateLimited) {
        throw accountsRateLimitedError(
          requestedModel,
          resolved.model,
          earliestResetMs([...decisions.values()]),
        );
      }
      if (unmatchedMembers.length > 0) {
        log.warn("[routing] combo members without routable candidates", {
          requested: requestedModel,
          routed: resolved.model,
          unmatched: [...new Set(unmatchedMembers)].sort(),
        });
      }
      throw accountsUnavailableError(requestedModel, [...decisions.values()].map((d) => d.reason));
    }

    // Every eligible candidate cooling and no healthy/slow sibling → 429.
    const healthyCount = [...decisions.values()].filter(
      (d) =>
        d.eligible &&
        (d.reason === "healthy" || d.reason === "slow" || d.reason === "quota_unknown"),
    ).length;
    if (healthyCount === 0) {
      throw accountsRateLimitedError(
        requestedModel,
        resolved.model,
        earliestResetMs([...decisions.values()]),
      );
    }

    // Single sort by rank (fresh → slow → cooling → saturated), stable. Within
    // the same rank, ordered by credit → reserve → hot-window guard → measured
    // usage → drain → round-robin. The drain score chases quota about to expire
    // unused; reserve yields to non-reserve siblings; a hot primary window (≥85%
    // used) defers to cooler accounts so overflow lands on a cool sibling.
    const reservePct = accountReservePct();
    const stickyWarmMs = routingStickyWarmMs();
    const stickyEntry = stickyWarmMs > 0 ? this.sticky.get(eligible[0]?.provider_id ?? "", sessionId) : undefined;
    const stickyAccountId = stickyEntry?.accountId;
    const stickyWarm = stickyEntry !== undefined && Date.now() - stickyEntry.lastUsedAtMs < stickyWarmMs;
    const stickyExplicit = stickyEntry?.explicit === true;
    // Every key the comparator reads is computed once per candidate. The sort
    // runs O(n log n) comparisons; recomputing reserve/hot/credit/drain inside
    // the comparator re-scanned each candidate's quota windows per comparison.
    const keyed = eligible.map((candidate) => ({
      candidate,
      rank: decisions.get(candidate)?.rank ?? ROUTING_RANK.FRESH_KNOWN,
      sticky: candidate.provider_account_id === stickyAccountId,
      freeTier: candidate.free_tier === true,
      reserve:
        (candidate as RoutedCandidate).in_reserve ??
        isInReserve(candidate.quota_windows, reservePct),
      priority: (candidate as RoutedCandidate).account_priority ?? 0,
      hot: hotWindow(candidate.quota_windows),
      credit: creditPriority(candidate),
      drain: (candidate as RoutedCandidate).drain_score ?? 0,
    }));
    keyed.sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      // A free-tier model routes to any account: skip every quota-derived
      // preference (credit, reserve, hot-window, drain) so the original order
      // is preserved. Sticky warm pins still apply — they are about prompt
      // cache warmth, not quota.
      // Sticky warm pin: within the warm window the account that last served
      // this session wins outright (explicit pins always win). When neither
      // applies the comparison falls through to the quota preferences.
      if (left.sticky !== right.sticky && (stickyExplicit || stickyWarm)) {
        return left.sticky ? -1 : 1;
      }
      if (left.freeTier && right.freeTier) return 0;
      if (left.reserve !== right.reserve) return left.reserve ? 1 : -1;
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.hot !== right.hot) return left.hot ? 1 : -1;
      const credit = right.credit - left.credit;
      if (credit !== 0) return credit;
      if (left.drain !== right.drain) return right.drain - left.drain;
      return 0;
    });
    eligible = keyed.map((entry) => entry.candidate);

    // Provider routing rotates accounts within the same rank group only; it can
    // never float a cooling/saturated account ahead of a fresh one because the
    // rank is the primary key of the sort.
    eligible = this.applyProviderRoutingSorted(eligible, decisions, snapshot, tid);

    const chosen = eligible[0]!;
    // Record which account served this session so a follow-up request within the
    // warm window can prefer it (prompt-cache warmth). Explicit operator pins are
    // recorded as explicit so they win even past the warm window.
    if (sessionId !== undefined && chosen.provider_account_id !== undefined) {
      const explicitPin = continuationAffinity?.providerAccountId === chosen.provider_account_id;
      this.sticky.set(chosen.provider_id, sessionId, chosen.provider_account_id, explicitPin);
    }
    return {
      revision: snapshot.revision,
      candidates: eligible,
      requested_model: requestedModel,
      resolved_model: resolved.model,
      provider_id: chosen.provider_id,
      decisions,
    };
  }

  /**
   * Resolves the requested name to a bare target, expands a combo into its
   * member models, and returns the candidates serving them in plan order.
   *
   * Both alias resolution and the ambiguity check judge the *resolved* bare
   * target, never the originally requested name: an alias resolving to a bare
   * model that multiple providers serve must be rejected exactly like
   * requesting that bare model directly, so resolving through an alias is
   * never a silent way to bypass ambiguity protection.
   */
  private resolveMatchingCandidates(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tid: string | null,
    allowCliMappings: boolean,
    keyId?: string,
  ): {
    resolved: ReturnType<typeof resolveAlias>;
    combo: ComboDefinition | undefined;
    matching: RouteCandidate[];
    /** Combo members that matched zero candidates — misconfigured or
     * connection-less members the operator should fix, surfaced on errors
     * instead of failing opaquely on whichever member happened to route. */
    unmatchedMembers: readonly string[];
  } {
    const safeResolve = (name: string) => {
      try {
        return resolveAlias(name, snapshot, tid, allowCliMappings, keyId);
      } catch {
        throw modelNotFoundError(requestedModel);
      }
    };
    const resolved = safeResolve(requestedModel);
    const comboMap = tid ? snapshot.combos[tid] : undefined;
    const combo = comboMap?.[resolved.model];
    // Combo members may themselves be aliases or combos (an alias may target
    // a combo, and a combo may nest another combo). Resolve recursively with
    // the same depth bound as the alias walk so a member that names a combo
    // expands to its models instead of matching no candidate and reading as
    // "model not found" for a route the operator actually defined.
    const expandMember = (name: string, seen: ReadonlySet<string>): readonly string[] => {
      if (seen.has(name) || seen.size >= 16) return [];
      const next = new Set(seen).add(name);
      const alias = safeResolve(name);
      const nested = comboMap?.[alias.model];
      if (!nested) return [alias.model];
      return nested.members.flatMap((member) => expandMember(member, next));
    };
    const rawModelIds = combo
      ? combo.members.flatMap((name) => expandMember(name, new Set([resolved.model])))
      : [resolved.model];
    const modelIds = [...new Set(rawModelIds)];
    // One index build per snapshot (cached on the immutable snapshot), one
    // lookup per unique resolved model. The previous shape rescanned every
    // candidate per model — O(C×K) string parses per plan — which was the
    // quadratic cost the catalog rebuild had already paid once and the request
    // path was paying again on every plan.
    const index = routeCandidateIndex(snapshot);
    const parsedModels = modelIds.map((id) => ({ id, parsed: parseModelReference(id) }));
    let matching = parsedModels.flatMap((entry) => lookupRouteCandidates(index, entry.parsed, tid));
    // Preserve the resolver's flatten-then-dedupe contract: one candidate can
    // serve two member groups only via a combo listing the same model twice,
    // and the plan must not dial it twice.
    matching = [...new Set(matching)];
    let unmatchedMembers: readonly string[] = [];
    if (combo) {
      const perId = parsedModels.map((entry) => ({
        id: entry.id,
        group: lookupRouteCandidates(index, entry.parsed, tid),
      }));
      unmatchedMembers = perId.filter((entry) => entry.group.length === 0).map((entry) => entry.id);
      const groups = perId.map((entry) => entry.group).filter((g) => g.length > 0);
      if (combo.strategy === "round_robin" && groups.length > 1) {
        const heads = groups.map((g) => g[0] as RouteCandidate);
        const rr = this.getRoundRobin(`${tid}::${resolved.model}`);
        const chosen = rr.next(heads, 1);
        const startIndex = chosen ? heads.indexOf(chosen) : 0;
        matching = [...groups.slice(startIndex), ...groups.slice(0, startIndex)].flat();
      } else {
        matching = groups.flat();
      }
    }
    if (matching.length === 0) {
      // A qualified `provider/model` reference whose model is not in the
      // catalog still routes: clone the provider's first live candidate (any
      // model) and retarget it at the requested model. This is the passthrough
      // contract — a provider that accepts arbitrary model ids (BYOK, custom
      // gateways, or a model the catalog has not fetched yet) must be able to
      // serve them. The clone inherits the provider's endpoint, wire family,
      // dialect, capabilities, tenant scoping and account/network-pool wiring;
      // only the model id changes. A provider with zero candidates cannot be
      // synthesized, so bare-model misses and empty providers still 404.
      if (parsedModels.length === 1 && parsedModels[0]!.parsed.providerId !== null) {
        const providerId = parsedModels[0]!.parsed.providerId;
        const sibling = [...index.qualified.entries()]
          .filter(([key]) => key.startsWith(`${providerId}/`))
          .flatMap(([, group]) => group)
          .find((candidate) => candidate.tenant_id == null || candidate.tenant_id === tid);
        if (sibling !== undefined) {
          matching = [{
            ...sibling,
            model_id: parsedModels[0]!.parsed.modelId,
          }];
        }
      }
      if (matching.length === 0) throw modelNotFoundError(requestedModel, modelIds);
    }
    const owners = [...new Set(matching.map((candidate) => candidate.provider_id))];
    if (owners.length > 1 && !resolved.model.includes("/") && !combo)
      throw ambiguousModelError(requestedModel, owners);
    return { resolved, combo, matching, unmatchedMembers };
  }

  async reserve(plan: RoutePlan): Promise<Reservation> {
    for (const candidate of plan.candidates) {
      const admitted = await this.admission.admit(candidate);
      if (admitted.admitted) return this.reservations.acquire(candidate, plan.revision);
    }
    // Last candidate's identity names the provider the plan was actually for;
    // every candidate shares it, so any one of them is representative.
    const last = plan.candidates[plan.candidates.length - 1];
    throw capacityExhaustedError({
      ...(last?.provider_id !== undefined ? { providerId: last.provider_id } : {}),
      ...(plan.resolved_model !== undefined ? { model: plan.resolved_model } : {}),
      candidateCount: plan.candidates.length,
      ...(last?.max_inflight !== undefined ? { maxInflight: last.max_inflight } : {}),
    });
  }
  async release(reservation: Reservation): Promise<void> {
    await this.admission.release(reservation);
    this.reservations.release(reservation.lease_id);
  }
}
