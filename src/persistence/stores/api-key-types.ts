// Types shared by the API-key store and its consumers: the persisted record
// shape, the partial patch contract, and the paged share-child listing types.

import type { ApiKeyMode, ApiKeyModelAccessMode, ApiKeyConcurrencyScope } from "../schema";
import type { AccessScope } from "../../security/access-control";

/** Sortable columns for the paged share-child listing (api_keys columns only). */
export type SharedChildSortColumn =
  | "createdAt"
  | "label"
  | "keyPrefix"
  | "issuedClientIp"
  | "revokedAt"
  | "enabled";

export interface SharedChildrenPageOptions {
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: SharedChildSortColumn;
  readonly order: "asc" | "desc";
  readonly status: "all" | "active" | "revoked";
}

export interface SharedChildrenPage {
  readonly rows: readonly ApiKeyRecord[];
  readonly total: number;
  readonly active: number;
  readonly revoked: number;
  /** Family-wide `lifetime_tokens_consumed` sum, independent of the page. */
  readonly consumed: number;
}

/** Persisted API key. Only its one-way hash authenticates; plaintext is never stored. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string | null;
  readonly keyMode: ApiKeyMode;
  readonly parentKeyId?: string;
  readonly issuedClientIp?: string;
  readonly issuedClientIpKey?: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly scopes: readonly AccessScope[];
  /** The tenant's mandatory gateway key: rotatable, never revocable. */
  readonly isDefault: boolean;
  /** Non-secret prefix configured on a key or used to identify a share child. */
  readonly keyPrefix?: string;
  /** Encrypted copy exists only for personal keys used by CLI handoff. */
  readonly keyEncrypted?: Buffer;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly sharePopupEnabled?: boolean;
  /** Uploaded popup art; served from the share page rather than a remote URL. */
  readonly sharePopupImage?: Buffer;
  readonly sharePopupImageMime?: string;
  readonly sharePopupTitle?: string;
  readonly sharePopupBody?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly maxConcurrentRequests?: number;
  readonly concurrencyScope?: ApiKeyConcurrencyScope;
  /** Share-template recipient slot cap; undefined = unlimited. */
  readonly maxChildren?: number;
  readonly modelPrefix?: string;
  readonly modelAccessMode?: ApiKeyModelAccessMode;
  readonly modelList?: readonly string[];
  /** Client-router ids this key refuses; see the schema column for the contract. */
  readonly clientRouterDenylist?: readonly string[];
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  /** Ban state; see the schema column for the contract. */
  readonly bannedAt?: Date;
  readonly banReason?: string;
  /** When the ban lifts on its own; null means permanent. */
  readonly bannedUntil?: Date;
  readonly tokensConsumed: number;
}

/**
 * Partial key update. Nullable policy fields clear their values; `undefined`
 * leaves them unchanged. Credential metadata is writable only for a mode
 * transition performed by the API-key domain.
 */
export interface ApiKeyPatch
  extends Omit<
    Partial<ApiKeyRecord>,
    | "id"
    | "tenantId"
    | "keyHash"
    | "parentKeyId"
    | "issuedClientIp"
    | "issuedClientIpKey"
    | "createdAt"
    | "revokedAt"
    | "tokensConsumed"
    | "keyEncrypted"
    | "keyPrefix"
    | "notesTitle"
    | "notesSubtitle"
    | "notesBody"
    | "sharePopupEnabled"
    | "sharePopupImage"
    | "sharePopupImageMime"
    | "sharePopupTitle"
    | "sharePopupBody"
    | "requestsPerMinute"
    | "dailyTokenLimit"
    | "monthlyTokenLimit"
    | "lifetimeTokenBudget"
    | "maxConcurrentRequests"
    | "maxChildren"
    | "bannedAt"
    | "banReason"
    | "bannedUntil"
  > {
  readonly keyHash?: string | null;
  readonly keyEncrypted?: Buffer | null;
  readonly keyPrefix?: string | null;
  readonly notesTitle?: string | null;
  readonly notesSubtitle?: string | null;
  readonly notesBody?: string | null;
  readonly sharePopupEnabled?: boolean | null;
  /** Null clears both bytes and mime; setting one without the other is rejected upstream. */
  readonly sharePopupImage?: Buffer | null;
  readonly sharePopupImageMime?: string | null;
  readonly sharePopupTitle?: string | null;
  readonly sharePopupBody?: string | null;
  readonly requestsPerMinute?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly lifetimeTokenBudget?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly maxChildren?: number | null;
  /** Ban state; a ban also disables the key, unban clears both columns entirely. */
  readonly bannedAt?: Date | null;
  readonly banReason?: string | null;
  /** When the ban lifts on its own; null (explicit) means permanent. */
  readonly bannedUntil?: Date | null;
}
