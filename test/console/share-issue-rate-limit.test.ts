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
  // Parent carries a full policy so the issue path's "do not copy" contract
  // is observable: a regression that re-copies would leave these non-NULL on
  // the child.
  const key = await pool.query<{ id: string }>(
    `insert into api_keys
       (tenant_id, key_hash, key_mode, label, scopes, model_access_mode,
        notes_title, notes_subtitle, notes_body, requests_per_minute,
        daily_token_limit, monthly_token_limit, lifetime_token_budget,
        max_concurrent_requests, model_prefix, model_list,
        client_router_denylist, enabled, revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16::jsonb, $17::jsonb, $18, $19) returning id`,
    [
      tid,
      null,
      "share",
      "share template",
      JSON.stringify(["routing:invoke"]),
      "whitelist",
      "Welcome",
      "Subtitle",
      "Body text",
      60,
      1000,
      10_000,
      100_000,
      4,
      "gpt-",
      JSON.stringify(["gpt-4o"]),
      JSON.stringify(["blocked-router"]),
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

  test("a template with a slot cap refuses once active children fill it", async () => {
    // Set a cap of 1 on the existing template; it already has live children.
    const pool = await getTestPool();
    await pool.query("update api_keys set max_children = 1 where id = $1", [parentKeyId]);

    const cappedRouter = createShareRouter({
      db: getDb(),
      shareStore: new DrizzleShareLinkStore(getDb()),
      resolveClientIp: () => "198.51.100.77",
    });
    const res = await cappedRouter.handle(
      new Request(`https://x/share/${token}/issue`, {
        method: "POST",
        body: JSON.stringify({ nameHint: "cap" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(429);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("template_slot_full");

    // Reset to unlimited so sibling tests are unaffected.
    await pool.query("update api_keys set max_children = null where id = $1", [parentKeyId]);
  });

  test("a minted child does not copy the template's policy columns", async () => {
    // Third IP so this mint is independent of the earlier rate-limit cases.
    const childRouter = createShareRouter({
      db: getDb(),
      shareStore: new DrizzleShareLinkStore(getDb()),
      resolveClientIp: () => "203.0.113.50",
    });
    const res = await childRouter.handle(
      new Request(`https://x/share/${token}/issue`, {
        method: "POST",
        body: JSON.stringify({ nameHint: "slim" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { keyId?: string };
    expect(typeof body.keyId).toBe("string");

    const pool = await getTestPool();
    const row = await pool.query<{
      notes_title: string | null;
      notes_subtitle: string | null;
      notes_body: string | null;
      requests_per_minute: number | null;
      daily_token_limit: number | null;
      monthly_token_limit: number | null;
      lifetime_token_budget: number | null;
      max_concurrent_requests: number | null;
      model_prefix: string | null;
      model_list: unknown;
      client_router_denylist: unknown;
      model_access_mode: string;
      scopes: unknown;
      label: string;
      parent_key_id: string;
    }>(
      `select notes_title, notes_subtitle, notes_body, requests_per_minute,
              daily_token_limit, monthly_token_limit, lifetime_token_budget,
              max_concurrent_requests, model_prefix, model_list,
              client_router_denylist, model_access_mode, scopes, label,
              parent_key_id
         from api_keys where id = $1`,
      [body.keyId],
    );
    const child = row.rows[0]!;
    expect(child.parent_key_id).toBe(parentKeyId);
    expect(child.notes_title).toBeNull();
    expect(child.notes_subtitle).toBeNull();
    expect(child.notes_body).toBeNull();
    expect(child.requests_per_minute).toBeNull();
    expect(child.daily_token_limit).toBeNull();
    expect(child.monthly_token_limit).toBeNull();
    expect(child.lifetime_token_budget).toBeNull();
    expect(child.max_concurrent_requests).toBeNull();
    expect(child.model_prefix).toBeNull();
    expect(child.model_list).toBeNull();
    expect(child.client_router_denylist).toBeNull();
    // NOT NULL default — never copied from parent, always the schema default.
    expect(child.model_access_mode).toBe("whitelist");
    // scopes stays populated (restore-required + NOT NULL).
    expect(child.scopes).toEqual(["routing:invoke"]);
    expect(child.label.length).toBeGreaterThan(0);
  });
});
