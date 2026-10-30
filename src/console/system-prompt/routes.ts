// Console API for tenant system-prompt injection.
//
// GET    /system-prompt → the stored configuration
// PUT    /system-prompt → replace the configuration wholesale
// DELETE /system-prompt → clear it entirely
//
// The PUT replaces the row: the modal edits the whole three-scope shape at
// once, so a PATCH surface would add states the UI never produces. Text is
// capped at 5 MB per scope and the provider/model maps are bounded, matching
// the store's own defensive limits.
import { Elysia, t } from "elysia";
import type { ConsoleAccessResolver } from "../auth/access";
import { ConsoleDomainError, consoleErrorHandler, requireTenantScope } from "../shared/errors";
import type { AuditSink } from "../audit/contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  clearTenantSystemPrompts,
  readTenantSystemPrompts,
  writeTenantSystemPrompts,
} from "../../persistence/system-prompt-store";
import {
  EMPTY_TENANT_SYSTEM_PROMPTS,
  PROMPT_MODES,
  SYSTEM_PROMPT_MODEL_LIMIT,
  SYSTEM_PROMPT_PROVIDER_LIMIT,
  SYSTEM_PROMPT_TEXT_CAP_BYTES,
  isPromptSetting,
  parseSystemPromptModelKey,
  type PromptSetting,
  type ProviderPromptEntry,
  type TenantSystemPrompts,
} from "./contracts";

/** Route-group context injected by the composition root. */
export interface SystemPromptRoutesConfig {
  readonly db: CartethyiaDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

/** Validates one scope setting, including the 5 MB text cap. */
function validateSetting(value: unknown, scopeLabel: string): PromptSetting {
  if (!isPromptSetting(value)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} is not a valid prompt setting`);
  }
  const bytes = Buffer.byteLength(value.text, "utf8");
  if (bytes > SYSTEM_PROMPT_TEXT_CAP_BYTES) {
    throw new ConsoleDomainError("payload_too_large", 413, `${scopeLabel} exceeds the 5 MB limit`);
  }
  if (!(PROMPT_MODES as readonly string[]).includes(value.mode)) {
    throw new ConsoleDomainError("invalid_request", 400, `${scopeLabel} has an invalid mode`);
  }
  return value;
}

/** Validates the full PUT body into the stored shape. */
function validateBody(value: unknown): TenantSystemPrompts {
  if (typeof value !== "object" || value === null) {
    throw new ConsoleDomainError("invalid_request", 400, "Body must be an object");
  }
  const body = value as {
    global?: unknown;
    providers?: unknown;
    models?: unknown;
  };

  const global =
    body.global === null || body.global === undefined
      ? null
      : validateSetting(body.global, "global");

  if (body.providers !== undefined && typeof body.providers !== "object") {
    throw new ConsoleDomainError("invalid_request", 400, "providers must be an object");
  }
  const rawProviders = (body.providers ?? {}) as Record<string, unknown>;
  const providerIds = Object.keys(rawProviders);
  if (providerIds.length > SYSTEM_PROMPT_PROVIDER_LIMIT) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `providers exceeds the ${SYSTEM_PROMPT_PROVIDER_LIMIT} entry limit`,
    );
  }
  const providers: Record<string, ProviderPromptEntry> = {};
  for (const providerId of providerIds) {
    const entry = rawProviders[providerId];
    if (typeof entry !== "object" || entry === null) {
      throw new ConsoleDomainError("invalid_request", 400, `provider ${providerId} entry must be an object`);
    }
    const candidate = entry as Partial<ProviderPromptEntry>;
    if (typeof candidate.followGlobal !== "boolean") {
      throw new ConsoleDomainError("invalid_request", 400, `provider ${providerId} needs followGlobal`);
    }
    if (candidate.followGlobal) {
      providers[providerId] = { followGlobal: true };
    } else {
      providers[providerId] = {
        followGlobal: false,
        setting: validateSetting(candidate.setting, `provider ${providerId}`),
      };
    }
  }

  if (body.models !== undefined && typeof body.models !== "object") {
    throw new ConsoleDomainError("invalid_request", 400, "models must be an object");
  }
  const rawModels = (body.models ?? {}) as Record<string, unknown>;
  const modelKeys = Object.keys(rawModels);
  if (modelKeys.length > SYSTEM_PROMPT_MODEL_LIMIT) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `models exceeds the ${SYSTEM_PROMPT_MODEL_LIMIT} entry limit`,
    );
  }
  const models: Record<string, PromptSetting> = {};
  for (const key of modelKeys) {
    if (parseSystemPromptModelKey(key) === null) {
      throw new ConsoleDomainError("invalid_request", 400, `model key ${key} is malformed`);
    }
    models[key] = validateSetting(rawModels[key], `model ${key}`);
  }

  return { global, providers, models };
}

/**
 * The return type is inferred rather than annotated as `Elysia`: `.error()`
 * widens the instance type with its handler's response envelope, so the
 * annotated base type no longer matches the chained result (same reason the
 * remote-support routes leave it inferred).
 */
export function createSystemPromptRoutes(config: SystemPromptRoutesConfig) {
  return new Elysia()
    .error(consoleErrorHandler("System prompt settings failed"))
    .get("/system-prompt", async ({ request }) => {
      const access = requireTenantScope(config.accessResolver(request), "dashboard:read");
      return await readTenantSystemPrompts(config.db, access.tenantId);
    })
    .put(
      "/system-prompt",
      { body: t.Any() },
      async ({ request, body }) => {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        const next = validateBody(body);
        await writeTenantSystemPrompts(config.db, access.tenantId, next);
        await config.auditSink?.record({
          access,
          action: "system_prompt.update",
          target: "tenant_system_prompts",
          detail: {
            global: next.global !== null,
            providers: Object.keys(next.providers).length,
            models: Object.keys(next.models).length,
          },
        });
        return next;
      },
    )
    .delete("/system-prompt", async ({ request }) => {
      const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
      await clearTenantSystemPrompts(config.db, access.tenantId);
      return EMPTY_TENANT_SYSTEM_PROMPTS;
    });
}
