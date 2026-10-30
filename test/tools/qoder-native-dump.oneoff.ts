import { mintQoderGeneratedIdentity, qoderMachineHeaders } from "../../src/providers/integrations/qoder/qoder-umid";

const BASE = "https://openapi.qoder.sh";
const jsonPath = process.argv[2]!;
const proxy = process.argv[3] || undefined;

const doc = JSON.parse(await Bun.file(jsonPath).text()) as {
  accounts: Array<{ id?: string; label: string; accessToken: string; refreshToken?: string; authState?: { userId?: string; machineId?: string } }>;
};

for (const account of doc.accounts) {
  const identity = mintQoderGeneratedIdentity(account.id ?? account.label);
  const res = await fetch(`${BASE}/sash/api/v1/me/campaigns`, {
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      Accept: "application/json",
      "User-Agent": "Qoder",
      "Cosy-ClientType": "10",
      "Cosy-Version": "1.1.64",
      ...qoderMachineHeaders(identity),
    },
    ...(proxy === undefined ? {} : { proxy }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  console.log(`\n=== ${account.label} — HTTP ${res.status} ===`);
  console.log(`showCampaign=${parsed?.showCampaign} claimable=${parsed?.claimable} count=${(parsed?.campaigns ?? []).length}`);
  for (const c of parsed?.campaigns ?? []) {
    console.log(`  ${c.campaignKey} | ${c.actionType} | ${c.claimStatus} | benefit=${JSON.stringify(c.benefit)}`);
  }
}
