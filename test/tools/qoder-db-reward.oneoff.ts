import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decryptCredentialToString } from "../../src/security/crypto";
import { mintQoderGeneratedIdentity, qoderMachineHeaders } from "../../src/providers/integrations/qoder/qoder-umid";

const BASE = "https://openapi.qoder.sh";
const PROXY = process.argv[2] ?? "http://altaria.proxy.rlwy.net:12737";
const ONLY = process.argv[3];
const CAMPAIGN_ID = process.argv[4] ?? "01a17b49-45a0-78df-980b-e94c92dfe2a7";

for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const db = new Database("C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite", { readonly: true });
const rows = (
  db
    .query(
      `SELECT id, label, status, credential_ciphertext
       FROM provider_accounts WHERE provider_id = 'qoder' ORDER BY created_at`,
    )
    .all() as Array<Record<string, unknown>>
).filter((r) => !ONLY || String(r.label) === ONLY);

console.log(`reward probe: ${rows.length} akun | campaign=${CAMPAIGN_ID} | proxy=${PROXY}\n`);

async function probeReward(row: Record<string, unknown>) {
  const label = String(row.label);
  const credential = decryptCredentialToString(row.credential_ciphertext as Buffer);
  const identity = mintQoderGeneratedIdentity(String(row.id));
  const headers = {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "User-Agent": "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": "1.1.64",
    ...qoderMachineHeaders(identity),
  };
  const res = await fetch(`${BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(CAMPAIGN_ID)}/reward`, {
    method: "GET",
    headers,
    proxy: PROXY,
    signal: AbortSignal.timeout(20_000),
  });
  const raw = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
  console.log(`[${label}] reward=${res.status} ${raw}`);
}

for (const row of rows) {
  await probeReward(row);
}
