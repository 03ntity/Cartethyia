/**
 * Kiro (AWS CodeWhisperer) authentication.
 *
 * Kiro has no single sign-in: the same subscription is reached through AWS
 * Builder ID, an Identity Center organization, Google/GitHub social sign-in, an
 * imported refresh token, an enterprise Microsoft identity provider, or a plain
 * API key. They differ in where the token comes from, how it is refreshed, and —
 * critically — which upstream host will accept it.
 *
 * What they share is the account-side configuration every later request needs
 * (the profile the account is bound to, the region it was minted in, and how it
 * authenticates). That travels in `auth_state` beside the tokens, because the
 * dispatched request and the refresh both need it and the credential string
 * cannot express it.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 *  * An account-bound credential (API key, Identity Center, enterprise) must
 *    never be sent the shared placeholder profile ARN. The placeholder belongs
 *    to the vendor's own account, and the upstream answers it with a 403.
 *  * AWS SSO OIDC answers camelCase JSON, not the snake_case form-urlencoded
 *    every other provider in this gateway speaks, so its responses are parsed
 *    separately rather than through the shared token parser.
 *
 * The shared `auth_state` contract and its helpers live in
 * `kiro-auth-shared.ts`; the AWS SSO OIDC wire (client registration, device
 * authorization, CreateToken, refresh grant) lives in `kiro-oidc.ts`. This
 * module owns the flow orchestration and the vendor's own social service.
 */
import {
  generateOAuthState,
  generatePkcePair,
  nonEmptyString,
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthCodeExchangeContext,
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthRefreshContext,
  OAuthTokenRefreshResult,
} from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";
import {
  buildKiroAmzUserAgent,
  buildKiroUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { deriveApiKeyMachineId, deriveOAuthMachineId, normalizeMachineId } from "./kiro-machine-id";
import { KIRO_MANAGEMENT_HOST_TEMPLATE, KIRO_DEFAULT_REGION } from "./kiro-catalog";
import { TtlCache } from "../../../persistence/ttl-cache";
import {
  KIRO_AUTH_SERVICE,
  KIRO_DEFAULT_START_URL,
  KIRO_SOCIAL_PORTAL,
  KIRO_SOCIAL_REDIRECT_URI,
  assertAwsRegion,
  authStateOf,
  enrichKiroLabel,
  kiroAccountLabel,
  kiroDefaultLabel,
  normalizeRegion,
  parseKiroAuthState,
  resolveKiroProfileArn,
  safeJson,
  validateMicrosoftTokenEndpoint,
} from "./kiro-auth-shared";
import type { KiroAuthMethod, KiroAuthState } from "./kiro-auth-shared";
import {
  exchangeKiroIdcCode,
  kiroOidcAuthorizeUrl,
  oidcAuthorizeRedirectUri,
  parseKiroOidcRegistration,
  pollKiroDeviceFlow,
  refreshKiroOidcTokens,
  registerKiroOidcClient,
  startKiroDeviceFlow,
} from "./kiro-oidc";
import type { DeviceFlowRegistration } from "./kiro-oidc";
import { exchangeKiroSocialCode, refreshKiroSocialToken } from "./kiro-social-oauth";
import { KiroOidcPendingError } from "./kiro-oidc";

// The account-side contract and its helpers are owned by kiro-auth-shared.ts;
// re-exported here so existing consumers of this module keep resolving.
export {
  KIRO_AUTH_SERVICE,
  KIRO_DEFAULT_LABELS,
  KIRO_DEFAULT_START_URL,
  KIRO_SOCIAL_PORTAL,
  KIRO_SOCIAL_REDIRECT_URI,
  assertAwsRegion,
  kiroAccountLabel,
  kiroDefaultLabel,
  normalizeRegion,
  parseKiroAuthState,
  validateMicrosoftTokenEndpoint,
} from "./kiro-auth-shared";
export type { KiroAuthMethod, KiroAuthState } from "./kiro-auth-shared";
// The OIDC pending error belongs to the OIDC wire module; re-exported here so
// consumers of this module keep resolving it from the same path.
export { KiroOidcPendingError } from "./kiro-oidc";

const DEFAULT_REGION: string = KIRO_DEFAULT_REGION;

/**
 * How long an IdC/Builder-ID registration is kept for a pending phase-2 code
 * exchange. The second browser leg follows the phase-1 redirect immediately;
 * an abandoned login must not retain its client secret beyond this window.
 */
const OIDC_REGISTRATION_TTL_MS = 15 * 60 * 1000;

/** Ceiling on concurrently pending OIDC registrations. */
const OIDC_REGISTRATION_MAX_PENDING = 64;

/**
 * Kiro's authentication client.
 *
 * The 1.4.62 IDE migrated every AWS family to the OAuth 2.0 authorization-code
 * flow with PKCE: it registers a public client against AWS SSO OIDC, opens a
 * loopback listener on `http://127.0.0.1/oauth/callback`, and exchanges the code
 * with `CreateToken`. The social families (Google/GitHub) use the vendor's own
 * sign-in portal with a loopback redirect. The device-code flow (RFC 8628) is
 * offered against the same AWS SSO OIDC service for Builder-ID / Identity
 * Center. The import, enterprise, and API-key paths are unchanged.
 */
export class KiroOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = true;

  /**
   * Loopback callback the portal and the IdC flow land on.
   *
   * Host must be `127.0.0.1`, not `localhost`: OIDC client registration uses
   * the portless `http://127.0.0.1/oauth/callback`, and AWS SSO OIDC allows
   * RFC 8252 port variation on the *same* host only — swapping in `localhost`
   * at authorize yields `Invalid redirectUri provided`. The 1.4.62 IDE binds
   * and authorizes on `127.0.0.1:<port>/oauth/callback` the same way. The
   * portal gets the origin only (`http://127.0.0.1:3128`); the callback lands
   * at `/oauth/callback?login_option=…` or `/signin/callback?…`.
   */
  override readonly browserRedirectUri = "http://127.0.0.1:3128/oauth/callback";

  protected override readonly providerLabel = "kiro";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = `${KIRO_AUTH_SERVICE}/refreshToken`;
  protected override readonly scopes = "";

  /**
   * IdC/Builder-ID registrations keyed by flow state, for the code exchange.
   *
   * TTL- and size-bounded (see {@link OIDC_REGISTRATION_TTL_MS}): an abandoned
   * phase-1 login must not hold its client secret in memory forever.
   */
  readonly #registrationByState = new TtlCache<DeviceFlowRegistration>({
    ttlMs: OIDC_REGISTRATION_TTL_MS,
    maxEntries: OIDC_REGISTRATION_MAX_PENDING,
  });

  /**
   * Fields the browser flow needs before it can start.
   *
   * None: the vendor's sign-in portal (`app.kiro.dev/signin`) is the single
   * entry point for every family — Google, GitHub, AWS Builder ID, "Your
   * organization" (IdC), and enterprise — and the callback's `login_option`
   * names which one approved. Asking for a family/region/start URL up front
   * both duplicated the portal's own choice and forced non-social families
   * onto a different (OIDC-direct) path the 1.4.62 client does not use.
   */
  readonly browserLoginFields: readonly OAuthLoginField[] = [];

  /**
   * Fields the device-flow (RFC 8628) needs before it can start.
   *
   * The device flow targets the AWS SSO OIDC service (Builder-ID / Identity
   * Center), so it asks the same region/organization questions the browser
   * flow does and defaults to the same families.
   */
  readonly deviceLoginFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Sign-in method",
      required: true,
      defaultValue: "builder-id",
      options: [
        { value: "builder-id", label: "AWS Builder ID (personal)" },
        { value: "idc", label: "IAM Identity Center (organization)" },
      ],
    },
    {
      key: "region",
      label: "AWS region",
      required: true,
      defaultValue: DEFAULT_REGION,
      placeholder: DEFAULT_REGION,
    },
    {
      key: "startUrl",
      label: "Organization start URL",
      defaultValue: KIRO_DEFAULT_START_URL,
      placeholder: KIRO_DEFAULT_START_URL,
    },
  ];

  /**
   * Fields the import flow needs.
   *
   * The same entry point accepts four credential families, so the operator
   * states which one the pasted material is; the region and — for Identity
   * Center — the client registration are the only other inputs the family
   * cannot carry by itself.
   */
  readonly importFields: readonly OAuthLoginField[] = [
    {
      key: "authMethod",
      label: "Credential type",
      required: true,
      defaultValue: "imported",
      options: [
        { value: "imported", label: "Refresh token (Kiro social session)" },
        { value: "idc", label: "Refresh token (IAM Identity Center)" },
        { value: "external_idp", label: "Enterprise IdP export (JSON)" },
        { value: "api_key", label: "API key" },
      ],
    },
    { key: "region", label: "AWS region", defaultValue: DEFAULT_REGION, placeholder: DEFAULT_REGION },
    { key: "clientId", label: "OIDC client id (Identity Center only)" },
    { key: "clientSecret", label: "OIDC client secret (Identity Center only)", secret: true },
    { key: "profileArn", label: "Profile ARN (optional)" },
  ];

  /**
   * Starts the AWS SSO OIDC device authorization.
   *
   * The same client registration the browser flow uses is reused: register a
   * public client for the chosen family/region, then ask the regional OIDC
   * service for a device code. The registration is carried in `providerState`
   * so `pollDeviceAuth` can replay it at the token endpoint.
   */
  override async startDeviceAuth(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    return startKiroDeviceFlow(this.fetchFn, context?.parameters ?? {});
  }

  /** Polls the AWS SSO OIDC token endpoint for the device grant result. */
  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    return pollKiroDeviceFlow(this.fetchFor(context), deviceAuthId, context?.providerState);
  }

  async prepareAuthorize(request: OAuthAuthorizeRequest): Promise<OAuthAuthorizeRequest> {
    // The portal is the single entry point for every family; it chooses the
    // identity provider and reports it back in the callback's `login_option`.
    // No registration happens here.
    return request;
  }

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // Every family goes through the portal. The 1.4.62 IDE has no per-family
    // OIDC-direct URL: its `buildPortalUrl` sends `state`, `code_challenge`,
    // `redirect_uri`, and `redirect_from` to `app.kiro.dev/signin`, and the
    // portal picks the identity provider. The callback's `login_option` then
    // tells the exchange which family approved.
    return this.#buildSocialAuthorizeUrl(request);
  }

  #buildSocialAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // The portal chooses the identity provider (Google/GitHub/OIDC) itself, so
    // the authorize URL carries no `idp`. The redirect URI is the origin only —
    // exactly what the bundle's `PortalAuthProvider.buildPortalUrl` sends; a
    // path-carrying redirect is rejected by Cognito with `redirect_mismatch`.
    const params = new URLSearchParams({
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: "",
      redirect_from: "KiroIDE",
    });
    const redirectOrigin = new URL(this.browserRedirectUri);
    params.set("redirect_uri", redirectOrigin.origin);
    return `${KIRO_SOCIAL_PORTAL}/signin?${params.toString()}`;
  }

  /**
   * Exchanges the authorization code the operator pastes back.
   *
   * Social families exchange against the vendor's own sign-in service. The
   * OIDC families (Builder-ID / IdC) use a two-phase flow mirrored from the
   * 1.4.62 IDE: the portal's first callback carries no `code`, only
   * `login_option` + `issuer_url` + `idc_region`; this exchange then registers
   * an OIDC client, builds the real authorize URL, and starts the *second*
   * browser leg by throwing {@link KiroOidcPendingError}. When that second
   * callback arrives (with a `code`), `exchangeCode` runs again with the
   * registration now on file and exchanges it via AWS SSO OIDC `CreateToken`.
   */
  override async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    state?: string,
    context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult> {
    // Phase 2 (or a resumed device/browser OIDC exchange): registration may be
    // in the process Map or restored from the pending flow's providerState.
    const registration =
      (state === undefined ? undefined : this.#registrationByState.get(state)) ??
      parseKiroOidcRegistration(context?.providerState);
    if (registration !== undefined) {
      if (state !== undefined) this.#registrationByState.delete(state);
      return exchangeKiroIdcCode(this.fetchFn, code, codeVerifier, registration.redirectUri, registration);
    }
    const params = context?.parameters ?? {};
    const loginOption = params["login_option"];
    if (loginOption === "builderid" || loginOption === "awsidc") {
      // Phase 1: the portal callback for an OIDC family. `code` is absent and
      // the issuer/region tell us which regional OIDC service to use. Mirror the
      // 1.4.62 IDE's IdC-provider.authenticate: register with the portless
      // loopback URI, mint a *fresh* PKCE pair, authorize against the full
      // `127.0.0.1:<port>/oauth/callback` (port allowed under RFC 8252; host
      // must stay `127.0.0.1` — `localhost` is rejected as Invalid redirectUri),
      // scopes comma-joined.
      const issuerUrl = params["issuer_url"];
      const idcRegion = params["idc_region"] ?? params["idcRegion"];
      if (issuerUrl === undefined || idcRegion === undefined) {
        throw new Error(`Kiro ${loginOption} callback missing issuer_url or idc_region`);
      }
      const region = normalizeRegion(idcRegion);
      const authMethod = loginOption === "awsidc" ? "idc" : "builder-id";
      const registered = await registerKiroOidcClient(this.fetchFn, region, issuerUrl, authMethod);
      const authorizeRedirect = oidcAuthorizeRedirectUri(redirectUri);
      const phase2: DeviceFlowRegistration = { ...registered, redirectUri: authorizeRedirect };
      const pkce = generatePkcePair();
      // The second browser leg uses a *fresh* state, mirroring the 1.4.62
      // IDE (IdCAuthProvider mints a new UUID for the IdC authorize step). The
      // code exchange keys off that new state, not the portal's.
      const continueState = generateOAuthState();
      this.#registrationByState.set(continueState, phase2);
      throw new KiroOidcPendingError(
        kiroOidcAuthorizeUrl(region, phase2.clientId, authorizeRedirect, continueState, pkce.codeChallenge),
        pkce.codeVerifier,
        JSON.stringify(phase2),
        continueState,
      );
    }
    if (loginOption === "external_idp") {
      // Enterprise IdP is only reachable by import; the portal cannot complete
      // it for us because the refresh needs the operator's pasted JSON.
      throw new Error("Kiro enterprise sign-in must be imported — use Import credential");
    }
    return this.exchangeSocialCode(code, codeVerifier, redirectUri, loginOption);
  }

  /** Exchanges a social authorization code for tokens. */
  async exchangeSocialCode(
    code: string,
    codeVerifier: string,
    redirectUri?: string,
    loginOption?: string,
  ): Promise<OAuthExchangeResult> {
    // The portal callback lands as `?login_option=google&code=…`. The exchange
    // must replay the exact redirect URI the portal saw — the callback origin +
    // path + `?login_option=…` — otherwise the vendor service rejects it (the
    // bundle rebuilds it the same way). We do not have the full callback URL at
    // exchange time, so the caller passes the pieces: `redirectUri` is the
    // loopback callback URL the flow registered and `loginOption` is the query
    // value. Default to the original scheme when the pieces are absent.
    const redirectUriFinal =
      redirectUri !== undefined && loginOption !== undefined
        ? `${redirectUri}?login_option=${loginOption}`
        : redirectUri ?? KIRO_SOCIAL_REDIRECT_URI;
    const { access, refresh, profileArn, expiresIn } = await exchangeKiroSocialCode(
      this.fetchFn,
      code,
      codeVerifier,
      redirectUriFinal,
    );
    const authMethod: KiroAuthMethod = loginOption === "github" ? "github" : "google";
    const authState: KiroAuthState = {
      authMethod,
      region: DEFAULT_REGION,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refresh),
    };
    const label =
      kiroAccountLabel(access) ??
      (await enrichKiroLabel(access, authState, kiroDefaultLabel(authMethod), this.fetchFn));
    return {
      access,
      refresh,
      expiresAt: this.#expiry(expiresIn),
      accountLabel: label,
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Completes a login from pasted credential material.
   *
   * One entry point for the four families that cannot be reached by a redirect
   * or a browser flow, because the operator already holds the material:
   *
   *  * a Kiro social refresh token;
   *  * an Identity Center refresh token, which needs the client registration
   *    that issued it;
   *  * an enterprise IdP export, which carries its own endpoint and scopes;
   *  * a raw API key.
   *
   * Every family is validated against the upstream before it is returned, so an
   * import cannot persist material that never worked — a dead refresh token is
   * rejected by the refresh it triggers, and an API key by the catalog it reads.
   * The console then persists what this returns without further inspection.
   */
  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const authMethod = nonEmptyTrimmedString(input.fields["authMethod"]) ?? "imported";
    const credential = input.credential.trim();
    if (credential.length === 0) throw new Error("Kiro credential material is required");
    switch (authMethod) {
      case "api_key":
        return this.validateApiKey(credential, input.fields["region"] ?? DEFAULT_REGION);
      case "external_idp":
        return this.importExternalIdp(credential);
      case "idc":
        return this.importRefreshToken(credential, {
          clientId: nonEmptyTrimmedString(input.fields["clientId"]),
          clientSecret: nonEmptyTrimmedString(input.fields["clientSecret"]),
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      case "imported":
        return this.importRefreshToken(credential, {
          region: input.fields["region"],
          profileArn: nonEmptyTrimmedString(input.fields["profileArn"]),
        });
      default:
        throw new Error(`Unsupported Kiro credential type: ${authMethod}`);
    }
  }

  /**
   * Imports a refresh token pasted from an existing Kiro session.
   *
   * The token is validated by actually refreshing it, so an import cannot
   * persist a credential that was already dead. Identity Center tokens carry
   * client credentials that the refresh needs; the other families refresh
   * against the vendor service.
   */
  async importRefreshToken(
    refreshToken: string,
    options: {
      readonly clientId?: string | undefined;
      readonly clientSecret?: string | undefined;
      readonly region?: string | undefined;
      readonly profileArn?: string | undefined;
      readonly machineId?: string | undefined;
    },
  ): Promise<OAuthExchangeResult> {
    const trimmed = refreshToken.trim();
    if (trimmed.length === 0) throw new Error("refresh token is required");
    const isIdc = options.clientId !== undefined && options.clientSecret !== undefined;
    const region = normalizeRegion(options.region);
    const refreshed = isIdc
      ? await refreshKiroOidcTokens(this.fetchFn, trimmed, {
          clientId: options.clientId ?? "",
          clientSecret: options.clientSecret ?? "",
          region,
          startUrl: KIRO_DEFAULT_START_URL,
          authMethod: "idc",
        })
      : await this.#refreshSocial(trimmed, undefined, normalizeMachineId(options.machineId));
    // An Identity Center refresh answers from the OIDC token endpoint, which does
    // not report a profile; the social service does. An operator-supplied ARN
    // wins over both, because it is the one value that was stated rather than
    // inferred.
    const reported =
      refreshed.profileArn ??
      (isIdc ? await this.resolveProfileArn(refreshed.access, region, "idc") : undefined);
    const profileArn = options.profileArn ?? reported;
    const authState: KiroAuthState = {
      authMethod: isIdc ? "idc" : "imported",
      region,
      ...(profileArn === undefined ? {} : { profileArn }),
      machineId: deriveOAuthMachineId(refreshed.refresh),
    };
    const label =
      kiroAccountLabel(refreshed.access) ??
      (await enrichKiroLabel(
        refreshed.access,
        authState,
        kiroDefaultLabel(isIdc ? "idc" : "imported"),
        this.fetchFn,
      ));
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(label === undefined ? {} : { accountLabel: label }),
      auth_state: authStateOf(authState),
      ...(isIdc ? { client_secret: options.clientSecret } : {}),
    };
  }

  /**
   * Imports an enterprise identity-provider credential from exported JSON.
   *
   * Every field is required and the token endpoint is restricted to the
   * Microsoft login hosts, because the refresh posts the account's refresh token
   * to whatever endpoint the JSON names.
   */
  importExternalIdp(rawAuth: unknown): OAuthExchangeResult {
    let input = rawAuth;
    if (typeof input === "string") {
      const parsed = safeJson(input);
      if (parsed === undefined) throw new Error("CLIProxyAPI auth JSON is invalid");
      input = parsed;
    }
    const raw = record(input);
    if (raw === undefined) throw new Error("CLIProxyAPI auth JSON is required");
    const authMethod = nonEmptyTrimmedString(raw["auth_method"] ?? raw["authMethod"]);
    if (authMethod !== undefined && authMethod !== "external_idp") {
      throw new Error("Only external_idp Kiro auth is supported by this importer");
    }
    const access = nonEmptyTrimmedString(raw["access_token"] ?? raw["accessToken"]);
    const refresh = nonEmptyTrimmedString(raw["refresh_token"] ?? raw["refreshToken"]);
    const clientId = nonEmptyTrimmedString(raw["client_id"] ?? raw["clientId"]);
    const tokenEndpoint = validateMicrosoftTokenEndpoint(raw["token_endpoint"] ?? raw["tokenEndpoint"]);
    const profileArn = nonEmptyTrimmedString(raw["profile_arn"] ?? raw["profileArn"]);
    const region = normalizeRegion(raw["region"]);
    const scope = normalizeScope(raw["scopes"] ?? raw["scope"]);
    if (access === undefined) throw new Error("access_token is required");
    if (refresh === undefined) throw new Error("refresh_token is required");
    if (clientId === undefined) throw new Error("client_id is required");
    if (scope.length === 0) throw new Error("scopes is required");
    if (profileArn === undefined) throw new Error("profile_arn is required");
    const authState: KiroAuthState = {
      authMethod: "external_idp",
      region,
      profileArn,
      clientId,
      tokenEndpoint,
      scope,
      machineId: deriveOAuthMachineId(refresh),
    };
    const expiresAt = readExpiry(raw) ?? this.#expiry(undefined);
    const label = kiroAccountLabel(access) ?? kiroDefaultLabel("external_idp");
    return {
      access,
      refresh,
      expiresAt,
      accountLabel: label,
      auth_state: authStateOf(authState),
    };
  }

  /**
   * Validates an API key against the surface it will actually be used on.
   *
   * A bearer-only profile lookup answers 200 with an empty list for an
   * arbitrary key, so it proves nothing; the model catalog is the surface that
   * inference uses and it answers with the models the key can reach.
   */
  async validateApiKey(apiKey: string, region = DEFAULT_REGION): Promise<OAuthExchangeResult> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error("API key is required");
    const safeRegion = assertAwsRegion(normalizeRegion(region));
    const version = getKiroVersion();
    const machineId = deriveApiKeyMachineId(trimmed);
    const host = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", safeRegion);
    const response = await this.fetchFn(`${host}/List-Available-Models?origin=AI_EDITOR`, {
      headers: {
        authorization: `Bearer ${trimmed}`,
        TokenType: "API_KEY",
        accept: "application/json",
        connection: "close",
        "x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
        "amz-sdk-request": "attempt=1; max=1",
        "amz-sdk-invocation-id": crypto.randomUUID(),
        "user-agent": buildKiroUserAgent(version, machineId),
        "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
        "x-kiro-machineid": machineId,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`API key validation failed (${response.status})`);
    const payload = record(await response.json().catch(() => undefined));
    const models = payload?.["models"];
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("API key returned no available models");
    }
    const authState: KiroAuthState = {
      authMethod: "api_key",
      region: safeRegion,
      machineId,
    };
    return {
      access: trimmed,
      refresh: "",
      // An API key has no expiry; a far-future value keeps the refresh path,
      // which needs a refresh token anyway, from ever selecting it.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      auth_state: authStateOf(authState),
    };
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
  async resolveProfileArn(
    accessToken: string,
    region = DEFAULT_REGION,
    authMethod?: KiroAuthMethod,
  ): Promise<string | undefined> {
    return resolveKiroProfileArn(this.fetchFn, accessToken, region, authMethod);
  }

  /**
   * Refreshes an account's access token.
   *
   * Four paths, chosen from the account's own configuration rather than the
   * refresh token's shape: an enterprise provider, an OIDC client registration,
   * the vendor's social service, and an imported social token (which refreshes
   * through the same service).
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const authState = parseKiroAuthState(context?.auth_state);
    if (authState?.authMethod === "external_idp") {
      const tokenEndpoint = validateMicrosoftTokenEndpoint(authState.tokenEndpoint);
      const clientId = authState.clientId;
      const scope = authState.scope;
      if (clientId === undefined || scope === undefined) {
        throw new Error("Kiro enterprise refresh is missing its client configuration");
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        scope,
      });
      const response = await this.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      const payload = record(await readJsonResponse(response, "kiro enterprise token refresh")) ?? {};
      const access = nonEmptyString(payload["access_token"]);
      if (access === undefined) throw new Error("Kiro enterprise refresh omitted access_token");
      return {
        access,
        ...(nonEmptyString(payload["refresh_token"]) === undefined
          ? {}
          : { refresh: String(payload["refresh_token"]) }),
        expiresAt: this.#expiry(payload["expires_in"]),
      };
    }

    if (authState?.authMethod === "idc" || authState?.authMethod === "builder-id") {
      const clientId = authState.clientId;
      const clientSecret = context?.client_secret;
      if (clientId === undefined || clientSecret === undefined) {
        throw new Error("Kiro IdC refresh is missing its client registration");
      }
      const refreshed = await refreshKiroOidcTokens(
        this.fetchFn,
        refreshToken,
        {
          clientId,
          clientSecret,
          region: authState.region,
          startUrl: authState.startUrl ?? KIRO_DEFAULT_START_URL,
          authMethod: authState.authMethod,
        },
        signal,
      );
      const profileArn = refreshed.profileArn ?? authState.profileArn;
      return {
        access: refreshed.access,
        refresh: refreshed.refresh,
        expiresAt: refreshed.expiresAt,
        // The frozen device identity is carried forward, never re-derived: a
        // refresh rotates the refresh token, so deriving here would move the
        // account to a new device on every refresh.
        auth_state: authStateOf({
          ...authState,
          ...(profileArn === undefined ? {} : { profileArn }),
        }),
      };
    }

    const refreshed = await this.#refreshSocial(refreshToken, signal, authState?.machineId);
    const profileArn = refreshed.profileArn ?? authState?.profileArn;
    const nextState: KiroAuthState | undefined =
      authState === undefined
        ? undefined
        : { ...authState, ...(profileArn === undefined ? {} : { profileArn }) };
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: refreshed.expiresAt,
      ...(nextState === undefined ? {} : { auth_state: authStateOf(nextState) }),
    };
  }

  /** Refreshes through the vendor's social token service. */
  async #refreshSocial(
    refreshToken: string,
    signal?: AbortSignal,
    machineId?: string,
  ): Promise<{ readonly access: string; readonly refresh: string; readonly expiresAt: Date; readonly profileArn?: string }> {
    const refreshed = await refreshKiroSocialToken(this.fetchFn, refreshToken, signal, machineId);
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expiresAt: this.#expiry(refreshed.expiresIn),
      ...(refreshed.profileArn === undefined ? {} : { profileArn: refreshed.profileArn }),
    };
  }

  #expiry(expiresIn: unknown): Date {
    return this.calculateExpiry(expiresIn);
  }
}

/** Normalizes a scope list or space-delimited string. */
function normalizeScope(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }
  return typeof value === "string" ? value.trim() : "";
}

/** Reads an absolute or relative expiry out of imported JSON. */
function readExpiry(raw: Record<string, unknown>): Date | undefined {
  const explicit = raw["expired"] ?? raw["expires_at"] ?? raw["expiresAt"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const ms = new Date(explicit).getTime();
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const expiresIn = Number(raw["expires_in"] ?? raw["expiresIn"] ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000);
  return undefined;
}

export const kiroOAuthClient = new KiroOAuthClient();
