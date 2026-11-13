// Share and handoff operations for the console API-key domain: stable share
// links, key regeneration with link rotation, reveal, and the shared-key
// listing/activity/revoke surface. Composed into `createApiKeyOperations`.

import { randomBytes } from "node:crypto";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import { generateShareSlug, hashShareToken } from "../../persistence/stores/share-store";
import type { AccessDecision } from "../../security/access-control";
import { ConsoleDomainError, requireTenantScope } from "../shared/errors";
import type { ShareLinkKind } from "../../persistence/schema";
import type { ApiKeyConfig, ShareKeyResponse, ShareLinkResponse } from "./contracts";
import { generateApiKeySecret, mapShareLinkResponse } from "./contracts";
import type { SharedKeyActivityDetail, SharedKeySummary } from "../share/share-usage";
import type { SharedChildSortColumn, SharedChildrenPageOptions } from "../../persistence/stores/api-key-store";
import { invalidateFamilyCaches, purgeFamilyAdmission } from "./family-cache";

const SHARED_CHILD_SORT_COLUMNS = new Set<SharedChildSortColumn>([
  "createdAt",
  "label",
  "keyPrefix",
  "issuedClientIp",
  "revokedAt",
  "enabled",
]);

/** Parses and bounds the paginated share-child list query. */
function parseSharedChildrenQuery(query: URLSearchParams): SharedChildrenPageOptions {
  const limitRaw = query.get("limit");
  const offsetRaw = query.get("offset");
  const sortRaw = query.get("sort");
  const orderRaw = query.get("order");
  const statusRaw = query.get("status");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ConsoleDomainError("invalid_request", 400, "limit must be an integer between 1 and 500");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ConsoleDomainError("invalid_request", 400, "offset must be a non-negative integer");
  }
  const sortBy = (sortRaw ?? "createdAt") as SharedChildSortColumn;
  if (!SHARED_CHILD_SORT_COLUMNS.has(sortBy)) {
    throw new ConsoleDomainError("invalid_request", 400, `unsupported sort column: ${String(sortBy)}`);
  }
  const order = orderRaw === "asc" ? "asc" : "desc";
  const status = statusRaw === "active" || statusRaw === "revoked" ? statusRaw : "all";
  return { limit, offset, sortBy, order, status };
}

export function createShareOperations(config: ApiKeyConfig) {
  const operations = {
    /**
     * Establishes or rotates the key's single stable link.
     *
     * The console shows one link that never moves; `regenerate` replaces the
     * token in place so the previous URL stops resolving. A share template
     * hands out child keys; a personal key hands out the key itself.
     */
    async shareKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { expiresAt?: string | null; origin?: string; regenerate?: boolean } = {},
    ): Promise<ShareKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const kind: ShareLinkKind = record.keyMode === "share" ? "enroll" : "handoff";
      const origin = (options.origin ?? "").replace(/\/$/, "");
      // Re-issuing without regeneration must return the link that is actually
      // stored. Minting a fresh token here would hand back a URL that was never
      // persisted, so the link would be dead on arrival.
      if (options.regenerate !== true) {
        const existing = await shareStore.findTokenForApiKey(keyId);
        if (existing !== null && existing.tokenEncrypted !== null) {
          try {
            const token = decryptCredentialToString(existing.tokenEncrypted);
            return {
              id: existing.id,
              url: `${origin}/share/${token}`,
              token,
              kind: existing.kind,
              expiresAt: existing.expiresAt === null ? null : existing.expiresAt.toISOString(),
            };
          } catch {
            // A row written under a different encryption key cannot be shown;
            // fall through and establish a fresh link.
          }
        }
      }
      let expiresAt: Date | null = null;
      if (options.expiresAt !== undefined && options.expiresAt !== null) {
        const parsed = new Date(options.expiresAt);
        if (Number.isNaN(parsed.getTime()))
          throw new ConsoleDomainError(
            "invalid_share_expiry",
            400,
            "expiresAt must be a valid ISO timestamp",
          );
        expiresAt = parsed;
      }
      const token = randomBytes(32).toString("base64url");
      const link = await shareStore.create({
        apiKeyId: keyId,
        tokenHash: hashShareToken(token),
        tokenEncrypted: encryptCredential(token),
        slug: generateShareSlug(),
        kind,
        expiresAt,
        rotate: options.regenerate === true,
      });
      await config.auditSink?.record({
        access: authorized,
        action: options.regenerate === true ? "api_key.share_regenerated" : "api_key.shared",
        target: keyId,
        detail: { shareId: link.id, kind },
      });
      return {
        id: link.id,
        url: `${origin}/share/${token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * The key's stable link with its retained token, for the console to show
     * without rotating it. Returns null when the key has no link yet or the
     * link predates token retention.
     */
    async getShare(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<ShareKeyResponse | null> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const link = await shareStore.findTokenForApiKey(keyId);
      if (link === null) return null;
      let token: string | null = null;
      if (link.tokenEncrypted !== null) {
        try {
          token = decryptCredentialToString(link.tokenEncrypted);
        } catch {
          // A row written under a different encryption key cannot be shown.
          // The page itself survives: the slug is held in the clear, so the
          // address stays valid and the operator only loses the bearer half.
          token = null;
        }
      }
      // Nothing to point at: neither the address nor the secret survived.
      if (token === null && link.slug === null) return null;
      const origin = (options.origin ?? "").replace(/\/$/, "");
      return {
        id: link.id,
        // The slug is the address; the token is the bearer half. Preferring the
        // slug keeps a restored page reachable under the same URL even when the
        // encryption key that sealed its token is gone.
        url: `${origin}/share/${link.slug ?? token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * Rotates a personal key's credential in place and re-points its handoff
     * link at the new secret. Share templates have no credential of their own,
     * so they are rejected here.
     */
    async regenerateKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<{ secret: string; share: ShareKeyResponse | null }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );
      if (current.keyMode !== "personal")
        throw new ConsoleDomainError(
          "key_not_personal",
          409,
          "Only a personal key can be regenerated; rotate a share template's link instead",
        );
      const generated = generateApiKeySecret();
      const updated = await config.store.update(authorized.tenantId, keyId, {
        keyHash: generated.hash,
        keyEncrypted: encryptCredential(generated.secret),
        keyPrefix: generated.prefix,
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      // Regeneration is personal-key only, so the family is the key itself.
      invalidateFamilyCaches(keyId, []);
      await purgeFamilyAdmission(config.admissionService, keyId, []);
      const shareStore = config.shareStore;
      let share: ShareKeyResponse | null = null;
      if (shareStore) {
        const token = randomBytes(32).toString("base64url");
        const link = await shareStore.create({
          apiKeyId: keyId,
          tokenHash: hashShareToken(token),
          tokenEncrypted: encryptCredential(token),
          slug: generateShareSlug(),
          kind: "handoff",
          expiresAt: null,
          rotate: true,
        });
        const origin = (options.origin ?? "").replace(/\/$/, "");
        share = {
          id: link.id,
          url: `${origin}/share/${token}`,
          token,
          kind: link.kind,
          expiresAt: null,
        };
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.regenerated",
        target: keyId,
      });
      return { secret: generated.secret, share };
    },
    /**
     * Returns a personal key's stored secret. The ciphertext exists exactly so
     * the owner can read it back; a share template has none, so it is refused.
     */
    async revealKey(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<{ secret: string }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.keyMode !== "personal" || current.keyEncrypted === undefined)
        throw new ConsoleDomainError(
          "key_not_personal",
          409,
          "Only a personal key keeps a recoverable secret",
        );
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.revealed",
        target: keyId,
      });
      return { secret: decryptCredentialToString(current.keyEncrypted) };
    },
    async listShares(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<ShareLinkResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      if (!config.shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      return (await config.shareStore.listForApiKey(keyId)).map(mapShareLinkResponse);
    },
    async listSharedKeys(
      access: AccessDecision | undefined,
      parentKeyId: string,
      query: URLSearchParams,
    ): Promise<{
      rows: readonly SharedKeySummary[];
      total: number;
      active: number;
      revoked: number;
      consumed: number;
    }> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const options = parseSharedChildrenQuery(query);
      const page = await config.store.listChildrenPage(authorized.tenantId, parentKeyId, options);
      const rows = await activity.getSharedKeySummaries(
        authorized.tenantId,
        page.rows,
        parentKeyId,
      );
      return { rows, total: page.total, active: page.active, revoked: page.revoked, consumed: page.consumed };
    },
    async getSharedKeyActivity(
      access: AccessDecision | undefined,
      parentKeyId: string,
      childKeyId: string,
    ): Promise<SharedKeyActivityDetail> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      // Membership is one indexed row read, not a scan of the whole family.
      const child = await config.store.get(authorized.tenantId, childKeyId);
      if (!child || child.parentKeyId !== parentKeyId)
        throw new ConsoleDomainError("key_not_found", 404, "Shared API key not found");
      return activity.getSharedKeyDetail(authorized.tenantId, childKeyId);
    },
    async revokeSharedScope(
      access: AccessDecision | undefined,
      parentKeyId: string,
      scope: "active" | "unused",
    ): Promise<{ success: true; deleted: number }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const deleted = await config.store.revokeChildrenByScope(
        authorized.tenantId,
        parentKeyId,
        scope,
      );
      // Raw batched deletes bypass the per-key purge path; drop the whole auth
      // cache so no resolved identity survives for a removed recipient.
      invalidateApiKeyCache();
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.share_revoked_scope",
        target: parentKeyId,
        detail: { scope, deleted },
      });
      return { success: true, deleted };
    },
    async revokeShare(
      access: AccessDecision | undefined,
      keyId: string,
      shareId: string,
    ): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const revoked = await shareStore.revoke(keyId, shareId);
      if (!revoked) throw new ConsoleDomainError("share_not_found", 404, "Share link not found");
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.share_revoked",
        target: shareId,
        detail: { keyId },
      });
      return { success: true };
    },
  };
  return operations;
}
