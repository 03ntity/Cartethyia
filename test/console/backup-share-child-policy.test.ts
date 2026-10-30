/**
 * Restore must re-apply the share-child policy null-out.
 *
 * Migration 0029 clears the 11 nullable policy columns on children once at
 * boot, but restore inserts `api_keys` rows verbatim and does not re-run
 * numbered migrations. An old backup that still carries populated children
 * would therefore reintroduce the bloat unless `applyRestore` normalizes
 * them in the same transaction. These tests lock that post-restore
 * invariant — and that an already-NULL child still restores cleanly.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { BackupService } from "../../src/console/backup/service";
import { dbDescribe, getTestPool } from "../helpers/database";

const targetTenantIds: string[] = [];

afterEach(async () => {
  const db = getDb();
  for (const tenantId of targetTenantIds.splice(0)) {
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  }
});

function keyHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function shareFamilyPayload(options: {
  parentId: string;
  childId: string;
  parentHash: string;
  childHash: string;
  /** Pre-0029 shape: child carries copied policy columns. */
  populatedChild: boolean;
}) {
  const parent = {
    id: options.parentId,
    label: "share template",
    key_mode: "share",
    key_hash: null,
    parent_key_id: null,
    scopes: ["routing:invoke"],
    model_access_mode: "whitelist",
    notes_title: "Welcome",
    notes_subtitle: "Subtitle",
    notes_body: "Body",
    requests_per_minute: 60,
    daily_token_limit: 1000,
    monthly_token_limit: 10_000,
    lifetime_token_budget: 100_000,
    max_concurrent_requests: 4,
    model_prefix: "gpt-",
    model_list: ["gpt-4o"],
    client_router_denylist: ["blocked"],
    enabled: true,
    revoked_at: null,
  };
  const child = {
    id: options.childId,
    label: "child-1",
    key_mode: "share",
    key_hash: options.childHash,
    parent_key_id: options.parentId,
    issued_client_ip: "203.0.113.9",
    issued_client_ip_key: "203.0.113.9",
    key_prefix: "cty-child",
    scopes: ["routing:invoke"],
    model_access_mode: "whitelist",
    enabled: true,
    revoked_at: null,
    ...(options.populatedChild
      ? {
          notes_title: "Welcome",
          notes_subtitle: "Subtitle",
          notes_body: "Body",
          requests_per_minute: 60,
          daily_token_limit: 1000,
          monthly_token_limit: 10_000,
          lifetime_token_budget: 100_000,
          max_concurrent_requests: 4,
          model_prefix: "gpt-",
          model_list: ["gpt-4o"],
          client_router_denylist: ["blocked"],
        }
      : {
          notes_title: null,
          notes_subtitle: null,
          notes_body: null,
          requests_per_minute: null,
          daily_token_limit: null,
          monthly_token_limit: null,
          lifetime_token_budget: null,
          max_concurrent_requests: null,
          model_prefix: null,
          model_list: null,
          client_router_denylist: null,
        }),
  };
  return {
    app: "cartethyia",
    version: 1,
    exportedAt: new Date().toISOString(),
    sections: { config: { api_keys: [parent, child] } },
  };
}

async function childPolicyOf(childId: string) {
  const pool = await getTestPool();
  const result = await pool.query<{
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
    parent_key_id: string | null;
  }>(
    `select notes_title, notes_subtitle, notes_body, requests_per_minute,
            daily_token_limit, monthly_token_limit, lifetime_token_budget,
            max_concurrent_requests, model_prefix, model_list,
            client_router_denylist, model_access_mode, scopes, label,
            parent_key_id
       from api_keys where id = $1`,
    [childId],
  );
  return result.rows[0];
}

async function parentPolicyOf(parentId: string) {
  const pool = await getTestPool();
  const result = await pool.query<{ notes_title: string | null; model_list: unknown }>(
    `select notes_title, model_list from api_keys where id = $1`,
    [parentId],
  );
  return result.rows[0];
}

function expectChildPolicyNulled(child: NonNullable<Awaited<ReturnType<typeof childPolicyOf>>>) {
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
  expect(child.model_access_mode).toBe("whitelist");
  expect(child.scopes).toEqual(["routing:invoke"]);
  expect(child.label).toBe("child-1");
  expect(child.parent_key_id).not.toBeNull();
}

dbDescribe("backup restore — share child policy normalization", () => {
  test("restoring an old backup nulls populated child policy columns", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);

    const payload = shareFamilyPayload({
      parentId,
      childId,
      parentHash: keyHash(`parent-${parentId}`),
      childHash: keyHash(`child-${childId}`),
      populatedChild: true,
    });

    const service = new BackupService({ db: getDb(), verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);
    expect(result.restored["api_keys"]).toBe(2);

    const child = await childPolicyOf(childId);
    expect(child).toBeDefined();
    expectChildPolicyNulled(child!);

    // Parent template keeps its policy — only children are normalized.
    const parent = await parentPolicyOf(parentId);
    expect(parent?.notes_title).toBe("Welcome");
    expect(parent?.model_list).toEqual(["gpt-4o"]);
  });

  test("restoring a post-0029 backup keeps already-NULL child columns", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    const importingTenant = randomUUID();
    targetTenantIds.push(importingTenant);

    const payload = shareFamilyPayload({
      parentId,
      childId,
      parentHash: keyHash(`parent-null-${parentId}`),
      childHash: keyHash(`child-null-${childId}`),
      populatedChild: false,
    });

    const service = new BackupService({ db: getDb(), verifyPassword: async () => true });
    const result = await service.restore("pw", payload, importingTenant);
    expect(result.restored["api_keys"]).toBe(2);

    const child = await childPolicyOf(childId);
    expect(child).toBeDefined();
    expectChildPolicyNulled(child!);
  });
});
