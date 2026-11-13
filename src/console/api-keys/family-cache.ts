// Family-wide cache and admission-counter invalidation shared by the API-key
// operations: a parent key and every child move together.

import { invalidateApiKeyCache } from "../../security/api-key-auth";
import type { ApiKeyRecord } from "../../persistence/stores/api-key-store";

/**
 * Drops the auth-cache snapshot for a key family: the parent first, then
 * every child.
 *
 * Parent policy is live-inherited by children at auth time, so their cached
 * snapshots must die with the parent — otherwise a denylist / budget edit
 * looks like a no-op for up to AUTH_CACHE_TTL_MS per child.
 */
export function invalidateFamilyCaches(keyId: string, children: readonly ApiKeyRecord[]): void {
  invalidateApiKeyCache(keyId);
  for (const child of children) invalidateApiKeyCache(child.id);
}

/**
 * Purges admission counters for a key family: the parent first, then every
 * child.
 *
 * Share children admit under the parent id, so the parent's counter must die
 * with a revoked/regenerated parent too — otherwise a family budget can be
 * bypassed by a counter seeded under the old credential.
 */
export async function purgeFamilyAdmission(
  admissionService: { purgeKey(apiKeyId: string): Promise<void> },
  keyId: string,
  children: readonly ApiKeyRecord[],
): Promise<void> {
  await Promise.all([
    admissionService.purgeKey(keyId),
    ...children.map((child) => admissionService.purgeKey(child.id)),
  ]);
}
