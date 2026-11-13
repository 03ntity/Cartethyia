/**
 * Canonical Drizzle schema: every persistence table, enum, index, and shared type.
 *
 * Aggregator only — the definitions live in the `schema-*.ts` group modules
 * so each table family can be read and edited without paging one 1700-line
 * file. `schema-shared.ts` holds the tenant/timestamp/health column helpers;
 * it is not re-exported wholesale because those helpers were never part of
 * this module's public surface.
 */
export { tenants, bytea, healthStatus } from "./schema-shared";
export * from "./schema-providers";
export * from "./schema-routing";
export * from "./schema-keys";
export * from "./schema-console";
export * from "./schema-telemetry";
export * from "./schema-ledgers";
