-- Adds telemetry analytics (Lite / SQLite) — see the identically named
-- PostgreSQL migration for why. Both backends must apply the same behavior;
-- SQLite stores `uuid` as text and `timestamptz` as text.
--
-- Idempotency comes from the migration ledger, not from the statement: the
-- runner records the file inside the same transaction, so a file that has
-- already run is never re-executed. The baseline is generated from
-- `0000_baseline.sql` alone and does not carry these changes.
--
-- NOTE: the runner already wraps each migration in a transaction, so this file
-- must NOT issue BEGIN/COMMIT.
ALTER TABLE "telemetry_events" ADD COLUMN "client_name" text;
--> statement-breakpoint
-- One terminal event per (tenant, request): the cross-process idempotency
-- boundary. SQLite has no "IF NOT EXISTS" for indexes; the migration ledger
-- guarantees single execution.
CREATE UNIQUE INDEX "telemetry_events_tenant_request_uidx" ON "telemetry_events" ("tenant_id", "request_id");
--> statement-breakpoint
DROP INDEX "telemetry_events_tenant_created_idx";
--> statement-breakpoint
-- Keyset pagination: (created_at, id) DESC breaks ties deterministically.
CREATE INDEX "telemetry_events_tenant_created_id_idx" ON "telemetry_events" ("tenant_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "telemetry_events_tenant_http_created_id_idx" ON "telemetry_events" ("tenant_id", "http_status", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "telemetry_events_tenant_api_key_created_id_idx" ON "telemetry_events" ("tenant_id", "api_key_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE "telemetry_reconciliation_state" (
  "job_name" text PRIMARY KEY,
  "lease_owner" text,
  "lease_expires_at" text,
  "file_name" text NOT NULL DEFAULT '',
  "byte_offset" integer NOT NULL DEFAULT 0,
  "files_completed" integer DEFAULT 0,
  "events_examined" integer DEFAULT 0,
  "events_inserted" integer DEFAULT 0,
  "conflicts" integer DEFAULT 0,
  "updated_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT "telemetry_reconciliation_state_offset_nonneg" CHECK ("byte_offset" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_files_nonneg" CHECK ("files_completed" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_examined_nonneg" CHECK ("events_examined" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_inserted_nonneg" CHECK ("events_inserted" >= 0),
  CONSTRAINT "telemetry_reconciliation_state_conflicts_nonneg" CHECK ("conflicts" >= 0)
);

--> statement-breakpoint
-- Align the payload storage CHECK with the schema (jsonb-file retired). A
-- table's CHECK cannot be altered in place in SQLite: rebuild and copy.
CREATE TABLE "telemetry_payloads_new" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "request_id" text,
  "captured_at" text NOT NULL,
  "expires_at" text NOT NULL,
  "storage" text NOT NULL,
  "file" text NOT NULL,
  "offset" integer NOT NULL,
  "length" integer NOT NULL,
  "checksum" text NOT NULL,
  "version" integer NOT NULL,
  "stages" integer DEFAULT 0,
  CONSTRAINT "telemetry_payloads_storage_check" CHECK ("storage" = 'jsonl-file')
);
--> statement-breakpoint
INSERT INTO "telemetry_payloads_new" SELECT "id", "tenant_id", "request_id", "captured_at", "expires_at", "storage", "file", "offset", "length", "checksum", "version", "stages" FROM "telemetry_payloads";
--> statement-breakpoint
DROP TABLE "telemetry_payloads";
--> statement-breakpoint
ALTER TABLE "telemetry_payloads_new" RENAME TO "telemetry_payloads";
