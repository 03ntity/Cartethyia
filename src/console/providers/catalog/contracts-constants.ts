// Catalog contract constants: runtime tuples and scope vocabularies shared by
// the route Elysia schemas, the operations layer, and the dashboard contract
// mirror.

/**
 * Credential kinds a provider account may carry, as a runtime tuple. The
 * create/update request types and the catalog route's Elysia schema both
 * project it.
 */
export const CREDENTIAL_KINDS = ["api_key", "oauth", "none"] as const;

/** One credential kind. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** Operator-facing credential detection override. */
export const CREDENTIAL_MODES = ["auto", "jwt", "api_key"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];
export const PROVIDER_ROUTING_MAX_INFLIGHT_BOUNDS = { min: 1, max: 10_000 } as const;

/**
 * Scopes that grant catalog access, one pair per resource.
 *
 * Two principals reach these routes and their vocabularies differ: a browser
 * session holds `dashboard:*`, a tenant API key is granted `providers:*` /
 * `models:*`. Keeping both pairs here — rather than at each call site — means a
 * route cannot accidentally accept one principal and lock out the other, and
 * the read/write split is stated once.
 *
 * The catalog scopes stand alone, and that is the point: `dashboard:write` is
 * *not* in these lists. It is a scope a tenant API key can hold, and a key
 * minted to change a display setting must not thereby be able to add an
 * upstream or delete a model — those writes change where traffic goes and which
 * credentials are used. The browser session is granted the catalog scopes
 * explicitly (see `resolveConsoleAccess`) because it is the operator, so the
 * dashboard keeps working without widening what `dashboard:write` means.
 */
export const PROVIDER_READ_SCOPES = ["providers:read"] as const;
export const PROVIDER_WRITE_SCOPES = ["providers:write"] as const;
export const MODEL_READ_SCOPES = ["models:read"] as const;
export const MODEL_WRITE_SCOPES = ["models:write"] as const;

/**
 * Account enable/disable states an operator may set, as a runtime tuple.
 * `cooldown` is health-machine-only and deliberately absent.
 */
export const ACCOUNT_STATUSES = ["active", "disabled"] as const;

/** One operator-settable account status. */
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
