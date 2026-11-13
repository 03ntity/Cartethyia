/**
 * Kiro auth shared contract — the account-side configuration and helpers every
 * sign-in family produces and consumes.
 *
 * `auth_state` is where the per-account configuration lives (the profile the
 * account is bound to, the region it was minted in, and how it authenticates),
 * because the dispatched request and the refresh both need it and the
 * credential string cannot express it. The helpers here are the single owner of
 * that shape: parsing it back, deriving labels, validating an enterprise
 * endpoint, and resolving the profile ARN — all shared by the OIDC, social,
 * and import flows in `kiro-oauth.ts` / `kiro-oidc.ts`.
 */
import {
  decodeJwtPayload,
  nonEmptyString,
  nonEmptyTrimmedString,
  record,
} from "../../authentication/oauth-flow-store";
import type { FetchLike } from "../../authentication/oauth-flow-store";
import { normalizeMachineId } from "./kiro-machine-id";
import {
  AWS_REGION_PATTERN,
  KIRO_DEFAULT_REGION,
  KIRO_MANAGEMENT_HOST_TEMPLATE,
} from "./kiro-catalog";
import { fetchKiroQuota } from "./kiro-quota";

/** Auth methods this integration supports, as stored on the account. */
export type KiroAuthMethod =
  | "builder-id"
  | "idc"
  | "google"
  | "github"
  | "imported"
  | "external_idp"
  | "api_key";

/** The vendor's own sign-in and refresh service for the social families. */
export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev" as const;

/** The web portal that offers the merged social/OIDC sign-in. */
export const KIRO_SOCIAL_PORTAL = "https://app.kiro.dev" as const;

/**
 * Redirect URI the vendor's identity provider allowlists. It is a custom
 * scheme, not a loopback address: the authorization code is shown to the
 * operator rather than delivered to a local listener. The 1.4.62 IDE uses
 * `kiro://kiro.oauth/callback` (observed in the agent bundle).
 */
export const KIRO_SOCIAL_REDIRECT_URI = "kiro://kiro.oauth/callback" as const;

/** Organization entry point the IdC/Builder-ID flow starts from by default. */
export const KIRO_DEFAULT_START_URL = "https://view.awsapps.com/start" as const;

/** Microsoft login hosts an enterprise token endpoint may point at. */
const MICROSOFT_TOKEN_HOSTS = new Set([
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.windows.net",
]);

/**
 * The account-side configuration carried in `auth_state`.
 *
 * `machineId` is part of it because it is derived once from the credential and
 * must not move afterwards: a refresh rotates the refresh token, and a device id
 * derived per request from the rotating material would make one account appear
 * to be a different machine on every refresh.
 */
export interface KiroAuthState {
  readonly authMethod: KiroAuthMethod;
  readonly region: string;
  readonly profileArn?: string;
  /** Identity Center organization URL, when the account came from one. */
  readonly startUrl?: string;
  /** OIDC client id from the IdC/Builder-ID client registration. */
  readonly clientId?: string;
  /** Enterprise identity-provider token endpoint. */
  readonly tokenEndpoint?: string;
  /** Enterprise identity-provider scopes. */
  readonly scope?: string;
  /** Frozen device identity presented in the User-Agent. */
  readonly machineId?: string;
}

/** Rejects a region that is not an AWS region before it reaches a URL. */
export function assertAwsRegion(region: string): string {
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error("Kiro region must be a valid AWS region");
  }
  return region;
}

/** Normalizes a stored region, falling back to the default. */
export function normalizeRegion(value: unknown): string {
  const region = typeof value === "string" ? value.trim() : "";
  return AWS_REGION_PATTERN.test(region) ? region : KIRO_DEFAULT_REGION;
}

/** Reads the account's `auth_state` back into a typed value. */
export function parseKiroAuthState(value: unknown): KiroAuthState | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const authMethod = nonEmptyString(raw["authMethod"]);
  if (authMethod === undefined || !isKiroAuthMethod(authMethod)) return undefined;
  const profileArn = nonEmptyTrimmedString(raw["profileArn"]);
  const startUrl = nonEmptyTrimmedString(raw["startUrl"]);
  const clientId = nonEmptyTrimmedString(raw["clientId"]);
  const tokenEndpoint = nonEmptyTrimmedString(raw["tokenEndpoint"]);
  const scope = nonEmptyTrimmedString(raw["scope"]);
  const machineId = normalizeMachineId(raw["machineId"]);
  return {
    authMethod,
    region: normalizeRegion(raw["region"]),
    ...(profileArn === undefined ? {} : { profileArn }),
    ...(startUrl === undefined ? {} : { startUrl }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
    ...(scope === undefined ? {} : { scope }),
    ...(machineId === undefined ? {} : { machineId }),
  };
}

function isKiroAuthMethod(value: string): value is KiroAuthMethod {
  return (
    value === "builder-id" ||
    value === "idc" ||
    value === "google" ||
    value === "github" ||
    value === "imported" ||
    value === "external_idp" ||
    value === "api_key"
  );
}

/** The `auth_state` object to persist for one flow. */
export function authStateOf(state: KiroAuthState): Readonly<Record<string, unknown>> {
  return { ...state };
}

/**
 * Validates an enterprise identity-provider token endpoint.
 *
 * The endpoint comes from imported JSON and receives the account's refresh
 * token, so it is restricted to the Microsoft login hosts rather than trusted
 * as given.
 */
export function validateMicrosoftTokenEndpoint(raw: unknown): string {
  const endpoint = typeof raw === "string" ? raw.trim() : "";
  if (endpoint.length === 0) throw new Error("token_endpoint is required");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("token_endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("token_endpoint must use https");
  if (!MICROSOFT_TOKEN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("token_endpoint must be a Microsoft login endpoint");
  }
  return parsed.toString();
}

/** Best-effort display label for a credential. */
export function kiroAccountLabel(accessToken: string | undefined): string | undefined {
  const payload = accessToken === undefined ? undefined : decodeJwtPayload(accessToken);
  if (payload === undefined) return undefined;
  for (const key of ["email", "preferred_username", "upn", "sub"]) {
    const value = nonEmptyTrimmedString(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Falls back to an informative per-family label when the token carries no
 * readable identity (the social access token is opaque, not a JWT). The
 * console otherwise labels every Kiro account "kiro".
 */
export function kiroDefaultLabel(authMethod: KiroAuthMethod): string {
  switch (authMethod) {
    case "google":
      return "Google account";
    case "github":
      return "GitHub account";
    case "builder-id":
      return "AWS Builder ID";
    case "idc":
      return "IAM Identity Center";
    case "external_idp":
      return "Enterprise IdP";
    case "imported":
      return "Imported Kiro session";
    case "api_key":
      return "Kiro API key";
  }
}

/**
 * Every stock fallback label `kiroDefaultLabel` can produce. The quota refresh
 * sweep may adopt an upstream-reported identity (an email from `GetUsageLimits`)
 * over any label in this set — those are generated defaults, never an operator's
 * rename — but leaves anything else alone.
 */
export const KIRO_DEFAULT_LABELS: ReadonlySet<string> = new Set(
  (
    ["google", "github", "builder-id", "idc", "external_idp", "imported", "api_key"] as const
  ).map(kiroDefaultLabel),
);

/**
 * Best-effort account-label enrichment for a completed sign-in.
 *
 * Called only when {@link kiroAccountLabel} found no identity in the access
 * token — the opaque ones (social, Builder-ID/IdC, imported) — so the usage
 * surface is asked for the account email instead, the same call the quota
 * sweep makes. The call is guarded: a failure keeps the family `fallback`
 * rather than failing a login that already succeeded.
 */
export async function enrichKiroLabel(
  accessToken: string,
  authState: KiroAuthState,
  fallback: string,
  fetchFn: FetchLike,
): Promise<string> {
  try {
    const quota = await fetchKiroQuota(accessToken, fetchFn, { auth_state: authStateOf(authState) });
    const accountLabel = quota.accountLabel;
    if (accountLabel !== undefined && accountLabel.trim().length > 0) return accountLabel;
  } catch {
    // keep the family fallback
  }
  return fallback;
}

/**
 * Resolves the profile ARN an account is bound to.
 *
 * Profile-scoped surfaces refuse a request that omits the field (`400
 * profileArn is required for this request.`), and an Identity Center account
 * whose token response carried no profile needs its own resolved before it is
 * persisted. `GetProfile` on the Kiro control-plane service is that lookup: a
 * POST with an `x-amz-target` header on `https://management.{region}.kiro.dev`.
 *
 * A Builder ID account is skipped rather than asked: the operation refuses
 * that family outright (`403 AWS Builder ID is not supported for this
 * operation.`), and a login path is no place to spend a request that is known
 * to be refused. Such an account is served by its family's public default.
 *
 * Returns `undefined` rather than throwing. Resolution runs on the login path,
 * and an account whose profile cannot be read still has to be persisted — the
 * operator can supply the ARN by import, and a failure here must not block a
 * sign-in that otherwise succeeded.
 */
export async function resolveKiroProfileArn(
  fetchFn: FetchLike,
  accessToken: string,
  region: string = KIRO_DEFAULT_REGION,
  authMethod?: KiroAuthMethod,
): Promise<string | undefined> {
  if (authMethod === "builder-id") return undefined;
  const safeRegion = assertAwsRegion(normalizeRegion(region));
  try {
    const host = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", safeRegion);
    const response = await fetchFn(`${host}/Get-Profile`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "KiroControlPlaneBearerService.GetProfile",
        accept: "application/json",
        connection: "close",
        "amz-sdk-request": "attempt=1; max=1",
        "amz-sdk-invocation-id": crypto.randomUUID(),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const payload = record(await response.json().catch(() => undefined));
    const profile = record(payload?.["profile"]);
    const arn = nonEmptyTrimmedString(profile?.["arn"] ?? profile?.["profileArn"]);
    if (arn !== undefined) return arn;
    const profiles = payload?.["profiles"];
    if (Array.isArray(profiles)) {
      let fallback: string | undefined;
      for (const entry of profiles) {
        const p = record(entry);
        const value = nonEmptyTrimmedString(p?.["arn"] ?? p?.["profileArn"]);
        if (value === undefined) continue;
        if (value.includes(`:${safeRegion}:`)) return value;
        fallback ??= value;
      }
      return fallback;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parses JSON without throwing. */
export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
