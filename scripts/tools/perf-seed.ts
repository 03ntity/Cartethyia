/**
 * Seeds one routable tenant into the perf database and prints what the load
 * script needs.
 *
 * Deliberately does not import `test/helpers/database`: that module registers a
 * `bun:test` `afterAll` at import time, so using it outside the test runner
 * throws. The inserts below mirror the fixture helpers, including the real
 * `encryptCredential`/`hashSecret` the console uses.
 *
 * The upstream is never dialed — the provider's base URL is an unroutable name,
 * so the attempt fails fast. That is the point: the number we measure is the
 * gateway's own work (auth, routing, admission, lease, telemetry, release),
 * which is exactly the part under investigation.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { encryptCredential, hashSecret } from "../../src/security/crypto";

const url = process.env.CARTETHYIA_PERF_DATABASE_URL ?? "postgres://postgres@localhost:5432/cartethyia_perf";
const runId = `perf-${randomUUID().slice(0, 8)}`;

const pool = new pg.Pool({ connectionString: url, max: 2 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const tenant = await client.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`tenant-${runId}`, "active"],
  );
  const tenantId = tenant.rows[0]!.id;

  const providerId = `tp-${runId}`;
  await client.query(
    `insert into providers (id, tenant_id, wire_family_default, base_url, enabled, requires_account)
     values ($1, $2, $3, $4, $5, $6)`,
    // Loopback stub upstream. `CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS=true` is set
    // by scripts/tools/perf-start.ts so the SSRF policy admits it. Owned by the
    // tenant because `retireUnbundledProviders` (boot) deletes tenantless
    // non-bundled providers. `requires_account = false` with no account row
    // skips the network-pool slot lease, whose default `max_inflight` of 10
    // would turn a 40-concurrency run into mostly 429s and measure the wrong
    // thing; admission, routing, telemetry, and release all still run.
    [providerId, tenantId, "chat", process.env.PERF_UPSTREAM ?? "http://127.0.0.1:9911", true, false],
  );

  const modelId = `perf-model-${runId}`;
  await client.query(
    `insert into models
       (provider_id, model_id, wire_family, service_kind, endpoint_path, enabled,
        context_limit, output_limit, tool_call, reasoning)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [providerId, modelId, "chat", "llm", "/v1/chat/completions", true, 128_000, 8_192, true, false],
  );

  const credential = `sk-perf-${randomUUID()}`;
  const account = await client.query<{ id: string }>(
    `insert into provider_accounts
       (provider_id, tenant_id, label, credential_ciphertext, credential_fingerprint,
        credential_kind, status, cooldown_until, last_error_category, sort_index)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      // Owned by the tenant: `listPublicModels` and the route catalog both
      // gate a model on an active account *for that tenant*, so a tenantless
      // account made the model invisible to the key.
      providerId,
      tenantId,
      "perf",
      encryptCredential(credential),
      hashSecret(credential),
      "api_key",
      "active",
      null,
      null,
      0,
    ],
  );

  // Admission ceilings raised for measurement. The defaults (network-pool
  // `max_inflight` 10, per-proxy limit 10) are exactly the concurrency this
  // harness drives, so without this every run measures the LIMITER rather than
  // the gateway — a run at concurrency 40 returns ~75% 503s that look like a
  // capacity defect and are not. Same reasoning as IP_RATE_MAX_PER_WINDOW in
  // perf-start.ts: a load-test knob, not a production default.
  await client.query(
    `insert into provider_routing_settings
       (provider_id, tenant_id, max_inflight, max_inflight_per_proxy)
     values ($1, $2, $3, $4)
     on conflict (provider_id, tenant_id)
       do update set max_inflight = excluded.max_inflight,
                     max_inflight_per_proxy = excluded.max_inflight_per_proxy`,
    [providerId, tenantId, 100_000, 100_000],
  );

  const token = `rk_perf_${randomUUID().replace(/-/g, "")}`;
  await client.query(
    `insert into api_keys
       (tenant_id, key_hash, key_mode, parent_key_id, issued_client_ip, label, scopes,
        requests_per_minute, daily_token_limit, monthly_token_limit, lifetime_token_budget,
        max_concurrent_requests, model_access_mode, model_list, client_router_denylist,
        revoked_at, is_default)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning id`,
    [
      tenantId,
      hashSecret(token),
      "personal",
      null,
      null,
      "perf",
      JSON.stringify([
        "routing:invoke",
        "routing:cli_mapping",
        "search:invoke",
        "dashboard:read",
        "dashboard:write",
        "providers:read",
        "providers:write",
        "models:read",
        "models:write",
      ]),
      null,
      null,
      null,
      null,
      null,
      "whitelist",
      JSON.stringify([modelId, `${providerId}/${modelId}`]),
      null,
      null,
      false,
    ],
  );

  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      runId,
      tenantId,
      providerId,
      modelId,
      accountId: account.rows[0]!.id,
      qualifiedModel: `${providerId}/${modelId}`,
      token,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end().catch(() => undefined);
}
