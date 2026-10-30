-- Tenant-scoped system prompt injection (append/override).
--
-- Mirror of the Postgres migration; see that file for rationale.
CREATE TABLE IF NOT EXISTS "tenant_system_prompts" (
  "tenant_id"  TEXT PRIMARY KEY REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "global"     TEXT,
  "providers"  TEXT NOT NULL DEFAULT '{}',
  "models"     TEXT NOT NULL DEFAULT '{}',
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);
