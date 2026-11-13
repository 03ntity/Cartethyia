/**
 * Console identity and per-tenant settings: users, sessions, login lockouts,
 * audit log, runtime preferences, system prompts, and the InferHub config key.
 */
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import {
  bytea, createdAtColumn, tenantCascadeSetNull, tenantRefPrimaryKey,
  tenantRefRequired, timestampColumns, updatedAtColumn,
} from "./schema-shared";

/**
 * Console dashboard users — distinct from API-key tenants.
 */
export const consoleUsers = pgTable(
  "console_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    username: text("username").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    isActive: boolean("is_active").notNull().default(true),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    isFirstBoot: boolean("is_first_boot").notNull().default(true),
    ...timestampColumns(),
  },
  (table) => [
    index("console_users_tenant_id_idx").on(table.tenantId),
    uniqueIndex("console_users_tenant_username_uidx").on(table.tenantId, table.username),
  ],
);

export type ConsoleUser = typeof consoleUsers.$inferSelect;

/**
 * Console sessions — HTTP-only, signed cookies.
 * Session metadata only; no secrets in JSON.
 */
export const consoleSessions = pgTable(
  "console_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("console_sessions_user_id_idx").on(table.userId),
  ],
);

export type ConsoleSession = typeof consoleSessions.$inferSelect;

/**
 * Console login lockout tracking — fail-closed rate limiting keyed by
 * client IP (login attempts happen before any user identity is known, so
 * this cannot be keyed by `console_users.id`). Persisted so a ban survives
 * a process restart and is shared across every app instance, instead of a
 * static in-process map that a second instance or a redeploy would forget.
 */
export const consoleLockouts = pgTable(
  "console_lockouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ip: text("ip").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    windowUntil: timestamp("window_until", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    reason: text("reason"),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("idx_console_lockouts_ip").on(table.ip),
  ],
);

// Configuration-change audit has its own retention lifecycle; it is separate
// from metadata telemetry and short-lived optional payload capture.
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    actor: text("actor").notNull(),
    tenantId: tenantCascadeSetNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    index("admin_audit_log_tenant_id_created_at_id_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
  ],
);

// Runtime preferences are stored in one validated JSONB bag. The filter
// master toggle remains a typed column because it is read on the proxy path.
export interface ConsoleSettingsPreferences {
  tenantConcurrencyLimit?: number | null;
  /** Normalizes provider-native thinking config for non-user final turns. */
  thinkingNormalizationEnabled?: boolean;
  responsesReasoningSummary?: "auto" | "concise" | "detailed";
  /**
   * Request compression: compact bulky tool-result text in the message history
   * before dispatch (RTK prune). Default off.
   */
  rtkPruneEnabled?: boolean;
  /** RTK prune strength when enabled (`lite`/`full`/`ultra`); `full` when unset. */
  rtkPruneLevel?: "lite" | "full" | "ultra";
  /**
   * Request compression: append a minimal-code directive to the system content.
   * Default off; `ponyTailLevel` selects the intensity when on.
   */
  ponyTailEnabled?: boolean;
  /** PonyTail directive intensity; `full` when unset. Only applied when enabled. */
  ponyTailLevel?: "lite" | "full" | "ultra" | null;
  /**
   * Payload capture mode (default `none` when unset):
   * - `metadata` — Proxy→Provider method + allowlisted headers only
   * - `full` — full redacted bodies up to the configured capture limit
   * - `none` — no drawer capture (request metadata events still retained)
   */
  telemetryPayloads?: "full" | "metadata" | "none";
  /**
   * Capture depth for `full` mode (default `minimum` when unset). Fixed size
   * tiers so every debug sees all four drawer panels — only the cap changes:
   * - `minimum` — 1 MiB combined cap, light enough to leave on
   * - `moderate` — 8 MiB combined cap, expect CPU/memory spikes while active
   * - `maximum` — 16 MiB combined cap, expect CPU/memory spikes while active
   */
  telemetryPayloadDepth?: "minimum" | "moderate" | "maximum";

  privacyMode?: "masked" | "full";
  /**
   * Ignores an account-wide cooldown when building route candidates.
   *
   * Off by default, and deliberately dangerous: an account in cooldown was
   * parked because the upstream refused it, and dialing it anyway reproduces
   * that refusal on every attempt. Turning this on can exhaust the candidate
   * list and fail a request that would otherwise have been routed.
   *
   * The override is read-only — the cooldown is still recorded, still shown in
   * Health, and still recovered by the sweep. Nothing is written back, so the
   * toggle can be turned off again without cleaning anything up.
   *
   * Per-(account, model) cooldowns are NOT overridden. Those are usually a
   * named quota ("daily free limit reached, try again in 11h") where the
   * upstream stated a real reset; ignoring it only buys repeated refusals.
   */
  forceDisableCooldown?: boolean;
  /**
   * Stops every invoke and route for this tenant. Off by default.
   *
   * A kill switch, not a routing tweak: while it is on, `/v1/*` returns 503 and
   * nothing is dispatched upstream. The console keeps working, which is the
   * point — an operator must be able to stop traffic and still reach the UI
   * that turns it back on.
   */
  invokeDisabled?: boolean;
  /**
   * Slack added on top of every key's concurrency limit for this tenant.
   *
   * `maxConcurrentRequests` is the number an operator chose and what a
   * refusal names; this is deliberate allowance above it so a run landing a
   * few over is not refused at that number. Effective ceiling is
   * `limit + tolerance`, and only requests past it are refused — never ones
   * already admitted.
   */
  concurrencyTolerance?: number | null;
  /**
   * Per-tenant upstream request timeout in seconds, overriding
   * `CARTETHYIA_UPSTREAM_TIMEOUT_MS`. `null` or absent means use the
   * deployment default.
   */
  upstreamTimeoutSeconds?: number | null;
  /** Captured payload detail lifetime in minutes; null means deployment default. */
  telemetryWindowMinutes?: number | null;

  /**
   * Per-tenant ceiling for one inline attachment, in bytes, overriding the
   * deployment default of 10 MB.
   *
   * Raising this asserts that this tenant's upstreams accept larger
   * attachments. The clamp is a hard send gate precisely because an oversized
   * block poisons every retry and every replayed turn — the upstream rejects
   * the whole request rather than the one block — so an override larger than
   * the provider actually accepts trades that protection away. Lowering it is
   * the safer direction and the more common need.
   */
  imageClampMaxBytes?: number | null;
  /**
   * Ordered list of vision model ids (`provider/model`) used to describe
   * images when the selected model is not image-capable. The first healthy
   * model wins; if it fails (cooldown/quota/upstream error), the handoff
   * falls through to the next entry. Empty/absent = legacy `[image]`
   * placeholder behavior.
   */
  visionHandoffModels?: readonly string[];
  /**
   * Auto-disable provider accounts that keep failing with upstream rate-limit
   * or quota verdicts. Off by default: without it, those failures land on a
   * per-model/account cooldown and the account stays rotatable.
   */
  autoDisableRateLimited?: boolean;
  /**
   * Modelprobe mode: `detail` (full identity probe) or `fast` (minimal
   * 32-token check). `detail` when unset.
   */
  modelProbeMode?: "fast" | "detail";
  /** Fast-probe timeout in seconds; `null`/absent means the built-in default (10). */
  modelProbeFastTimeoutSeconds?: number | null;
}

export const consoleSettings = pgTable("console_settings", {
  tenantId: tenantRefPrimaryKey(),
  preferences: jsonb("preferences").notNull().default({}).$type<ConsoleSettingsPreferences>(),
  updatedAt: updatedAtColumn(),
});

// Tenant-scoped system prompt injection (append/override). One row per
// tenant; `global` NULL means never configured, distinct from an explicit
// disabled setting. Providers/models/combos/aliases are JSON object maps
// keyed by providerId, `providerId::modelId`, combo name, and alias name
// respectively — see `src/protocol/system-prompt-contracts.ts` for the value
// shapes and the resolution rules implemented by the dispatch-path transform.
export const tenantSystemPrompts = pgTable("tenant_system_prompts", {
  tenantId: tenantRefPrimaryKey(),
  global: jsonb("global").$type<import("../protocol/system-prompt-contracts").ScopePromptRef | null>(),
  presets: jsonb("presets")
    .notNull()
    .default({})
    .$type<Record<string, import("../protocol/system-prompt-contracts").SystemPromptPreset>>(),
  providers: jsonb("providers")
    .notNull()
    .default({})
    .$type<Record<string, import("../protocol/system-prompt-contracts").ScopePromptRef>>(),
  models: jsonb("models")
    .notNull()
    .default({})
    .$type<Record<string, import("../protocol/system-prompt-contracts").ScopePromptRef>>(),
  combos: jsonb("combos")
    .notNull()
    .default({})
    .$type<Record<string, import("../protocol/system-prompt-contracts").ScopePromptRef>>(),
  aliases: jsonb("aliases")
    .notNull()
    .default({})
    .$type<Record<string, import("../protocol/system-prompt-contracts").ScopePromptRef>>(),
  updatedAt: updatedAtColumn(),
});

// InferHub `config_read` key. One row for the whole deployment.
//
// Deliberately NOT `provider_accounts.auth_state`: that field is documented as
// per-account *non-secret* upstream config and travels with the account through
// backup/restore, so a credential stored there is copied around and readable by
// anything that reads accounts. This key is a secret and gets its own encrypted
// row, unreachable from the account paths.
export const inferhubConfigKeys = pgTable("inferhub_config_keys", {
  id: text("id").primaryKey(),
  /** `encryptCredential` output — never plaintext, never returned by an API. */
  ciphertext: bytea("ciphertext").notNull(),
  /** Hash only, for "did it change" checks. Not used to verify the key. */
  fingerprint: text("fingerprint").notNull(),
  updatedAt: updatedAtColumn(),
});
