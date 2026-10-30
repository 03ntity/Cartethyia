/**
 * Top-level keys must never be truncated away by their own share children.
 *
 * Child rows default to `sort_index = 0`, so an unbounded family (observed:
 * 331k children under one template) can crowd the `list()` 1000-row page and
 * hide the template that owns them — the share template above sort_index 0
 * vanished from the console while the default key (oldest row) survived.
 * `list()` orders parents first, so the console always sees its keys.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { getDb } from "../../src/persistence/boot";
import { dbDescribe, getTestPool } from "../helpers/database";

const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

let tenantId = "";
let defaultId = "";
let templateId = "";
let childId = "";

beforeAll(async () => {
  const pool = await getTestPool();
  const tenant = await pool.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`api-key-list-order-${randomUUID()}`, "active"],
  );
  tenantId = String(tenant.rows[0]!.id);
  defaultId = randomUUID();
  templateId = randomUUID();
  childId = randomUUID();
  await pool.query(
    `insert into api_keys
       (id, tenant_id, key_hash, key_mode, label, scopes, sort_index, enabled, is_default)
     values ($1, $2, $3, 'personal', 'Default Cartethyia API key',
             '["routing:invoke"]'::jsonb, 0, true, true)`,
    [defaultId, tenantId, hash(`default-${defaultId}`)],
  );
  await pool.query(
    `insert into api_keys
       (id, tenant_id, key_hash, key_mode, label, scopes, sort_index, enabled, is_default)
     values ($1, $2, NULL, 'share', 'Share template',
             '["routing:invoke"]'::jsonb, 1, true, false)`,
    [templateId, tenantId],
  );
  // Child mimics the production shape: sort_index 0 (column default), issued
  // client IP populated, hash set — the exact rows that used to crowd the
  // template out of the page.
  await pool.query(
    `insert into api_keys
       (id, tenant_id, key_hash, key_mode, label, scopes, parent_key_id,
        issued_client_ip, issued_client_ip_key, key_prefix, enabled, is_default)
     values ($1, $2, $3, 'share', 'child-1', '["routing:invoke"]'::jsonb,
             $4, '203.0.113.9', '203.0.113.9', 'cty-child', true, false)`,
    [childId, tenantId, hash(`child-${childId}`), templateId],
  );
});

afterAll(async () => {
  if (tenantId === "") return;
  const pool = await getTestPool();
  await pool.query("delete from tenants where id = $1", [tenantId]);
});

dbDescribe("api key list ordering", () => {
  test("parents sort before their share children", async () => {
    const store = new DrizzleApiKeyStore(getDb());
    const records = await store.list(tenantId);
    const ids = records.map((record) => record.id);
    // Both parents must be present even though the child shares sort_index 0
    // with the default key and the template has a higher sort_index.
    expect(ids).toContain(defaultId);
    expect(ids).toContain(templateId);
    expect(ids.indexOf(defaultId)).toBeLessThan(ids.indexOf(templateId));
    expect(ids.indexOf(templateId)).toBeLessThan(ids.indexOf(childId));
  });
});
