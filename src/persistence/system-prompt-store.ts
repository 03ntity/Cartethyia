// Persistence for tenant system-prompt injection settings.
//
// One row per tenant. Mutations bump the settings revision so the dispatch
// path's revision-keyed reader converges immediately (same mechanism as the
// runtime-preferences cache).
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "./db-handle";
import { tenantSystemPrompts } from "./schema";
import type {
  ProviderPromptEntry,
  PromptSetting,
  TenantSystemPrompts,
} from "../console/system-prompt/contracts";
import {
  EMPTY_TENANT_SYSTEM_PROMPTS,
  SYSTEM_PROMPT_MODEL_LIMIT,
  SYSTEM_PROMPT_PROVIDER_LIMIT,
  isPromptSetting,
  parseSystemPromptModelKey,
} from "../console/system-prompt/contracts";
import { bumpSettingsRevision } from "./settings-revision";

/** The stored row, normalized. Absent row reads as the empty configuration. */
export type StoredTenantSystemPrompts = TenantSystemPrompts;

/**
 * Reads the tenant's stored configuration, defensively normalized: a
 * hand-edited or legacy row must not poison the dispatch path, so malformed
 * entries are dropped rather than trusted.
 */
export async function readTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<StoredTenantSystemPrompts> {
  const rows = await db
    .select({
      global: tenantSystemPrompts.global,
      providers: tenantSystemPrompts.providers,
      models: tenantSystemPrompts.models,
    })
    .from(tenantSystemPrompts)
    .where(eq(tenantSystemPrompts.tenantId, tenantId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return EMPTY_TENANT_SYSTEM_PROMPTS;

  const providers: Record<string, ProviderPromptEntry> = {};
  for (const [providerId, entry] of Object.entries(row.providers ?? {})) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<ProviderPromptEntry>;
    if (typeof candidate.followGlobal !== "boolean") continue;
    if (candidate.followGlobal === false) {
      if (!isPromptSetting(candidate.setting)) continue;
      providers[providerId] = { followGlobal: false, setting: candidate.setting };
    } else {
      providers[providerId] = { followGlobal: true };
    }
  }

  const models: Record<string, PromptSetting> = {};
  for (const [key, setting] of Object.entries(row.models ?? {})) {
    if (parseSystemPromptModelKey(key) === null) continue;
    if (!isPromptSetting(setting)) continue;
    models[key] = setting;
  }

  return {
    global: row.global !== null && isPromptSetting(row.global) ? row.global : null,
    providers,
    models,
  };
}

/** Upserts the tenant's configuration and bumps the settings revision. */
export async function writeTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
  next: TenantSystemPrompts,
): Promise<void> {
  // Keep the row bounded even though the API already enforces the caps: a
  // direct store caller must not be able to plant an unbounded map.
  const providers = Object.entries(next.providers).slice(0, SYSTEM_PROMPT_PROVIDER_LIMIT);
  const models = Object.entries(next.models).slice(0, SYSTEM_PROMPT_MODEL_LIMIT);
  const values = {
    global: next.global,
    providers: Object.fromEntries(providers),
    models: Object.fromEntries(models),
    updatedAt: new Date(),
  };
  await db
    .insert(tenantSystemPrompts)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: tenantSystemPrompts.tenantId, set: values });
  bumpSettingsRevision();
}

/** Clears the tenant's configuration entirely (console "reset" path). */
export async function clearTenantSystemPrompts(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<void> {
  await db.delete(tenantSystemPrompts).where(eq(tenantSystemPrompts.tenantId, tenantId));
  bumpSettingsRevision();
}
