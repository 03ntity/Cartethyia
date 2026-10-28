/**
 * Qoder daily check-in: legacy sash status/claim, campaign fallback, and the
 * state it reports to the shared sweep ledger.
 */
import { expect, test } from "bun:test";
import {
  fetchQoderDailyCheckin,
  isQoderCheckinProvider,
} from "../../../src/providers/integrations/qoder/qoder-checkin";

const BASE = "https://openapi.qoder.sh";
const STATUS_URL = `${BASE}/sash/api/v1/me/daily-check-in/status`;
const CLAIM_URL = `${BASE}/sash/api/v1/me/daily-check-in/claim`;
const CAMPAIGNS_URL = `${BASE}/sash/api/v1/me/campaigns`;
const CAMPAIGN_CLAIM_URL = `${BASE}/sash/api/v1/me/campaigns/camp-1/claim`;

function statusBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "CLAIMABLE",
    currentStreakDays: 3,
    totalClaimDays: 10,
    rewardCredits: 100,
    totalRewardCredits: 1000,
    nextClaimAt: 0,
    lastClaimedAt: 0,
    rewardExpiresAt: 0,
    ...overrides,
  });
}

function fakeFetcher(routes: Array<{ url: string; method: string; status: number; body: string }>) {
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    const route = routes.find((r) => r.url === url && r.method === method);
    if (!route) return new Response("unexpected request", { status: 500 });
    return new Response(route.body, { status: route.status });
  };
  return { fetcher, calls };
}

test("isQoderCheckinProvider covers both realms", () => {
  expect(isQoderCheckinProvider("qoder")).toBe(true);
  expect(isQoderCheckinProvider("qodercn")).toBe(true);
  expect(isQoderCheckinProvider("cb")).toBe(false);
});

test("already claimed today short-circuits before any claim POST", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody({ status: "CLAIMED", lastClaimedAt: nowSec }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a1",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("already_claimed");
  expect(result.streakDays).toBe(3);
  expect(calls).toEqual([`GET ${STATUS_URL}`]);
});

test("claimable status claims and reports the 100 credit grant with streak", async () => {
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody() },
    { url: CLAIM_URL, method: "POST", status: 200, body: JSON.stringify({ success: true, status: "CLAIMED" }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a2",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("claimed");
  expect(result.credit).toBe(100);
  expect(result.streakDays).toBe(3);
  expect(calls).toEqual([`GET ${STATUS_URL}`, `POST ${CLAIM_URL}`]);
});

test("a 409 from the claim resolves to already_claimed", async () => {
  const { fetcher } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 200, body: statusBody() },
    { url: CLAIM_URL, method: "POST", status: 409, body: JSON.stringify({ error: "ALREADY_CLAIMED" }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a3",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("already_claimed");
});

test("legacy 404 falls back to the CREDITS campaign claim", async () => {
  const campaignList = JSON.stringify({
    campaigns: [
      {
        campaign_id: "camp-1",
        campaign_key: "daily-credits",
        claim_status: "CLAIMABLE",
        action_type: "CLAIM_BENEFIT",
        benefit: { kind: "CREDITS", amount: 100 },
      },
    ],
  });
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 404, body: "" },
    { url: CAMPAIGNS_URL, method: "GET", status: 200, body: campaignList },
    { url: CAMPAIGN_CLAIM_URL, method: "POST", status: 200, body: JSON.stringify({ status: "CLAIMED", benefit: { amount: 100 } }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a4",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("claimed");
  expect(result.credit).toBe(100);
  expect(calls).toContain(`POST ${CAMPAIGN_CLAIM_URL}`);
});

test("legacy 404 with no claimable campaign reports unavailable", async () => {
  const { fetcher } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 404, body: "" },
    { url: CAMPAIGNS_URL, method: "GET", status: 200, body: JSON.stringify({ campaigns: [] }) },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a5",
    credential: "tok",
    fetcher,
  });
  expect(result.state).toBe("unavailable");
});

test("a rejected credential errors without touching the claim path", async () => {
  const { fetcher, calls } = fakeFetcher([
    { url: STATUS_URL, method: "GET", status: 401, body: "" },
  ]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a6",
    credential: "bad",
    fetcher,
  });
  expect(result.state).toBe("error");
  expect(calls).toEqual([`GET ${STATUS_URL}`]);
});

test("missing credential fails closed", async () => {
  const { fetcher } = fakeFetcher([]);
  const result = await fetchQoderDailyCheckin({
    providerId: "qoder",
    accountId: "a7",
    credential: "",
    fetcher,
  });
  expect(result.state).toBe("error");
});
