/**
 * Shared Drizzle column helpers and the tenant root table.
 *
 * Every `schema-*.ts` group imports its column builders from here so the
 * tenant/timestamp/health shapes stay defined exactly once. `schema.ts`
 * re-exports only the names that were public before the split; the helpers
 * below stay package-private.
 */
import { sql } from "drizzle-orm";
import {
  check, customType, integer, pgEnum, pgTable, text, timestamp, uuid,
} from "drizzle-orm/pg-core";

const TENANT_STATUSES = ["active", "suspended", "deleted"] as const;
type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: text("status").$type<TenantStatus>().notNull(),
    // Intentionally inline (not createdAtColumn()): this root table is imported
    // by the helpers below; sharing the helper here would make a use-before-define.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("tenants_status_check", sql`${table.status} IN ('active', 'suspended', 'deleted')`),
  ],
);

// Canonical tenant/timestamp column definitions shared by every table.

export function tenantRefNullable() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefRequired() {
  return uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefPrimaryKey() {
  return uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantCascadeSetNull() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" });
}

export function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

export function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}

export function timestampColumns() {
  return { createdAt: createdAtColumn(), updatedAt: updatedAtColumn() };
}

/**
 * `bytea` column for encrypted credential ciphertext (application-layer
 * envelope encryption: the ciphertext stored here is opaque to the
 * database). Drizzle's pg-core does not ship a first-class `bytea`
 * builder, so this is the documented `customType` escape hatch (the same
 * DDL-shape escape-hatch principle applied to column-type gaps in the
 * ORM's builder).
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Shared three-state health machine for provider_accounts and network_pools —
// the account state machine is reused for network pools rather than
// inventing a second one.
//
// `degraded` was retired. It sat between "working" and "parked" and every
// consumer had to decide what it meant: routing treated it as a hard exclusion,
// the sweep treated it as recoverable, and the console showed it as a third
// badge — three readings of one value, and the operator reported the result as
// ambiguous. The two facts it mixed are now each stated by a value that means
// exactly one thing: a fault that clears on its own is `cooldown` (with a
// deadline the sweep honors), and a fault that needs an operator is `disabled`.
export const healthStatus = pgEnum("health_status", ["active", "cooldown", "disabled"]);

/**
 * The health state machine shared by `provider_accounts` and `network_pools`.
 * One definition, because the two tables are driven by the same transitions and
 * a column added to one of them by hand is how they drift.
 */
export function healthColumns() {
  return {
    status: healthStatus("status").notNull().default("active"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorCategory: text("last_error_category"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    lastRecoveredAt: timestamp("last_recovered_at", { withTimezone: true }),
  };
}
