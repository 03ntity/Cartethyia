/**
 * Kiro AWS SSO OIDC wire — client registration, device authorization (RFC 8628),
 * and the authorization-code / refresh-token calls against
 * `oidc.{region}.amazonaws.com`.
 *
 * Every AWS family (Builder ID, IAM Identity Center) reaches the same regional
 * OIDC service, so the request shapes live here once: the client registration
 * the 1.4.62 IDE replays, the device authorize/poll pair, the CreateToken code
 * exchange, and the refresh grant. Callers in `kiro-oauth.ts` supply the fetch
 * implementation and the parameters; this module owns the wire.
 *
 * The registration is the first request a new account makes, so it identifies
 * as the vendor's own IDE rather than as this gateway, and the login flow and
 * the token refresh hit the same host with identical headers — registering bare
 * and then refreshing with a different shape describes two clients holding one
 * client id.
 */
import {
  devicePollBackoff,
  expiryFromSeconds,
  nonEmptyString,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  FetchLike,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import {
  buildKiroSsoAmzUserAgent,
  buildKiroSsoUserAgent,
} from "../../operations/client-versions";
import { deriveOAuthMachineId } from "./kiro-machine-id";
import {
  KIRO_DEFAULT_START_URL,
  assertAwsRegion,
  authStateOf,
  enrichKiroLabel,
  kiroAccountLabel,
  kiroDefaultLabel,
  normalizeRegion,
  resolveKiroProfileArn,
  safeJson,
} from "./kiro-auth-shared";
import type { KiroAuthState } from "./kiro-auth-shared";

/** Scopes the OIDC client registration requests (observed in the 1.4.62 IDE). */
const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const;

/** Grant types the OIDC client registration declares. */
const KIRO_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
] as const;

/** Loopback redirect the 1.4.62 IDE registers for the IdC/Builder-ID flow. */
const KIRO_LOOPBACK_REDIRECT_URI = "http://127.0.0.1/oauth/callback" as const;

/**
 * Client name the OIDC registration presents.
 *
 * The registration is the first request a new account makes, so it identifies as
 * the vendor's own IDE rather than as this gateway.
 */
const KIRO_OIDC_CLIENT_NAME = "Kiro IDE" as const;

/** Credentials the client registration minted and refresh must replay. */
export interface DeviceFlowRegistration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly region: string;
  readonly startUrl: string;
  readonly authMethod: "builder-id" | "idc";
  /**
   * Redirect URI sent on authorize + CreateToken. The registration body itself
   * always declares {@link KIRO_LOOPBACK_REDIRECT_URI} (no port); AWS SSO OIDC
   * accepts a loopback authorize URI that adds a port (RFC 8252).
   */
  readonly redirectUri: string;
}

/**
 * Headers every AWS SSO OIDC request carries.
 *
 * The login flow and the token refresh hit the same `oidc.{region}.amazonaws.com`
 * host, so they must look identical: registering bare and then refreshing with a
 * full SDK User-Agent describes two different clients holding one client id,
 * which is a stronger signal than either shape alone.
 */
function ssoOidcHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "amz-sdk-request": "attempt=1; max=4",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "user-agent": buildKiroSsoUserAgent(),
    "x-amz-user-agent": buildKiroSsoAmzUserAgent(),
  };
}

/**
 * Expiry for a Kiro token response, matching `OAuthClient.calculateExpiry`:
 * a finite non-negative `expires_in` wins, anything else falls back to one hour.
 */
function tokenExpiry(expiresIn: unknown): Date {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
      ? expiresIn
      : 3600;
  return expiryFromSeconds(seconds);
}

/**
 * Authorize/token redirect for AWS SSO OIDC after a portless registration.
 *
 * Registration always declares `http://127.0.0.1/oauth/callback`. RFC 8252 lets
 * the authorize step add a port on that same host; swapping the host to
 * `localhost` (or any other name) is answered `Invalid redirectUri provided`.
 * Port is taken from the console's loopback callback when present.
 */
export function oidcAuthorizeRedirectUri(loopbackCallback: string): string {
  let port = "3128";
  if (loopbackCallback.length > 0) {
    try {
      const parsed = new URL(loopbackCallback);
      if (parsed.port.length > 0) port = parsed.port;
    } catch {
      // keep the Kiro browser default port
    }
  }
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/** Restores a {@link DeviceFlowRegistration} from pending-flow providerState. */
export function parseKiroOidcRegistration(
  providerState: string | undefined,
): DeviceFlowRegistration | undefined {
  if (providerState === undefined || providerState.length === 0) return undefined;
  const parsed = safeJson(providerState);
  const root = record(parsed);
  if (root === undefined) return undefined;
  const clientId = nonEmptyString(root["clientId"]);
  const clientSecret = nonEmptyString(root["clientSecret"]);
  const region = nonEmptyString(root["region"]);
  const startUrl = nonEmptyString(root["startUrl"]);
  const authMethod = root["authMethod"] === "idc" || root["authMethod"] === "builder-id"
    ? root["authMethod"]
    : undefined;
  const redirectUri = nonEmptyString(root["redirectUri"]) ?? KIRO_LOOPBACK_REDIRECT_URI;
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    region === undefined ||
    startUrl === undefined ||
    authMethod === undefined
  ) {
    return undefined;
  }
  return { clientId, clientSecret, region, startUrl, authMethod, redirectUri };
}

/**
 * Registers an OIDC client for the IdC/Builder-ID authorization-code flow.
 *
 * `clientName` and `User-Agent` identify this as the vendor's own IDE client.
 * The registration is the first request a brand-new account ever makes, so it
 * is the one most likely to be looked at: a client name no shipped build uses,
 * or a missing User-Agent, is a shape the real client never produces.
 *
 * The 1.4.62 IDE registers a public client with `authorization_code` grant and
 * the loopback redirect, and declares the issuer (the start URL) so the
 * authorization server knows which organization/portal this client belongs to.
 */
export async function registerKiroOidcClient(
  fetchFn: FetchLike,
  region: string,
  startUrl: string,
  authMethod: "builder-id" | "idc",
  redirectUri = KIRO_LOOPBACK_REDIRECT_URI,
): Promise<DeviceFlowRegistration> {
  const response = await fetchFn(`https://oidc.${region}.amazonaws.com/client/register`, {
    method: "POST",
    headers: ssoOidcHeaders(),
    body: JSON.stringify({
      clientName: KIRO_OIDC_CLIENT_NAME,
      clientType: "public",
      scopes: [...KIRO_SCOPES],
      grantTypes: [...KIRO_GRANT_TYPES],
      redirectUris: [redirectUri],
      issuerUrl: startUrl,
    }),
  });
  const payload = record(await readJsonResponse(response, "kiro client registration")) ?? {};
  const clientId = nonEmptyString(payload["clientId"]);
  const clientSecret = nonEmptyString(payload["clientSecret"]);
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error("Kiro client registration omitted credentials");
  }
  return { clientId, clientSecret, region, startUrl, authMethod, redirectUri };
}

/**
 * Starts the AWS SSO OIDC device authorization.
 *
 * The same client registration the browser flow uses is reused: register a
 * public client for the chosen family/region, then ask the regional OIDC
 * service for a device code. The registration is carried in `providerState`
 * so the poll can replay it at the token endpoint.
 */
export async function startKiroDeviceFlow(
  fetchFn: FetchLike,
  parameters: Readonly<Record<string, string>>,
): Promise<OAuthDeviceStartResult> {
  const authMethod = parameters["authMethod"] === "idc" ? "idc" : "builder-id";
  const region = normalizeRegion(parameters["region"]);
  const startUrl = nonEmptyTrimmedString(parameters["startUrl"]) ?? KIRO_DEFAULT_START_URL;
  assertAwsRegion(region);
  const registration = await registerKiroOidcClient(fetchFn, region, startUrl, authMethod);

  const response = await fetchFn(
    `https://oidc.${region}.amazonaws.com/device_authorization`,
    {
      method: "POST",
      headers: ssoOidcHeaders(),
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        startUrl,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = record(await readJsonResponse(response, "kiro device authorization")) ?? {};
  const start = parseDeviceAuthStart(payload, { intervalSeconds: 5, expiresInSeconds: 600 });
  if (start === undefined) {
    throw new Error("Kiro device authorization returned an invalid response");
  }
  return {
    verificationUri: start.verificationUriComplete ?? start.verificationUri,
    userCode: start.userCode,
    deviceAuthId: start.deviceCode,
    intervalSeconds: start.intervalSeconds,
    expiresInSeconds: start.expiresInSeconds,
    providerState: JSON.stringify(registration),
  };
}

/** Polls the AWS SSO OIDC token endpoint for the device grant result. */
export async function pollKiroDeviceFlow(
  fetchFn: FetchLike,
  deviceAuthId: string,
  providerState: string | undefined,
): Promise<OAuthDevicePollResult> {
  const registration = parseKiroOidcRegistration(providerState);
  if (registration === undefined) {
    return { status: "failed", reason: "unknown device authorization" };
  }
  const region = assertAwsRegion(registration.region);
  let response: Response;
  try {
    response = await fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: ssoOidcHeaders(),
      body: JSON.stringify({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        deviceCode: deviceAuthId,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "Kiro device polling failed" };
  }
  const payload = record(await response.json().catch(() => undefined)) ?? {};
  if (response.status === 400 || response.status === 428) {
    const err = typeof payload.error === "string" ? payload.error : "";
    const verdict = devicePollBackoff(err, payload.interval);
    if (verdict !== undefined) return verdict;
    return { status: "failed", reason: err || `device polling failed (${response.status})` };
  }
  const access = nonEmptyString(payload["accessToken"]);
  if (!response.ok || access === undefined) {
    const detail = nonEmptyString(payload["error_description"]) ?? nonEmptyString(payload["error"]);
    return {
      status: "failed",
      reason: detail ?? `Kiro device polling failed (${response.status})`,
    };
  }
  const refresh = nonEmptyString(payload["refreshToken"]) ?? "";
  const profileArn = nonEmptyString(payload["profileArn"]);
  const authState: KiroAuthState = {
    authMethod: registration.authMethod,
    region,
    ...(profileArn === undefined ? {} : { profileArn }),
    startUrl: registration.startUrl,
    clientId: registration.clientId,
    machineId: deriveOAuthMachineId(refresh),
  };
  const label =
    kiroAccountLabel(access) ??
    (await enrichKiroLabel(
      access,
      authState,
      kiroDefaultLabel(registration.authMethod),
      fetchFn,
    ));
  return {
    status: "complete",
    result: {
      access,
      refresh,
      expiresAt: tokenExpiry(payload["expiresIn"]),
      accountLabel: label,
      auth_state: authStateOf(authState),
      client_secret: registration.clientSecret,
    },
  };
}

/**
 * The authorize URL for the second browser leg of an IdC/Builder-ID sign-in.
 *
 * The portal's first callback carries no `code`, only `login_option` +
 * `issuer_url` + `idc_region`; the exchange registers an OIDC client, mints a
 * fresh PKCE pair, and sends the operator to the regional authorize endpoint.
 * Scopes are comma-joined, matching the 1.4.62 IDE.
 */
export function kiroOidcAuthorizeUrl(
  region: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scopes: KIRO_SCOPES.join(","),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://oidc.${region}.amazonaws.com/authorize?${authorizeParams.toString()}`;
}

/** Exchanges an IdC/Builder-ID authorization code via AWS SSO OIDC CreateToken. */
export async function exchangeKiroIdcCode(
  fetchFn: FetchLike,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  registration: DeviceFlowRegistration,
): Promise<OAuthExchangeResult> {
  const response = await fetchFn(`https://oidc.${registration.region}.amazonaws.com/token`, {
    method: "POST",
    headers: ssoOidcHeaders(),
    body: JSON.stringify({
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      grantType: "authorization_code",
      code,
      redirectUri,
      codeVerifier,
    }),
  });
  const payload = record(await readJsonResponse(response, "kiro IdC token exchange")) ?? {};
  const access = nonEmptyString(payload["accessToken"]);
  if (access === undefined) {
    const detail = nonEmptyString(payload["error_description"]) ?? nonEmptyString(payload["error"]);
    throw new Error(`Kiro IdC token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
  }
  const refresh = nonEmptyString(payload["refreshToken"]) ?? "";
  const reported = nonEmptyString(payload["profileArn"]);
  const profileArn =
    reported ?? (await resolveKiroProfileArn(fetchFn, access, registration.region, registration.authMethod));
  const authState: KiroAuthState = {
    authMethod: registration.authMethod,
    region: registration.region,
    ...(profileArn === undefined ? {} : { profileArn }),
    startUrl: registration.startUrl,
    clientId: registration.clientId,
    machineId: deriveOAuthMachineId(refresh),
  };
  const label =
    kiroAccountLabel(access) ??
    (await enrichKiroLabel(
      access,
      authState,
      kiroDefaultLabel(registration.authMethod),
      fetchFn,
    ));
  return {
    access,
    refresh,
    expiresAt: tokenExpiry(payload["expiresIn"]),
    accountLabel: label,
    auth_state: authStateOf(authState),
    client_secret: registration.clientSecret,
  };
}

/** Refreshes through the regional AWS SSO OIDC token endpoint. */
export async function refreshKiroOidcTokens(
  fetchFn: FetchLike,
  refreshToken: string,
  registration: Omit<DeviceFlowRegistration, "redirectUri">,
  signal?: AbortSignal,
): Promise<{
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
  readonly profileArn?: string;
}> {
  const region = assertAwsRegion(registration.region);
  const response = await fetchFn(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: ssoOidcHeaders(),
    body: JSON.stringify({
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      refreshToken,
      grantType: "refresh_token",
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
  const access = nonEmptyString(payload["accessToken"]);
  if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
  const profileArn = nonEmptyString(payload["profileArn"]);
  return {
    access,
    refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
    expiresAt: tokenExpiry(payload["expiresIn"]),
    ...(profileArn === undefined ? {} : { profileArn }),
  };
}

/**
 * Signals that an OIDC portal callback needs a second browser leg: the portal
 * returns `login_option=builderid|awsidc` without a code, and the real
 * authorize URL for the regional AWS SSO OIDC service is attached so the route
 * can redirect the operator to it. Carries the fresh PKCE verifier and the
 * serialized registration so `completeLogin` can rewrite the pending flow
 * before sending the browser on — memory alone is not enough across gateways.
 */
export class KiroOidcPendingError extends Error {
  readonly authorizeUrl: string;
  readonly codeVerifier: string;
  readonly providerState: string;
  readonly continueState: string;
  constructor(
    authorizeUrl: string,
    codeVerifier: string,
    providerState: string,
    continueState: string,
  ) {
    super(`Kiro OIDC requires a second authorization step: ${authorizeUrl}`);
    this.name = "KiroOidcPendingError";
    this.authorizeUrl = authorizeUrl;
    this.codeVerifier = codeVerifier;
    this.providerState = providerState;
    this.continueState = continueState;
  }
}
