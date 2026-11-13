/**
 * Inbound API keys (personal + share templates/children), share popups and
 * share links, and CLI-tool mappings/settings.
 */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey,
  text, timestamp, uniqueIndex, uuid, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  bytea, createdAtColumn, tenantRefRequired, updatedAtColumn,
} from "./schema-shared";

export const API_KEY_MODES = ["personal", "share"] as const;
export type ApiKeyMode = (typeof API_KEY_MODES)[number];

/**
 * How a key's `modelList` is interpreted. Exactly two modes, never a
 * combination: `whitelist` allows only the listed names (an empty list allows
 * everything), `blacklist` refuses the listed names (an empty list refuses
 * nothing). Every model-authorization surface — the request path, admission,
 * `/v1/models`, and the share page — reads this one pair.
 */
export const API_KEY_MODEL_ACCESS_MODES = ["whitelist", "blacklist"] as const;
export type ApiKeyModelAccessMode = (typeof API_KEY_MODEL_ACCESS_MODES)[number];

/** Share-template concurrency scope — see `apiKeys.concurrencyScope`. */
export const API_KEY_CONCURRENCY_SCOPES = ["family", "per_key"] as const;
export type ApiKeyConcurrencyScope = (typeof API_KEY_CONCURRENCY_SCOPES)[number];

/**
 * Inbound `/v1/*` keys never store plaintext secrets. Personal keys carry an
 * authentication hash; share templates carry policy and child keys point back
 * to the template that issued them.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    keyHash: text("key_hash"),
    keyMode: text("key_mode").$type<ApiKeyMode>().notNull().default("personal"),
    parentKeyId: uuid("parent_key_id").references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: "cascade" },
    ),
    issuedClientIp: text("issued_client_ip"),
    issuedClientIpKey: text("issued_client_ip_key"),
    label: text("label").notNull(),
    scopes: jsonb("scopes").notNull().$type<readonly string[]>(),
    // Only the non-secret public key prefix is returned to the owner.
    keyPrefix: text("key_prefix"),
    // Personal keys retain an encrypted copy for the CLI handoff. Shared
    // children are revealed once and persist only their authentication hash.
    keyEncrypted: bytea("key_encrypted"),
    notesTitle: text("notes_title"),
    notesSubtitle: text("notes_subtitle"),
    notesBody: text("notes_body"),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    requestsPerMinute: integer("requests_per_minute"),
    dailyTokenLimit: bigint("daily_token_limit", { mode: "number" }),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    lifetimeTokenBudget: bigint("lifetime_token_budget", { mode: "number" }),
    lifetimeTokensConsumed: bigint("lifetime_tokens_consumed", { mode: "number" })
      .notNull()
      .default(0),
    maxConcurrentRequests: integer("max_concurrent_requests"),
    /**
     * How `maxConcurrentRequests` applies to a share family:
     *
     * - `family` (default) — one cap across the whole family: every recipient
     *   key shares the same admission counter and budget, so 20 means 20
     *   concurrent requests across all children of the template.
     * - `per_key` — each recipient key gets its own independent concurrent
     *   window and cap. The cap is copied from the template to each child at
     *   issue time (children carry their own `maxConcurrentRequests`), and a
     *   child's admission identity is its own id, not the parent's.
     *
     * Only meaningful for `share` keys; personal keys always use their own
     * per-key cap.
     */
    concurrencyScope: text("concurrency_scope")
      .$type<ApiKeyConcurrencyScope>()
      .notNull()
      .default("family"),
    /**
     * Slot cap for a share template: the maximum number of concurrently
     * active child keys it may mint. `null` = unlimited (legacy behavior).
     * Enforced at mint time in `issueSharedApiKey`; the console exposes it as
     * the template's "slots".
     */
    maxChildren: integer("max_children"),
    /**
     * `whitelist` = only the names in `modelList` may be used (empty = all);
     * `blacklist` = the names in `modelList` are refused (empty = none). One
     * list, one mode.
     */
    modelAccessMode: text("model_access_mode")
      .$type<ApiKeyModelAccessMode>()
      .notNull()
      .default("whitelist"),
    modelList: jsonb("model_list").$type<readonly string[]>(),
    /**
     * Client-router ids this key refuses. A request whose fingerprint names one
     * of these is rejected before routing, so an operator can stop a downstream
     * router from spending the key. Empty/NULL means "no router is refused".
     *
     * A label, not a security control: a client that sends no fingerprint is
     * simply not matched, which is why this is a per-key policy rather than a
     * boundary anything else in the system trusts.
     */
    clientRouterDenylist: jsonb("client_router_denylist").$type<readonly string[]>(),
    modelPrefix: text("model_prefix"),
    createdAt: createdAtColumn(),
    enabled: boolean("enabled").notNull().default(true),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Ban state. A ban is distinct from a revoke: it records the operator's
     * reason (`banReason`) so the console can show it, and it is fully
     * reversible — unban clears both columns, leaving no metadata behind.
     * Banned keys are rejected by the auth path exactly like revoked keys.
     */
    bannedAt: timestamp("banned_at", { withTimezone: true }),
    banReason: text("ban_reason"),
    /**
     * When the ban lifts on its own, if it is not permanent. `null` means the
     * ban does not lapse (until an operator unbans it). The auth path treats a
     * key as banned only while `banned_at` is set and `banned_until` is either
     * null or in the future — so a timed ban expires without SQL.
     */
    bannedUntil: timestamp("banned_until", { withTimezone: true }),
    /**
     * The tenant's mandatory gateway key. Seeded at first boot whether or not
     * `CARTETHYIA_API_KEY` was configured, and the one key the console refuses
     * to revoke — it may only be rotated. A column rather than a label match,
     * so renaming the key cannot break the CLI lookup or let a second
     * default be created.
     */
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    /**
     * One *live* default key per tenant, enforced by the database.
     *
     * This is the only database-level guarantee behind `isDefault`, and
     * `test/persistence/sqlite-baseline.test.ts` pins it by name — so the
     * schema must keep declaring it to match the baseline.
     *
     * Partial on `revoked_at IS NULL` so a tenant can rotate its default key
     * without the old, revoked row blocking the new one.
     */
    uniqueIndex("api_keys_one_default_per_tenant_uidx")
      .on(table.tenantId)
      .where(sql`${table.isDefault} = true AND ${table.revokedAt} IS NULL`),
    index("api_keys_tenant_id_idx").on(table.tenantId),
    index("api_keys_enabled_tenant_idx").on(table.tenantId).where(sql`${table.enabled} = true`),
    index("api_keys_parent_key_id_idx").on(table.parentKeyId),
    check(
      "api_keys_mode_shape_check",
      sql`(
        (${table.keyMode} = 'personal' AND ${table.keyHash} IS NOT NULL
          AND ${table.parentKeyId} IS NULL AND ${table.issuedClientIp} IS NULL
          AND ${table.issuedClientIpKey} IS NULL)
        OR
        (${table.keyMode} = 'share' AND (
          (${table.parentKeyId} IS NULL AND ${table.keyHash} IS NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NULL AND ${table.issuedClientIpKey} IS NULL)
          OR
          (${table.parentKeyId} IS NOT NULL AND ${table.keyHash} IS NOT NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NOT NULL AND ${table.issuedClientIpKey} IS NOT NULL)
        ))
      )`,
    ),
  ],
);

/**
 * The optional popup a share link shows its recipient. Kept off `api_keys`
 * because the auth path reads that row on every request and the popup is
 * absent for nearly all of them. One row per key, present only when the owner
 * configured one.
 */
export const sharePopups = pgTable(
  "share_popups",
  {
    apiKeyId: uuid("api_key_id")
      .primaryKey()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    image: bytea("image"),
    imageMime: text("image_mime"),
    title: text("title"),
    body: text("body"),
  },
  (table) => [
    check(
      "share_popups_image_mime_check",
      sql`${table.imageMime} IS NULL OR ${table.imageMime} IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
    check(
      "share_popups_image_size_check",
      sql`${table.image} IS NULL OR octet_length(${table.image}) <= 2097152`,
      // SQLite has no octet_length. The generator rewrites this check to
      // `length(`; both count bytes for a blob column.
    ),
  ],
);

// Public bearer links for enrolling one shared key per resolved client IP, and
// for handing a personal key to its owner. The hash is the lookup key; the
// token is additionally retained encrypted so the owner's console can show the
// link again instead of losing it after the one response that minted it.
/**
 * Share-link kinds, as a runtime tuple. Route schemas and DTOs project this
 * list rather than restating it.
 */
const SHARE_LINK_KINDS = ["enroll", "handoff"] as const;

/** One share-link kind. */
export type ShareLinkKind = (typeof SHARE_LINK_KINDS)[number];

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    // Encrypted bearer token. Present so the console can re-display a stable
    // link; nullable, and a NULL row simply cannot be shown again.
    tokenEncrypted: bytea("token_encrypted"),
    /**
     * The public slug this page is reachable at, in the clear.
     *
     * `tokenEncrypted` is the bearer token under the deployment's encryption
     * key, so a link cannot be re-displayed once that key changes — which is
     * exactly what a restore onto a fresh deployment does. Holding the slug
     * unencrypted keeps every restored share page reachable under the address
     * it was created with.
     *
     * Nullable: a row without a slug has no address, and inventing one
     * would publish an address the page never had.
     */
    slug: text("slug"),
    kind: text("kind").$type<ShareLinkKind>().notNull().default("enroll"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAtColumn(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("share_links_token_hash_idx").on(table.tokenHash),
    // Partial: rows without a slug are not constrained, so backfilling is never
    // blocked by a uniqueness collision.
    uniqueIndex("share_links_slug_uidx").on(table.slug).where(sql`${table.slug} IS NOT NULL`),
    index("share_links_api_key_idx").on(table.apiKeyId),
    index("share_links_active_kind_expires_idx").on(table.active, table.kind, table.expiresAt),
    check("share_links_kind_check", sql`${table.kind} IN ('enroll', 'handoff')`),
  ],
);

// CLI Tools (CLI tool configuration): per-tenant mapping table that lets a coding-agent
// slot (e.g. Claude Code's "opus" slot) target a specific Cartethyia model. Rows
// are opaque strings — validation happens at the API boundary against the
// tool registry, not in Postgres.
export const cliToolMappings = pgTable(
  "cli_tool_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references((): AnyPgColumn => apiKeys.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    slotKey: text("slot_key").notNull(),
    sourceModel: text("source_model").notNull(),
    targetModel: text("target_model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("cli_tool_mappings_key").on(
      table.tenantId,
      table.toolId,
      table.apiKeyId,
      table.slotKey,
    ),
  ],
);

// Per-(tenant, tool, api_key) settings: whether mappings are active and which
// mode the tool is configured for. Primary key is the composite of all three.
export const cliToolSettings = pgTable(
  "cli_tool_settings",
  {
    tenantId: tenantRefRequired(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references((): AnyPgColumn => apiKeys.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    mappingsEnabled: boolean("mappings_enabled").notNull().default(false),
    mode: text("mode").notNull().default("remote"),
    updatedAt: updatedAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.toolId, table.apiKeyId] })],
);
