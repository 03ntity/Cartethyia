/**
 * A share enrollment link must mint at most one child key per canonical client
 * IP.
 *
 * The public route `POST /share/:token/issue` creates a new child `api_keys`
 * row on every call. A bot behind one IP could therefore mint thousands of
 * keys by replaying the same enrollment URL — observed live: a 3-day backup
 * carried 331k `api_keys` rows, almost all mode `share`, minted from two
 * Google Cloud IPs (35.247.128.192, 35.194.181.114). This test locks the
 * contract the share page advertises: "one child key per canonical client IP".
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DrizzleShareLinkStore, hashShareToken } from "../../src/persistence/stores/share-store";
import { createShareRouter } from "../../src/console/share/share-router";
import { getDb } from "../../src/persistence/boot";
import { dbDescribe, getTestPool } from "../helpers/database";

let tenantId = "";
let parentKeyId = "";
let token = "";
let router: ReturnType<typeof createShareRouter>;

async function ensureTenant(): Promise<string> {
  if (tenantId !== "") return tenantId;
  const pool = await getTestPool();
  const result = await pool.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`share-issue-rl-${randomUUID()}`, "active"],
  );
  tenantId = String(result.rows[0]!.id);
  return tenantId;
}

beforeAll(async () => {
  const tid = await ensureTenant();
  const pool = await getTestPool();
  token = randomUUID().replace(/-/g, "").repeat(2).slice(0, 64);
  const key = await pool.query<{ id: string }>(
    `insert into api_keys
       (tenant_id, key_hash, key_mode, label, scopes, model_access_mode, enabled, revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      tid,
      null,
      "share",
      "share template",
      JSON.stringify(["routing:invoke"]),
      "whitelist",
      true,
      null,
    ],
  );
  parentKeyId = String(key.rows[0]!.id);
  await pool.query(
    `insert into share_links (api_key_id, token_hash, token_encrypted, kind, active, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [parentKeyId, hashShareToken(token), Buffer.from("ciphertext"), "enroll", true, null],
  );
  const store = new DrizzleShareLinkStore(getDb());
  router = createShareRouter({
    db: getDb(),
    shareStore: store,
    resolveClientIp: () => "35.247.128.192",
  });
});

afterAll(async () => {
  if (tenantId === "") return;
  const pool = await getTestPool();
  await pool.query("delete from tenants where id = $1", [tenantId]);
});

function issue(body = { nameHint: "bot" }): Promise<Response> {
  return router.handle(
    new Request(`https://x/share/${token}/issue`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

dbDescribe("share issue — one child key per canonical IP", () => {
  test("the same client IP cannot mint two child keys from one link", async () => {
    const first = await issue();
    expect(first.status).toBe(201);
    const second = await issue();
    // The second identical call must not mint another key; it should be
    // refused with a clear `already_issued` 409.
    expect(second.status).toBe(409);
    const payload = (await second.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("already_issued");

    const pool = await getTestPool();
    const rows = await pool.query<{ count: string }>(
      "select count(*)::int as count from api_keys where parent_key_id = $1 and revoked_at is null",
      [parentKeyId],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  test("a second IP mints its own child key from the same link", async () => {
    // Different canonical IP => a genuinely different recipient; the link must
    // still serve it. This guards the opposite regression: hardening must not
    // lock the whole link to one recipient.
    const differentRouter = createShareRouter({
      db: getDb(),
      shareStore: new DrizzleShareLinkStore(getDb()),
      resolveClientIp: () => "35.194.181.114",
    });
    const res = await differentRouter.handle(
      new Request(`https://x/share/${token}/issue`, {
        method: "POST",
        body: JSON.stringify({ nameHint: "other" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
  });
});
