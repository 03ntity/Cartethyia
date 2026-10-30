/**
 * Bulk revoke by scope must span the whole family, not one page.
 *
 * The share modal's "Revoke all" / "Revoke no-usage" actions operate on every
 * matching recipient server-side, in bounded batches; these tests lock the
 * store method behind them.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { getDb } from "../../src/persistence/boot";
import { dbDescribe, getTestPool } from "../helpers/database";

const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

let tenantId = "";
let templateId = "";

beforeAll(async () => {
  const pool = await getTestPool();
  const tenant = await pool.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`api-key-shared-revoke-${randomUUID()}`, "active"],
  );
  tenantId = String(tenant.rows[0]!.id);
  templateId = randomUUID();
  await pool.query(
    `insert into api_keys
       (id, tenant_id, key_hash, key_mode, label, scopes, sort_index, enabled, is_default)
     values ($1, $2, NULL, 'share', 'Template', '["routing:invoke"]'::jsonb, 0, true, false)`,
    [templateId, tenantId],
  );
  const rows = [
    { label: "unused-active", consumed: 0, revoked: false },
    { label: "used-active", consumed: 42, revoked: false },
    { label: "revoked", consumed: 7, revoked: true },
  ];
  for (const row of rows) {
    const id = randomUUID();
    await pool.query(
      `insert into api_keys
         (id, tenant_id, key_hash, key_mode, label, scopes, parent_key_id,
          issued_client_ip, issued_client_ip_key, key_prefix, sort_index,
          enabled, is_default, lifetime_tokens_consumed, revoked_at)
       values ($1, $2, $3, 'share', $4, '["routing:invoke"]'::jsonb, $5,
               '203.0.113.9', '203.0.113.9', 'cty-' || $4, 0, true, false, $6, $7)`,
      [id, tenantId, hash(`child-${id}`), row.label, templateId, row.consumed, row.revoked ? new Date().toISOString() : null],
    );
  }
});

afterAll(async () => {
  if (tenantId === "") return;
  const pool = await getTestPool();
  await pool.query("delete from tenants where id = $1", [tenantId]);
});

dbDescribe("api key shared bulk revoke", () => {
  test("revoke active scope removes every non-revoked child", async () => {
    const store = new DrizzleApiKeyStore(getDb());
    const deleted = await store.revokeChildrenByScope(tenantId, templateId, "active");
    expect(deleted).toBe(2);
    const remaining = await store.listChildrenPage(tenantId, templateId, {
      limit: 50,
      offset: 0,
      sortBy: "createdAt",
      order: "asc",
      status: "all",
    });
    expect(remaining.total).toBe(1);
    expect(remaining.rows[0]?.label).toBe("revoked");
  });

  test("revoke unused scope only touches active children with zero consumption", async () => {
    const pool = await getTestPool();
    const templateId2 = randomUUID();
    await pool.query(
      `insert into api_keys
         (id, tenant_id, key_hash, key_mode, label, scopes, sort_index, enabled, is_default)
       values ($1, $2, NULL, 'share', 'Template2', '["routing:invoke"]'::jsonb, 0, true, false)`,
      [templateId2, tenantId],
    );
    const rows = [
      { label: "u1", consumed: 0, revoked: false },
      { label: "u2", consumed: 0, revoked: false },
      { label: "used", consumed: 5, revoked: false },
    ];
    for (const row of rows) {
      const id = randomUUID();
      await pool.query(
        `insert into api_keys
           (id, tenant_id, key_hash, key_mode, label, scopes, parent_key_id,
            issued_client_ip, issued_client_ip_key, key_prefix, sort_index,
            enabled, is_default, lifetime_tokens_consumed)
         values ($1, $2, $3, 'share', $4, '["routing:invoke"]'::jsonb, $5,
                 '203.0.113.9', '203.0.113.9', 'cty-' || $4, 0, true, false, $6)`,
        [id, tenantId, hash(`child-${id}`), row.label, templateId2, row.consumed],
      );
    }
    const store = new DrizzleApiKeyStore(getDb());
    const deleted = await store.revokeChildrenByScope(tenantId, templateId2, "unused");
    expect(deleted).toBe(2);
    const remaining = await store.listChildrenPage(tenantId, templateId2, {
      limit: 50,
      offset: 0,
      sortBy: "createdAt",
      order: "asc",
      status: "all",
    });
    expect(remaining.total).toBe(1);
    expect(remaining.rows[0]?.label).toBe("used");
  });
});
