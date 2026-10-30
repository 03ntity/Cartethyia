-- One-time row-data optimization for share children.
--
-- Every minted share child used to copy the template's policy columns
-- (notes, limits, model_list, denylist, …). Auth never reads those from the
-- child — it resolves `policy = parent ?? row` — so the copies were pure
-- write-amplification. This UPDATE nulls the 11 nullable policy columns on
-- every child (`parent_key_id IS NOT NULL`). `scopes` stays (NOT NULL, and
-- required by backup restore); `model_access_mode` stays (NOT NULL default
-- 'whitelist'). Schema shape is unchanged — no DROP COLUMN — so backup/
-- restore remains compatible both directions.
--
-- Idempotent: the OR-of-IS-NOT-NULL predicate matches nothing on a re-run,
-- and the migration ledger skips the file after the first apply.
--
-- Keep in sync with `normalizeShareChildPolicy` in
-- `src/console/backup/store.ts` (post-restore re-applies the same null-out
-- for a tenant, because restore does not re-run numbered migrations).

UPDATE "api_keys"
SET "notes_title" = NULL,
    "notes_subtitle" = NULL,
    "notes_body" = NULL,
    "requests_per_minute" = NULL,
    "daily_token_limit" = NULL,
    "monthly_token_limit" = NULL,
    "lifetime_token_budget" = NULL,
    "max_concurrent_requests" = NULL,
    "model_prefix" = NULL,
    "model_list" = NULL,
    "client_router_denylist" = NULL
WHERE "parent_key_id" IS NOT NULL
  AND ( "notes_title" IS NOT NULL OR "notes_subtitle" IS NOT NULL
        OR "notes_body" IS NOT NULL OR "requests_per_minute" IS NOT NULL
        OR "daily_token_limit" IS NOT NULL OR "monthly_token_limit" IS NOT NULL
        OR "lifetime_token_budget" IS NOT NULL
        OR "max_concurrent_requests" IS NOT NULL OR "model_prefix" IS NOT NULL
        OR "model_list" IS NOT NULL
        OR "client_router_denylist" IS NOT NULL );
