import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { decryptCredentialToString } from "../../src/security/crypto";
import { mintQoderGeneratedIdentity, qoderMachineHeaders } from "../../src/providers/integrations/qoder/qoder-umid";

const BASE = "https://openapi.qoder.sh";
const PROXY = process.argv[2] ?? "http://altaria.proxy.rlwy.net:12737";
const ONLY = process.argv[3];

// Load .env (CARTETHYIA_ENCRYPTION_KEY) tanpa nge-print.
for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const db = new Database("C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite", { readonly: true });
const rows = (
  db
    .query(
      `SELECT id, label, status, auth_state, credential_ciphertext
       FROM provider_accounts WHERE provider_id = 'qoder' ORDER BY created_at`,
    )
    .all() as Array<Record<string, unknown>>
).filter((r) => !ONLY || String(r.label) === ONLY);

console.log(`qoder accounts: ${rows.length} | proxy=${PROXY}\n`);

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

function classify(j: any): string {
  const status = String(j?.status ?? "").toUpperCase();
  const failure = String(j?.failureCode ?? "").toUpperCase();
  if (j?.success !== false && ["CLAIMED", "GRANTED", "SUCCESS"].includes(status)) return `✅ CLAIMED +${j?.benefit?.amount ?? 100}`;
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") return "⛔ SAME_PERSON";
  if (status === "CLAIMED") return "🔁 REPLAYED";
  return "❌ FAILED";
}

async function attempt(row: Record<string, unknown>) {
  const label = String(row.label);
  const credential = decryptCredentialToString(row.credential_ciphertext as Buffer);
  const identity = mintQoderGeneratedIdentity(String(row.id));
  const hash = createHash("sha256").update(identity.machineToken).digest("hex").slice(0, 10);

  const g = await fetch(`${BASE}/sash/api/v1/me/campaigns`, {
    method: "GET",
    headers: headersFor(credential, identity),
    proxy: PROXY,
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await g.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  const credits = (parsed?.campaigns ?? []).filter((c: any) => {
    const kind = String((c.benefit as any)?.kind ?? "");
    const action = String(c.actionType ?? "");
    return action === "CLAIM_BENEFIT" || kind === "CREDITS";
  });
  if (credits.length === 0) {
    console.log(`[${label}] GET ${g.status} → NO CREDITS (gen tok ${hash})`);
    return;
  }
  const credit = credits[0]!;
  const cStatus = String(credit.claimStatus ?? credit.claim_status ?? "").toUpperCase();
  const campaignId = String(credit.campaignId ?? "");
  console.log(`[${label}] GET ${g.status} → CREDITS ${credit.campaignKey} ${cStatus} (gen tok ${hash})`);
  if (cStatus !== "CLAIMABLE") return;

  const claim = await fetch(`${BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    headers: { ...headersFor(credential, identity), "Content-Type": "application/json" },
    body: "{}",
    proxy: PROXY,
    signal: AbortSignal.timeout(20_000),
  });
  const claimRaw = await claim.text();
  console.log(`[${label}] CLAIM HTTP ${claim.status}: ${classify(JSON.parse(claimRaw))} | ${claimRaw.slice(0, 180)}\n`);
}

for (const row of rows) {
  await attempt(row);
}
