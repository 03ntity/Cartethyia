-- Tenant-scoped system prompt injection (append/override).
--
-- Resolution is most-specific-wins: model > provider > global. A provider
-- either follows the tenant's global prompt (`providers` entry
-- followGlobal = true, its own setting is ignored) or carries a custom one.
-- Text is capped at 5 MB per scope in the console route; the dispatch-path
-- reader is revision-keyed cached, so a mutation converges within the
-- settings-revision bump. `global` NULL means never configured — distinct
-- from an explicit `{"enabled": false}` row.
CREATE TABLE IF NOT EXISTS "tenant_system_prompts" (
  "tenant_id"  uuid PRIMARY KEY REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "global"     jsonb,
  "providers"  jsonb NOT NULL DEFAULT '{}',
  "models"     jsonb NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
