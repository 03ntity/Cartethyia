/**
 * Model aliases/combos and per-provider/per-pool routing settings.
 */
import { sql } from "drizzle-orm";
import {
  boolean, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { providers } from "./schema-providers";
import {
  tenantRefNullable, tenantRefPrimaryKey, tenantRefRequired, timestampColumns,
} from "./schema-shared";

// Model aliasing & combos. Aliases resolve a client-facing name to a
// real model; combos back a client-facing name with >=1 real models,
// auto-selected via `fallback` or `round_robin`.
export const modelComboStrategy = pgEnum("model_combo_strategy", [
  "fallback",
  "round_robin",
]);

/** Canonical `ComboStrategy` union, derived from the enum above. Console
 * domain and routing layers import this instead of hand-typing their own mirror.
 * `ProviderRoutingStrategy` covers the same two values but persists on
 * `provider_routing_settings` beside `rotateCount`. */
export type ComboStrategy = (typeof modelComboStrategy.enumValues)[number];

export const modelAliases = pgTable(
  "model_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    alias: text("alias").notNull(),
    targetModel: text("target_model").notNull(),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_aliases_tenant_alias_uidx").on(t.tenantId, t.alias)],
);
export type ModelAlias = typeof modelAliases.$inferSelect;

export const modelCombos = pgTable(
  "model_combos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    name: text("name").notNull(),
    members: jsonb("members").notNull().$type<string[]>(),
    strategy: modelComboStrategy("strategy").notNull().default("fallback"),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_combos_tenant_name_uidx").on(t.tenantId, t.name)],
);
export type ModelCombo = typeof modelCombos.$inferSelect;

export const providerRoutingStrategy = pgEnum("provider_routing_strategy", [
  "fallback",
  "round_robin",
]);

/**
 * Canonical provider-routing strategy union, derived from the enum above so
 * the persisted values and the type cannot drift. The console catalog and the
 * routing engine both import this instead of restating the two literals.
 */
export type ProviderRoutingStrategy = (typeof providerRoutingStrategy.enumValues)[number];

/**
 * Per-account inflight ceiling applied when a provider has no routing row yet.
 * One literal: the console default and the route catalog's fallback both read
 * it. `null` is the "unlimited" choice, and it is also this default — an
 * operator who has never opened the routing card asked for no ceiling, and
 * inventing one silently capped their concurrency. A ceiling they *did* set is
 * still honoured, so this only decides the untouched case.
 */
export const DEFAULT_PROVIDER_MAX_INFLIGHT: null = null;

export const providerRoutingSettings = pgTable(
  "provider_routing_settings",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    tenantId: tenantRefNullable(),
    strategy: providerRoutingStrategy("strategy").notNull().default("fallback"),
    /** Requests served by one account before round robin advances. */
    rotateCount: integer("rotate_count").notNull().default(1),
    /** Per-account inflight ceiling applied to every account of this provider
     * (the field sits next to the failover/round-robin strategy in the UI).
     * `null` = UNLIMITED concurrency per account. */
    maxInflight: integer("max_inflight"),
    /**
     * Per-pool inflight ceiling for this provider: how many concurrent
     * requests one proxy pool may carry *for this provider*.
     *
     * A second, independent axis from `maxInflight`. That one bounds a single
     * account; `network_pools.max_inflight` bounds a pool across every
     * provider; this one bounds one provider's share of one pool. All three
     * are enforced together — none replaces another.
     *
     * `null` = unlimited, and that is the default: an unconfigured provider
     * costs no extra Redis key and no extra round trip.
     */
    maxInflightPerProxy: integer("max_inflight_per_proxy"),
    /**
     * Minimum remaining allowance an account must hold to stay routable, for
     * this provider. `null` means no floor. Compared against the account's own
     * unit: absolute remaining credit when the provider reports credits, the
     * aggregate credit percentage and lowest independent percentage window
     * otherwise. An account below it is skipped and the request fails over to
     * the next account instead of erroring.
     */
    usageFloor: integer("usage_floor"),
    /** `credit` compares the summed remaining credit; `percent` compares the
     * aggregate credit percentage and lowest independent percentage-only
     * window. Ignored while `usageFloor` is null. */
    usageFloorUnit: text("usage_floor_unit").$type<"credit" | "percent">().notNull().default("percent"),
    enabled: boolean("enabled").notNull().default(false),
    // Route-selected User-Agent for built-in API-key providers; OAuth and BYOK identities stay native.
    // The column default is the Claude Code CLI identity; the live default for a
    // row that never set one is `buildClaudeCliUserAgent()` in
    // providers/operations/custom-cli-headers.ts, which this mirrors.
    userAgent: text("user_agent").notNull().default("claude-cli/2.1.293 (external, cli)"),
    // Operator-set custom User-Agent, stored separately from the provider's
    // native client identity (`user_agent`). NULL = no override — dispatch
    // uses the native identity. A non-NULL value is an explicit override
    // applied at the request edge, even when the provider would otherwise
    // stamp its own identity.
    customUserAgent: text("custom_user_agent"),
    // When true, this provider's requests always dial direct. When false,
    // dispatch automatically selects among every active network pool the
    // tenant owns (least-loaded/non-cooldown) — never an admin-pinned pool.
    skipProxy: boolean("skip_proxy").notNull().default(false),
    // How device-code OAuth flows (start + poll) choose their egress:
    // 'random' (default) routes them through a randomly selected active
    // network pool so the upstream sees a rotating IP (avoids "multiple codes
    // from one IP" detection for Cursor/Grok/device-code providers); 'direct'
    // always dials direct egress.
    deviceFlowProxy: text("device_flow_proxy").$type<DeviceFlowProxyMode>().notNull().default("random"),
  },
  (table) => ({
    tenantProviderUnique: uniqueIndex("provider_routing_settings_tenant_provider_idx").on(
      table.tenantId,
      table.providerId,
    ),
    globalProviderUnique: uniqueIndex("provider_routing_settings_global_provider_idx")
      .on(table.providerId)
      .where(sql`tenant_id IS NULL`),
  }),
);

export const poolRoutingStrategy = pgEnum("pool_routing_strategy", [
  "least_loaded",
  "round_robin",
  "random",
]);
export type PoolRoutingStrategy = (typeof poolRoutingStrategy.enumValues)[number];

/** Egress mode for device-code OAuth flows: random active pool, or direct. */
export type DeviceFlowProxyMode = "random" | "direct";

/**
 * Per-tenant selection strategy across the tenant's active network pools —
 * the pool-group counterpart to `provider_routing_settings`. `least_loaded`
 * (default) keeps the weighted least-loaded scan with its rotating tie-break;
 * `round_robin` serves `rotate_count` requests per pool before advancing,
 * mirroring the account strategy, and skips capacity/cooldown pools the way
 * account failover does. An absent row reads as the default, so tenants that
 * never touch the toggle own no rows.
 */
export const poolRoutingSettings = pgTable("pool_routing_settings", {
  tenantId: tenantRefPrimaryKey(),
  strategy: poolRoutingStrategy("strategy").notNull().default("least_loaded"),
  /** Requests served by one pool before round robin advances. */
  rotateCount: integer("rotate_count").notNull().default(1),
});
