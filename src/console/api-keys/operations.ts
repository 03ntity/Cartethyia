// Console API-key domain: operations factory.
//
// Owns the tenant-scoped key lifecycle behind `createApiKeyOperations`:
// validation, credential rotation, share links, shared-key listing, and ban
// handling. The HTTP surface in `routes.ts` delegates every handler here.
//
// The factory composes the lifecycle split across the sibling modules:
// `key-operations.ts` (listing, create/update/delete, ban),
// `share-operations.ts` (share links, regeneration, shared-key surface), and
// `family-cache.ts` (family-wide cache/admission invalidation).

import type { ApiKeyConfig } from "./contracts";
import { createKeyOperations } from "./key-operations";
import { createShareOperations } from "./share-operations";

export function createApiKeyOperations(config: ApiKeyConfig) {
  return {
    ...createKeyOperations(config),
    ...createShareOperations(config),
  };
}
