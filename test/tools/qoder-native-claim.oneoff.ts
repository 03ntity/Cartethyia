/**
 * Qoder daily claim — FULL NATIVE generated mint.
 *
 * Identity is derived in-process (SHA-256 of the account id) — no WSL, no
 * bridge binary, no seed file, no registry reads. Import path goes through
 * Cartethyia's `mintQoderGeneratedIdentity` / `qoderMachineHeaders`.
 *
 * Usage:
 *   bun run qoder-native-claim.oneoff.ts <accounts.json> [proxy] [labelFilter]
 *
 * The account JSON keeps its tokens fresh: every successful refresh writes
 * both `accessToken` and `refreshToken` back to the file.
 */
import {
  mintQoderGeneratedIdentity,
  qoderMachineHeaders,
} from "../../src/providers/integrations/qoder/qoder-umid";

const BASE = "https://openapi.qoder.sh";

const jsonPath = process.argv[2] ?? "";
const proxy = process.argv[3] || undefined; // undefined = direct
const onlyLabel = process.argv[4];

if (!jsonPath) {
  console.log("usage: qoder-native-claim.oneoff.ts <accounts.json> [proxy] [labelFilter]");
  process.exit(1);
}

const doc = JSON.parse(await Bun.file(jsonPath).text()) as {
  accounts: Array<{
    id?: string;
    label: string;
    status?: string;
    accessToken: string;
    refreshToken?: string;
    authState?: { userId?: string; machineId?: string };
    lastClaimAt?: string;
    lastClaimAmount?: number;
    lastClaimCampaignKey?: string;
  }>;
};

const targets = doc.accounts.filter((a) => !onlyLabel || a.label === onlyLabel);
console.log(`native-claim: ${targets.length} akun | proxy=${proxy ?? "DIRECT"} | mint=generated (no WSL)\n`);

function headersFor(credential: string, identity: ReturnType<typeof mintQoderGeneratedIdentity>) {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "User-Agent": "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": "1.1.64",
    ...qoderMachineHeaders(identity),
  };
}

async function refresh(account: (typeof doc.accounts)[number], identity: ReturnType<typeof mintQoderGeneratedIdentity>): Promise<string | null> {
  if (!account.refreshToken) return null;
  try {
    const res = await fetch(`${BASE}/api/v1/deviceToken/refresh`, {
      method: "POST",
      headers: { ...headersFor("", identity), "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: account.refreshToken,
        machine_id: account.authState?.machineId ?? identity.machineToken,
        machine_token: identity.machineToken,
      }),
      ...(proxy === undefined ? {} : { proxy }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()) as Record<string, unknown>;
    const dt = String(j.device_token ?? "");
    if (!res.ok || !dt) return null;
    // Wajib persist: refresh memutar dua-duanya.
    account.accessToken = dt;
    if (j.refresh_token) account.refreshToken = String(j.refresh_token);
    await Bun.write(jsonPath, JSON.stringify(doc, null, 2));
    return dt;
  } catch {
    return null;
  }
}

function classify(j: any): "CLAIMED" | "SAME_PERSON" | "REPLAYED" | "FAILED" {
  const status = String(j?.status ?? "").toUpperCase();
  const failure = String(j?.failureCode ?? "").toUpperCase();
  if (j?.success !== false && ["CLAIMED", "GRANTED", "SUCCESS"].includes(status)) return "CLAIMED";
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") return "SAME_PERSON";
  if (status === "CLAIMED") return "REPLAYED";
  return "FAILED";
}

async function attempt(account: (typeof doc.accounts)[number]): Promise<void> {
  const identity = mintQoderGeneratedIdentity(account.id ?? account.label);

  let credential = account.accessToken;
  const fresh = await refresh(account, identity);
  if (fresh) credential = fresh;

  const g = await fetch(`${BASE}/sash/api/v1/me/campaigns`, {
    headers: headersFor(credential, identity),
    ...(proxy === undefined ? {} : { proxy }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await g.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }

  const credits = (parsed?.campaigns ?? []).filter((c: any) => {
    const kind = String(c.benefit?.kind ?? "");
    const action = String(c.actionType ?? "");
    return action === "CLAIM_BENEFIT" || kind === "CREDITS";
  });

  if (credits.length === 0) {
    console.log(`[${account.label}] GET ${g.status} → NO CREDITS`);
    return;
  }
  const credit = credits[0]!;
  const cStatus = String(credit.claimStatus ?? "").toUpperCase();
  const campaignId = String(credit.campaignId ?? "");
  console.log(`[${account.label}] GET ${g.status} → ${credit.campaignKey} ${cStatus}`);

  if (cStatus === "CLAIMED") {
    account.lastClaimCampaignKey = String(credit.campaignKey ?? "");
    if (!account.lastClaimAt) {
      account.lastClaimAt = new Date().toISOString();
      account.lastClaimAmount = 100;
    }
    await Bun.write(jsonPath, JSON.stringify(doc, null, 2));
    console.log(`[${account.label}] sudah claimed di window ini (idempoten)`);
    return;
  }
  if (cStatus !== "CLAIMABLE") return;

  const claimRes = await fetch(`${BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    headers: { ...headersFor(credential, identity), "Content-Type": "application/json" },
    body: "{}",
    ...(proxy === undefined ? {} : { proxy }),
    signal: AbortSignal.timeout(20_000),
  });
  const claimRaw = await claimRes.text();
  let j: any = null;
  try { j = JSON.parse(claimRaw); } catch { /* ignore */ }
  const verdict = classify(j);

  if (verdict === "CLAIMED") {
    account.lastClaimAt = new Date().toISOString();
    account.lastClaimAmount = j?.benefit?.amount ?? 100;
    account.lastClaimCampaignKey = String(j?.campaignKey ?? credit.campaignKey ?? "");
    await Bun.write(jsonPath, JSON.stringify(doc, null, 2));
    console.log(`[${account.label}] ✅ CLAIMED +${account.lastClaimAmount} (native gen, persisted)`);
  } else if (verdict === "SAME_PERSON") {
    account.lastClaimAt = new Date().toISOString();
    account.lastClaimAmount = 100;
    await Bun.write(jsonPath, JSON.stringify(doc, null, 2));
    console.log(`[${account.label}] ⛔ SAME_PERSON (sudah pernah claim)`);
  } else if (verdict === "REPLAYED") {
    console.log(`[${account.label}] 🔁 replayed (idempoten)`);
  } else {
    console.log(`[${account.label}] ❌ CLAIM HTTP ${claimRes.status}: ${claimRaw.slice(0, 160)}`);
  }
}

for (const account of targets) {
  await attempt(account);
}
