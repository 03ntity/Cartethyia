-- Adds the `random` pool-group selection strategy. Postgres gets it via an
-- `ALTER TYPE ... ADD VALUE`; SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt with the widened enum check.

--> statement-breakpoint
CREATE TABLE "pool_routing_settings_v2" (
  "tenant_id" text NOT NULL,
  "strategy" text DEFAULT 'least_loaded' NOT NULL,
  "rotate_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "pool_routing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "pool_routing_settings_strategy_enum_check" CHECK ("strategy" IS NULL OR "strategy" IN ('least_loaded', 'round_robin', 'random')),
  CONSTRAINT "pool_routing_settings_tenant_id_pk" PRIMARY KEY ("tenant_id")
);
--> statement-breakpoint
INSERT INTO "pool_routing_settings_v2" ("tenant_id", "strategy", "rotate_count")
  SELECT "tenant_id", "strategy", "rotate_count" FROM "pool_routing_settings";
--> statement-breakpoint
DROP TABLE "pool_routing_settings";
--> statement-breakpoint
ALTER TABLE "pool_routing_settings_v2" RENAME TO "pool_routing_settings";
