-- Telemetry analytics: the console's read-side cutover to `telemetry_events`.
--
-- The durable, indexed SQL store already receives every event; the console
-- reader ignored it and scanned the raw JSONL window instead (the regression
-- this fixes). These changes make the SQL store the canonical analytics
-- source:
--
-- - `client_name`: the canonical `clientNameFromUserAgent()` result, stamped
--   at ingestion so client breakdowns group in SQL instead of in JavaScript
--   over every row in the window.
-- - `UNIQUE (tenant_id, request_id)`: the cross-process idempotency boundary.
--   One terminal event per request; probes mint their own request UUIDs.
--   `INSERT ... ON CONFLICT DO NOTHING` makes a retried drain or a
--   cross-process race converge to one row and one usage charge.
-- - Keyset pagination index `(tenant_id, created_at DESC, id DESC)`: the
--   `(tenant_id, created_at)` index it replaces cannot break ties
--   deterministically (created_at is second-resolution), so a cursor on
--   created_at alone could skip or repeat rows at a boundary.
-- - Status and api-key breakdown indexes: the Usage chart and per-key family
--   spend filter on exactly these columns; without them each query scans the
--   tenant's whole retained window.
--
-- No dimension indexes beyond these without measured query plans. No
-- `CREATE INDEX CONCURRENTLY`: the transactional runner cannot run it, and
-- this migration runs at startup with no traffic to serve concurrently with.

ALTER TABLE "telemetry_events"
  ADD COLUMN IF NOT EXISTS "client_name" text;

-- One terminal event per (tenant, request). Existing duplicates, if any,
-- cannot exist under the old writer (one row per request per tenant), but the
-- index creation is guarded defensively: a pre-existing violation would fail
-- startup loudly rather than silently double-charging.
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telemetry_events_tenant_request_uidx"
  ON "telemetry_events" ("tenant_id", "request_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "telemetry_events_tenant_created_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_created_id_idx"
  ON "telemetry_events" ("tenant_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_http_created_id_idx"
  ON "telemetry_events" ("tenant_id", "http_status", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_events_tenant_api_key_created_id_idx"
  ON "telemetry_events" ("tenant_id", "api_key_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telemetry_reconciliation_state" (
  "job_name" text PRIMARY KEY,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "file_name" text NOT NULL DEFAULT '',
  "byte_offset" bigint NOT NULL DEFAULT 0,
  "files_completed" bigint DEFAULT 0,
  "events_examined" bigint DEFAULT 0,
  "events_inserted" bigint DEFAULT 0,
  "conflicts" bigint DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "telemetry_reconciliation_state_offset_nonneg" CHECK ("byte_offset" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_files_nonneg" CHECK ("files_completed" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_examined_nonneg" CHECK ("events_examined" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_inserted_nonneg" CHECK ("events_inserted" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_conflicts_nonneg" CHECK ("conflicts" >= 0)
);

--> statement-breakpoint
-- Align the payload storage CHECK with the schema: the `jsonb-file` binary
-- header shape was fully retired (nothing reads or writes it; the reader
-- treats anything that is not a base64-gzip line as not-a-frame). The
-- baseline's two-value constraint drifted from schema.ts's single-value
-- constraint at the initial release and is reconciled here.
ALTER TABLE "telemetry_payloads"
  DROP CONSTRAINT IF EXISTS "telemetry_payloads_storage_check";
--> statement-breakpoint
ALTER TABLE "telemetry_payloads"
  ADD CONSTRAINT "telemetry_payloads_storage_check" CHECK ("storage" = 'jsonl-file');
