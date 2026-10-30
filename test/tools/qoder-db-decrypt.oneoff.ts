import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decryptCredentialToString } from "../../src/security/crypto";

// Load .env dari repo root (jangan print nilainya).
for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const db = new Database("C:/Users/Aria/AppData/Roaming/cartethyia/cartethyia.sqlite", { readonly: true });
const rows = db
  .query(
    `SELECT id, label, status, account_email, auth_state, credential_ciphertext, native_identity
     FROM provider_accounts WHERE provider_id = 'qoder' ORDER BY created_at`,
  )
  .all() as Array<Record<string, unknown>>;

console.log(`qoder rows: ${rows.length}\n`);
for (const r of rows) {
  const label = String(r.label);
  let cred = "";
  try {
    cred = decryptCredentialToString(r.credential_ciphertext as Buffer);
  } catch (e) {
    cred = `DECRYPT_ERR ${(e as Error).message}`;
  }
  const authState = typeof r.auth_state === "string" ? safeJson(r.auth_state) : (r.auth_state as object | null);
  console.log(`--- ${label} (${r.status}) ---`);
  console.log(`  email     : ${r.account_email ?? "-"}`);
  console.log(`  cred(head): ${cred.slice(0, 16)}… (len ${cred.length})`);
  console.log(`  cred kind : ${cred.startsWith("dt-") ? "device token" : cred.startsWith("drt-") ? "refresh" : cred.startsWith("{") ? "json" : "other"}`);
  if (authState && typeof authState === "object") {
    const a = authState as Record<string, unknown>;
    console.log(`  userId    : ${String(a.userId ?? a.user_id ?? "-").slice(0, 12)}…`);
    console.log(`  machineId : ${String(a.machineId ?? a.machine_id ?? "-")}`);
  }
  const native = r.native_identity ? safeJson(String(r.native_identity)) : null;
  console.log(`  native    : ${native ? JSON.stringify(native).slice(0, 120) : "none"}`);
  console.log("");
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
