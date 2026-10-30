-- Denormalizes the share-template family onto every telemetry event.
--
-- The share page's family rollup used to scope by an `EXISTS` against
-- `api_keys` (the template plus every child it issued). That made history
-- depend on the key row surviving: revoking/removing a key silently dropped
-- its events out of the family totals. This column pins the template on the
-- event at write time, so usage outlives the key.
--
-- Backfill is idempotent: it only fills NULL rows (the column is new, so
-- every existing row is NULL) and never overwrites a value. Events whose key
-- was already hard-deleted before this migration cannot be attributed and stay
-- NULL; the soft-delete change shipped alongside this prevents future loss.

ALTER TABLE "telemetry_events" ADD COLUMN "family_template_key_id" text;

CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_family_created_id_idx"
  ON "telemetry_events" ("tenant_id", "family_template_key_id", "created_at" DESC, "id" DESC);

ALTER TABLE "telemetry_usage_totals" ADD COLUMN "family_template_key_id" text;

CREATE INDEX IF NOT EXISTS "telemetry_usage_totals_tenant_family_idx"
  ON "telemetry_usage_totals" ("tenant_id", "family_template_key_id");

UPDATE "telemetry_events" AS e
SET "family_template_key_id" = (
  SELECT COALESCE(k."parent_key_id", k."id")
  FROM "api_keys" k
  WHERE k."id" = e."api_key_id"
)
WHERE e."family_template_key_id" IS NULL AND e."api_key_id" IS NOT NULL;

UPDATE "telemetry_usage_totals" AS t
SET "family_template_key_id" = (
  SELECT COALESCE(k."parent_key_id", k."id")
  FROM "api_keys" k
  WHERE k."id" = t."entity_id"
)
WHERE t."family_template_key_id" IS NULL
  AND t."identity_type" = 'api_key'
  AND t."entity_id" IS NOT NULL;
