// Core API-key operations: listing, create/update/delete, and ban handling.
// Composed into `createApiKeyOperations`.

import { randomUUID } from "node:crypto";
import { encryptCredential } from "../../security/crypto";
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import { invalidatePublicModels } from "../providers/catalog/public-model-store";
import type { AccessDecision } from "../../security/access-control";
import { ConsoleDomainError, requireTenantScope } from "../shared/errors";
import type { ApiKeyConfig, ApiKeyResponse, BanApiKeyRequest, CreateApiKeyRequest, CreateApiKeyResponse, UpdateApiKeyResponse } from "./contracts";
import {
  API_KEY_BAN_REASONS,
  BAN_DURATION_CHOICES,
  DEFAULT_BAN_MINUTES,
  generateApiKeySecret,
  isDefaultGatewayApiKey,
  sanitizeApiKeyResponse,
  validateApiKeyRequest,
  parseRequest,
  finitePositive,
  resolveKeyPrefix,
  prepareCustomKey,
  resolveShareKeyPrefix,
} from "./contracts";
import type { ApiKeyPatch, ApiKeyRecord } from "../../persistence/stores/api-key-store";
import { validateReorderIds } from "../shared/reorder";
import { invalidateFamilyCaches, purgeFamilyAdmission } from "./family-cache";
import { pickDefined } from "../shared/object";

/** The offered ban durations as a set of minute values, hoisted once. */
const BAN_DURATION_MINUTES = new Set(BAN_DURATION_CHOICES.map((choice) => choice.minutes));

export function createKeyOperations(config: ApiKeyConfig) {
  const operations = {
    async listKeys(access: AccessDecision | undefined, includeChildren = false): Promise<ApiKeyResponse[]> {
        const authorized = requireTenantScope(access, "dashboard:read");
        // The non-revoked / top-level filters live in the store query: without
        // them this loaded the tenant's whole key table — every minted share
        // child included — on each list call.
        const records = await config.store.listForConsole(authorized.tenantId, { includeChildren });
        return records.map(sanitizeApiKeyResponse);
    },
    async listActiveBannedKeys(access: AccessDecision | undefined): Promise<ApiKeyResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const records = await config.store.listActiveBanned(authorized.tenantId);
      return records.map(sanitizeApiKeyResponse);
    },
    /** Persists a new credential order. `keyIds` must name every top-level key
        the tenant has, so a partial list cannot silently renumber rows. */
    async reorderKeys(access: AccessDecision | undefined, keyIds: readonly string[]): Promise<void> {
        const authorized = requireTenantScope(access, "dashboard:write");
        // Only the reorderable set is needed — live top-level keys — so the
        // store query carries the same filters `listKeys` applies.
        const records = await config.store.listForConsole(authorized.tenantId, { includeChildren: false });
        validateReorderIds(keyIds, new Set(records.map((record) => record.id)), "key", {
          code: "key_not_found",
          status: 404,
        });
        await config.store.reorder(authorized.tenantId, keyIds);
      },
    async getKeyDetail(access: AccessDecision | undefined, keyId: string): Promise<ApiKeyResponse> {
        const authorized = requireTenantScope(access, "dashboard:read");
        const record = await config.store.get(authorized.tenantId, keyId);
        if (!record) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
        return sanitizeApiKeyResponse(record);
      },
    async getSharePopupImage(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<{ mime: string; image: Buffer }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.sharePopupImage === undefined || record.sharePopupImageMime === undefined)
        throw new ConsoleDomainError("key_not_found", 404, "This key has no popup image");
      return { mime: record.sharePopupImageMime, image: record.sharePopupImage };
    },
    async createKey(
      access: AccessDecision | undefined,
      request: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const { scopes, popupImage } = validateApiKeyRequest(request);
      const keyMode = request.keyMode ?? "personal";
      const keyPrefix =
        keyMode === "share"
          ? resolveShareKeyPrefix(request.keyPrefix)
          : resolveKeyPrefix(request.keyPrefix);
      const generated =
        keyMode === "personal"
          ? request.key === undefined
            ? generateApiKeySecret(keyPrefix)
            : { ...prepareCustomKey(request.key), prefix: keyPrefix }
          : undefined;
      const record: ApiKeyRecord = {
        id: randomUUID(),
        tenantId: authorized.tenantId,
        enabled: request.enabled ?? true,
        label: request.label?.trim() || (keyMode === "share" ? "Share template" : "API key"),
        keyHash: generated?.hash ?? null,
        keyMode,
        scopes,
        // Only first boot seeds the default; a key created from the console is
        // never it, so it stays renamable and revocable.
        isDefault: false,
        keyPrefix: generated?.prefix ?? keyPrefix,
        ...(generated ? { keyEncrypted: encryptCredential(generated.secret) } : {}),
        ...pickDefined({ notesTitle: request.notesTitle }),
        ...pickDefined({ notesSubtitle: request.notesSubtitle }),
        ...pickDefined({ notesBody: request.notesBody }),
        ...(request.sharePopupEnabled == null ? {} : { sharePopupEnabled: request.sharePopupEnabled }),
        ...(popupImage
          ? { sharePopupImage: popupImage.image, sharePopupImageMime: popupImage.mime }
          : {}),
        ...(request.sharePopupTitle?.trim() ? { sharePopupTitle: request.sharePopupTitle.trim() } : {}),
        ...(request.sharePopupBody?.trim() ? { sharePopupBody: request.sharePopupBody.trim() } : {}),
        ...(request.requestsPerMinute == null ? {} : { requestsPerMinute: request.requestsPerMinute }),
        ...(request.dailyTokenLimit == null ? {} : { dailyTokenLimit: request.dailyTokenLimit }),
        ...(request.monthlyTokenLimit == null ? {} : { monthlyTokenLimit: request.monthlyTokenLimit }),
        ...(request.lifetimeTokenBudget == null ? {} : { lifetimeTokenBudget: request.lifetimeTokenBudget }),
        ...(request.maxConcurrentRequests == null ? {} : { maxConcurrentRequests: request.maxConcurrentRequests }),
        ...(request.concurrencyScope !== undefined ? { concurrencyScope: request.concurrencyScope } : {}),
        ...(request.maxChildren == null ? {} : { maxChildren: request.maxChildren }),
        ...pickDefined({ modelPrefix: request.modelPrefix }),
        modelAccessMode: request.modelAccessMode ?? "whitelist",
        ...pickDefined({ modelList: request.modelList }),
        ...(request.clientRouterDenylist === undefined
          ? {}
          : { clientRouterDenylist: request.clientRouterDenylist }),
        createdAt: new Date(),
        tokensConsumed: 0,
      };
      await config.store.create(record);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.created",
        target: record.id,
        detail: { scopes, keyMode },
      });
      return {
        ...sanitizeApiKeyResponse(record),
        ...(generated ? { secret: generated.secret } : {}),
      };
    },
    async updateKey(
      access: AccessDecision | undefined,
      keyId: string,
      request: Partial<CreateApiKeyRequest>,
    ): Promise<UpdateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const patchRequest = parseRequest(request);
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );

      const validated = validateApiKeyRequest(patchRequest);
      finitePositive(patchRequest.requestsPerMinute, "requestsPerMinute");
      finitePositive(patchRequest.dailyTokenLimit, "dailyTokenLimit");
      finitePositive(patchRequest.monthlyTokenLimit, "monthlyTokenLimit");
      finitePositive(patchRequest.lifetimeTokenBudget, "lifetimeTokenBudget");
      finitePositive(patchRequest.maxConcurrentRequests, "maxConcurrentRequests");

      const nextMode = patchRequest.keyMode ?? current.keyMode;
      const modeChanged = nextMode !== current.keyMode;
      const nextPrefix =
        nextMode === "share"
          ? resolveShareKeyPrefix(
              patchRequest.keyPrefix ?? (modeChanged ? undefined : current.keyPrefix),
            )
          : resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix);
      const prefixChanged =
        patchRequest.keyPrefix !== undefined &&
        nextPrefix !== resolveKeyPrefix(current.keyPrefix);

      let secret: string | undefined;
      let credentialPatch: ApiKeyPatch = {};
      if (modeChanged && nextMode === "share") {
        credentialPatch = {
          keyMode: "share",
          keyHash: null,
          keyEncrypted: null,
          keyPrefix: nextPrefix,
        };
      } else if (
        nextMode === "personal" &&
        (modeChanged || patchRequest.key !== undefined || prefixChanged)
      ) {
        const generated = patchRequest.key === undefined
          ? generateApiKeySecret(
              patchRequest.keyPrefix === undefined
                ? undefined
                : resolveKeyPrefix(patchRequest.keyPrefix),
            )
          : {
              ...prepareCustomKey(patchRequest.key),
              prefix: resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix),
            };
        secret = generated.secret;
        credentialPatch = {
          ...(modeChanged ? { keyMode: "personal" as const } : {}),
          keyHash: generated.hash,
          keyEncrypted: encryptCredential(generated.secret),
          keyPrefix: generated.prefix,
        };
      } else if (nextMode === "share" && nextPrefix !== current.keyPrefix) {
        credentialPatch = { keyPrefix: nextPrefix };
      }

      const scopes = patchRequest.scopes === undefined ? undefined : validated.scopes;
      const popupImage = validated.popupImage;
      const updated = await config.store.update(authorized.tenantId, keyId, {
        ...pickDefined({ enabled: patchRequest.enabled }),
        ...(isDefaultGatewayApiKey(current) ? { isDefault: true } : {}),
        ...credentialPatch,
        ...pickDefined({ scopes }),
        // Rename. The label must be copied into the patch explicitly — it is
        // accepted and validated by the body schema but is not the credential,
        // so omitting it here leaves the name unchanged. Blank falls back to the
        // existing label rather than wiping it, since `label` is NOT NULL. The
        // default key is renameable like any other (c2a93545); gating on
        // `isDefault` would drop exactly the one patch that changes a name and
        // leave the store with an empty `set(...)` that throws.
        ...(patchRequest.label === undefined
          ? {}
          : { label: patchRequest.label.trim() === "" ? current.label : patchRequest.label.trim() }),
        ...(patchRequest.notesTitle === undefined
          ? {}
          : { notesTitle: patchRequest.notesTitle.trim() === "" ? null : patchRequest.notesTitle }),
        ...(patchRequest.notesSubtitle === undefined
          ? {}
          : { notesSubtitle: patchRequest.notesSubtitle.trim() === "" ? null : patchRequest.notesSubtitle }),
        ...(patchRequest.notesBody === undefined
          ? {}
          : { notesBody: patchRequest.notesBody.trim() === "" ? null : patchRequest.notesBody }),
        ...pickDefined({ sharePopupEnabled: patchRequest.sharePopupEnabled }),
        ...(popupImage === undefined
          ? {}
          : popupImage === null
            ? { sharePopupImage: null, sharePopupImageMime: null }
            : { sharePopupImage: popupImage.image, sharePopupImageMime: popupImage.mime }),
        ...(patchRequest.sharePopupTitle === undefined ? {} : { sharePopupTitle: patchRequest.sharePopupTitle.trim() || null }),
        ...(patchRequest.sharePopupBody === undefined ? {} : { sharePopupBody: patchRequest.sharePopupBody.trim() || null }),
        ...pickDefined({ requestsPerMinute: patchRequest.requestsPerMinute }),
        ...pickDefined({ dailyTokenLimit: patchRequest.dailyTokenLimit }),
        ...pickDefined({ monthlyTokenLimit: patchRequest.monthlyTokenLimit }),
        ...pickDefined({ lifetimeTokenBudget: patchRequest.lifetimeTokenBudget }),
        ...pickDefined({ maxConcurrentRequests: patchRequest.maxConcurrentRequests }),
        ...(patchRequest.concurrencyScope !== undefined ? { concurrencyScope: patchRequest.concurrencyScope } : {}),
        ...pickDefined({ maxChildren: patchRequest.maxChildren }),
        ...pickDefined({ modelPrefix: patchRequest.modelPrefix }),
        ...pickDefined({ modelAccessMode: patchRequest.modelAccessMode }),
        ...pickDefined({ modelList: patchRequest.modelList }),
        ...(patchRequest.clientRouterDenylist === undefined
          ? {}
          : { clientRouterDenylist: patchRequest.clientRouterDenylist }),
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const children = await config.store.listChildren(authorized.tenantId, keyId);
      invalidateFamilyCaches(keyId, children);
      // The allow/deny list and prefix decide which models `/v1/models`
      // returns, which is a different cache from the auth snapshot: the
      // listing is cached per (tenant, key, mode, list, prefix), so editing
      // one must drop it or the endpoint keeps advertising the old set.
      if (
        patchRequest.modelAccessMode !== undefined ||
        patchRequest.modelList !== undefined ||
        patchRequest.modelPrefix !== undefined
      ) {
        invalidatePublicModels(authorized.tenantId);
      }

      // Denylist / allowlist / scopes are auth-snapshot fields: cache
      // invalidation above is enough. Only quota/concurrency edits need an
      // admission purge — otherwise changing a client denylist would also wipe
      // RPM / daily counters for every recipient mid-day.
      //
      // And only a *tightened* limit needs it. The dashboard edit form always
      // sends all five limit fields, so a `!== undefined` test treated every
      // save — renaming a key, editing notes — as a limit change and dropped
      // the whole family's daily/monthly counters, restarting the budget
      // mid-bucket. Loosening a limit cannot be bypassed by a stale counter
      // (the counter only ever grows toward the new ceiling), so it needs no
      // purge either; only a lowered or newly-added ceiling does.
      const tightened = (
        next: number | null | undefined,
        previous: number | null | undefined,
      ): boolean => {
        if (next === undefined || next === null) return false;
        if (previous === null || previous === undefined) return true;
        return next < previous;
      };
      /** A ceiling that did not exist before this request. */
      const isNewLimit = (
        next: number | null | undefined,
        previous: number | null | undefined,
      ): boolean => next !== undefined && next !== null && (previous === null || previous === undefined);
      const limitsChanged =
        modeChanged ||
        secret !== undefined ||
        tightened(patchRequest.requestsPerMinute, current.requestsPerMinute) ||
        tightened(patchRequest.dailyTokenLimit, current.dailyTokenLimit) ||
        tightened(patchRequest.monthlyTokenLimit, current.monthlyTokenLimit) ||
        tightened(patchRequest.lifetimeTokenBudget, current.lifetimeTokenBudget) ||
        tightened(patchRequest.maxConcurrentRequests, current.maxConcurrentRequests);
      if (limitsChanged) {
        // Drop stale admission counters so a newly lowered one-time/recurring
        // budget cannot be bypassed by a counter seeded under the looser limit.
        // Share children admit under the parent id, so purge the parent too.
        await purgeFamilyAdmission(config.admissionService, keyId, children);
      }
      // Adding a daily/monthly ceiling to a key that already spent in the
      // current bucket must not hand it a full fresh budget: seed the counter
      // from the spend already recorded, so the limit covers the whole bucket.
      // Only a *newly added* ceiling needs this — a lowered one was just
      // purged above, and re-seeding there would restore the baseline the purge
      // removed.
      const dailyAdded = isNewLimit(patchRequest.dailyTokenLimit, current.dailyTokenLimit);
      const monthlyAdded = isNewLimit(patchRequest.monthlyTokenLimit, current.monthlyTokenLimit);
      if ((dailyAdded || monthlyAdded) && config.bucketSpend && config.admissionService.seedBuckets) {
        const now = new Date();
        const spend = await config.bucketSpend(keyId, now).catch(() => null);
        if (spend) {
          await config.admissionService.seedBuckets({
            apiKeyId: keyId,
            now: now.getTime(),
            ...(dailyAdded ? { daily: spend.daily } : {}),
            ...(monthlyAdded ? { monthly: spend.monthly } : {}),
          });
        }
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.updated",
        target: keyId,
        detail: { fields: Object.keys(request) },
      });
      return { ...sanitizeApiKeyResponse(updated), ...pickDefined({ secret }) };
    },
    async deleteKey(access: AccessDecision | undefined, keyId: string): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const target = await config.store.get(authorized.tenantId, keyId);
      if (!target)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // The gateway routes every request off this key and the CLI reads it for
      // the CLI, so removing it would strand the installation with no way to
      // authenticate. Rotation replaces the secret and keeps the key present.
      if (isDefaultGatewayApiKey(target))
        throw new ConsoleDomainError(
          "default_key_not_revocable",
          409,
          "The default gateway API key cannot be deleted. Rotate it instead.",
        );
      const children = await config.store.listChildren(authorized.tenantId, keyId);
      const removed = await config.store.remove(authorized.tenantId, keyId);
      if (!removed) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      invalidateFamilyCaches(keyId, children);
      await purgeFamilyAdmission(config.admissionService, keyId, children);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.deleted",
        target: keyId,
      });
      return { success: true };
    },
    async banKey(
      access: AccessDecision | undefined,
      keyId: string,
      request: BanApiKeyRequest,
    ): Promise<ApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const reason = request.reason.trim();
      if (reason.length === 0)
        throw new ConsoleDomainError("invalid_request", 400, "reason is required");
      // Parse the duration choice. `null` is permanent; absent defaults to one
      // hour. Anything not on the offered list is rejected rather than clamped —
      // clamping would answer a request for 90 days with a week and report
      // success.
      const chosenMinutes = request.minutes === undefined ? DEFAULT_BAN_MINUTES : request.minutes;
      if (!BAN_DURATION_MINUTES.has(chosenMinutes)) {
        throw new ConsoleDomainError(
          "invalid_request",
          400,
          "Unsupported ban duration. Choose one of the offered durations.",
        );
      }
      const bannedUntil = chosenMinutes === null ? null : new Date(Date.now() + chosenMinutes * 60_000);
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // The default gateway key cannot be banned: the ban is a timed or
      // permanent refusal at the auth layer, and the row it names is the
      // credential every gateway request and the CLI authenticate with —
      // banning it is indistinguishable from disabling the installation, which
      // the `enabled` toggle already expresses reversibly. Delete is refused
      // for the same reason (`default_key_not_revocable`).
      if (isDefaultGatewayApiKey(current))
        throw new ConsoleDomainError(
          "default_key_not_bannable",
          409,
          "The default gateway API key cannot be banned. Disable it instead.",
        );
      const banned = await config.store.ban(authorized.tenantId, keyId, reason, bannedUntil);
      if (!banned) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // A banned child key does not affect its share template or sibling keys:
      // `store.ban` only turns off the one row named by `keyId`, and the auth
      // path rejects per key hash. The template keeps issuing working children.
      // A banned key must leave the auth cache for every process at once.
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.banned",
        target: keyId,
        detail: {
          reason,
          // The human-readable label is derived server-side from the machine
          // `reason`, so the audit trail cannot be skewed by a client-authored
          // label. Unknown reasons (custom text) simply carry no label; the
          // free-text `reason` above is still recorded verbatim.
          ...(API_KEY_BAN_REASONS.find((r) => r.value === reason)?.label === undefined
            ? {}
            : { reasonLabel: API_KEY_BAN_REASONS.find((r) => r.value === reason)!.label }),
          ...(bannedUntil === null ? { permanent: true } : { bannedUntil: bannedUntil.toISOString() }),
        },
      });
      // The ban mutates the row already fetched; derive the response from that
      // record instead of re-fetching after the write. Match the store's own
      // mapping: a `null` (permanent) `bannedUntil` is omitted, not carried.
      return sanitizeApiKeyResponse({
        ...current,
        bannedAt: new Date(),
        banReason: reason,
        ...(bannedUntil ? { bannedUntil } : {}),
      });
    },
    async unbanKey(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<ApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const unbanned = await config.store.unban(authorized.tenantId, keyId);
      if (!unbanned) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.unbanned",
        target: keyId,
      });
      // Unban clears all three ban columns and re-enables the key; derive the
      // response from the pre-fetch instead of re-fetching after the write.
      const { bannedAt: _bannedAt, banReason: _banReason, bannedUntil: _bannedUntil, ...currentRest } = current;
      const unbannedRecord: ApiKeyRecord = { ...currentRest, enabled: true };
      return sanitizeApiKeyResponse(unbannedRecord);
    },
  };
  return operations;
}
