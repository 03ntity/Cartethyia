/**
 * Qoder daily check-in (streak / 100 Credits per day), ported from the
 * reference bridge (`qoder_accounts.py` in `qoder2api-hub`).
 *
 * Two upstream surfaces, tried in order:
 *
 * 1. Legacy sash: `GET /sash/api/v1/me/daily-check-in/status` then
 *    `POST /sash/api/v1/me/daily-check-in/claim`. The status exposes the
 *    streak (`currentStreakDays`) and the reward (`rewardCredits`, 100).
 * 2. Activity-platform campaign: when the legacy surface is absent (INTL often
 *    answers 404), `GET /sash/api/v1/me/campaigns` lists daily rewards and the
 *    CREDITS-kind claimable one is claimed via
 *    `POST /sash/api/v1/me/campaigns/{id}/claim`.
 *
 * The result shape is the same `DailyCheckinResult` the buddy family uses, so
 * the shared sweep slot ledger (`daily_checkin_ledger`), the log phrasing, and
 * the console surface treat Qoder like any other daily-grant provider.
 */
import { QODER_REALMS, qoderRealmForProvider } from "./qoder-realm";

/** Structural fetch bound; Bun's own fetch type carries extra host props. */
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import type { DailyCheckinResult, DailyCheckinState } from "../buddy/buddy-checkin";

export const QODER_CHECKIN_PROVIDER_IDS: readonly string[] = ["qoder", "qodercn"];

/** True when this provider id runs the Qoder check-in surface. */
export function isQoderCheckinProvider(providerId: string): boolean {
  return (QODER_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** Abort budget for one upstream check-in request. */
const TIMEOUT_MS = 15_000;

const CHECKIN_STATUS_PATH = "/sash/api/v1/me/daily-check-in/status";
const CHECKIN_CLAIM_PATH = "/sash/api/v1/me/daily-check-in/claim";
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
const CAMPAIGN_CLAIM_PATH = "/sash/api/v1/me/campaigns/%s/claim";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function baseOutcome(
  providerId: string,
  accountId: string,
): { providerId: string; accountId: string; credit: null; streakDays: null; error: null } {
  return { providerId, accountId, credit: null, streakDays: null, error: null };
}

function asState(state: string, today: string, lastClaimedAt: unknown): { active: boolean; todayCheckedIn: boolean } {
  const status = state.toUpperCase();
  const active = status === "CLAIMABLE" || status === "CLAIMED";
  let claimedToday = false;
  if (status === "CLAIMED") {
    const stamp = asNumber(lastClaimedAt);
    if (stamp !== null) {
      const day = new Date(stamp * 1000).toISOString().slice(0, 10);
      claimedToday = day === today;
    }
  }
  return { active, todayCheckedIn: claimedToday };
}

/** GET campaign list; returns `null` when the surface is unreachable/unauthorized. */
async function fetchCampaigns(
  base: string,
  credential: string,
  fetcher: Fetcher,
): Promise<Record<string, unknown>[] | null> {
  try {
    const response = await fetcher(`${base}${CAMPAIGNS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const rec = asRecord(payload);
    const list = Array.isArray(rec?.["campaigns"]) ? rec!["campaigns"] : Array.isArray(payload) ? payload : null;
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

/**
 * Claims one campaign and returns the resulting state. Mirrors the donor's
 * `claim_campaign` idempotence handling: a 409 or `ALREADY_CLAIMED` body is
 * an already-claimed grant, `SAME_PERSON_ALREADY_CLAIMED`/`BLOCKED` is a
 * same-person block (not a failure of this account's day), and anything else
 * is an error.
 */
async function claimCampaign(
  base: string,
  campaignId: string,
  credential: string,
  fetcher: Fetcher,
): Promise<{ state: DailyCheckinState; amount: number }> {
  const url = base + CAMPAIGN_CLAIM_PATH.replace("%s", encodeURIComponent(campaignId));
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", amount: 0 };
  }
  const raw = await response.text().catch(() => "");
  const payload: unknown = raw ? safeParse(raw) : null;
  const rec = asRecord(payload);
  const status = String(rec?.["status"] ?? "").toUpperCase();
  const failure = String(rec?.["failureCode"] ?? "").toUpperCase();
  const success = rec?.["success"] !== false;
  const benefit = asRecord(rec?.["benefit"]);
  const amount = asNumber(rec?.["amount"] ?? benefit?.["amount"]) ?? 0;
  if (response.status === 409 || failure === "ALREADY_CLAIMED" || status === "CLAIMED" && failure === "REPLAYED") {
    return { state: "already_claimed", amount };
  }
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") {
    return { state: "not_eligible", amount: 0 };
  }
  if (response.ok && success && (status === "CLAIMED" || status === "GRANTED" || status === "SUCCESS")) {
    return { state: "claimed", amount };
  }
  return { state: "error", amount: 0 };
}

/** Legacy sash status + claim. Returns `null` when the surface is absent (404/405/410). */
async function legacySashCheckin(args: {
  readonly base: string;
  readonly credential: string;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
}): Promise<{ state: DailyCheckinState; credit: number; streakDays: number } | null> {
  const { base, credential, fetcher } = args;
  const today = (args.now?.() ?? new Date()).toISOString().slice(0, 10);
  let statusResponse: Response;
  try {
    statusResponse = await fetcher(`${base}${CHECKIN_STATUS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  if (statusResponse.status === 401 || statusResponse.status === 403) {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  if (statusResponse.status === 404 || statusResponse.status === 405 || statusResponse.status === 410) {
    return null; // surface absent — caller falls back to campaign
  }
  if (!statusResponse.ok) {
    return { state: "error", credit: 0, streakDays: 0 };
  }
  const payload: unknown = await statusResponse.json().catch(() => null);
  const rec = asRecord(payload);
  if (!rec) return { state: "error", credit: 0, streakDays: 0 };
  const { active, todayCheckedIn } = asState(String(rec["status"] ?? ""), today, rec["lastClaimedAt"]);
  const streakDays = asNumber(rec["currentStreakDays"]) ?? 0;
  const credit = asNumber(rec["rewardCredits"]) ?? 100;
  if (todayCheckedIn) return { state: "already_claimed", credit: 0, streakDays };
  if (!active) return { state: "not_eligible", credit: 0, streakDays };
  // Claim.
  let claimResponse: Response;
  try {
    claimResponse = await fetcher(`${base}${CHECKIN_CLAIM_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { state: "error", credit: 0, streakDays };
  }
  const raw = await claimResponse.text().catch(() => "");
  const lower = raw.toLowerCase();
  if (claimResponse.status === 409 || lower.includes("already_claimed") || lower.includes("已签到")) {
    return { state: "already_claimed", credit: 0, streakDays };
  }
  const body: unknown = raw ? safeParse(raw) : null;
  const bodyRec = asRecord(body);
  const ok = claimResponse.ok && bodyRec?.["success"] !== false;
  if (!ok) return { state: "error", credit: 0, streakDays };
  return { state: "claimed", credit, streakDays };
}

/**
 * Performs one account's Qoder daily check-in: legacy sash first, campaign
 * fallback when the sash surface is absent. Returns the same
 * `DailyCheckinResult` shape the shared sweep consumes.
 */
export async function fetchQoderDailyCheckin(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
}): Promise<DailyCheckinResult> {
  const { providerId, accountId, credential, fetcher } = args;
  const baseResult = baseOutcome(providerId, accountId);
  if (!credential) {
    return { ...baseResult, state: "error", error: "Account has no stored credential." };
  }
  const realm = qoderRealmForProvider(providerId);
  const base = QODER_REALMS[realm].openapi;

  const sash = await legacySashCheckin({
    base,
    credential,
    fetcher,
    ...(args.now === undefined ? {} : { now: args.now }),
  });
  if (sash !== null) {
    return {
      ...baseResult,
      state: sash.state,
      credit: sash.state === "claimed" ? sash.credit : null,
      streakDays: sash.streakDays,
      ...(sash.state === "error" ? { error: "Upstream daily check-in failed." } : {}),
    };
  }

  // Legacy surface absent: campaign fallback.
  const campaigns = await fetchCampaigns(base, credential, fetcher);
  if (campaigns === null) {
    return { ...baseResult, state: "error", error: "Check-in surface unavailable (legacy 404 and campaign list failed)." };
  }
  let alreadySeen = false;
  for (const campaign of campaigns) {
    const rec = asRecord(campaign);
    if (!rec) continue;
    const benefit = asRecord(rec["benefit"]);
    const kind = String(benefit?.["kind"] ?? "").toUpperCase();
    if (kind !== "CREDITS" && kind !== "") continue;
    const actionType = String(rec["action_type"] ?? "");
    if (actionType !== "" && actionType !== "CLAIM_BENEFIT") continue;
    const claimStatus = String(rec["claim_status"] ?? "").toUpperCase();
    if (claimStatus === "CLAIMED") {
      alreadySeen = true;
      continue;
    }
    if (claimStatus !== "CLAIMABLE") continue;
    const campaignId = String(rec["campaign_id"] ?? "");
    if (!campaignId) continue;
    const result = await claimCampaign(base, campaignId, credential, fetcher);
    if (result.state === "claimed") {
      const amount = asNumber(benefit?.["amount"]) ?? result.amount;
      return { ...baseResult, state: "claimed", credit: amount, streakDays: null };
    }
    if (result.state === "already_claimed") {
      alreadySeen = true;
      continue;
    }
    if (result.state === "error") {
      return { ...baseResult, state: "error", error: "Campaign claim failed." };
    }
    // not_eligible (same-person block): stop trying further campaigns.
    return { ...baseResult, state: "not_eligible", error: "Same-person claim already used today." };
  }
  return {
    ...baseResult,
    state: alreadySeen ? "already_claimed" : "unavailable",
    error: alreadySeen ? null : "No daily CREDITS campaign claimable.",
  };
}
