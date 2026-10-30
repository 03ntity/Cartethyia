/**
 * Qoder device-code OAuth client.
 *
 * Qoder's login is a custom device flow, not RFC 8628: the PKCE pair, nonce,
 * and machine id are generated locally, the user opens
 * `qoder.com/device/selectAccounts` in a browser, and the gateway polls the
 * region's deviceToken endpoint until a `dt-...` token appears. The flow uses
 * the same endpoints as the upstream client.
 *
 * The issued token is used directly at dispatch: `dt-...` tokens skip the
 * PAT→jobToken exchange. There is no working refresh grant —
 * the upstream refresh endpoint answers 403 for this flow — so no refresher
 * is registered and the token is used exactly as issued until the operator
 * re-runs login. The account's Qoder user id and machine id travel in
 * `auth_state`, because the token itself carries neither and every dispatch
 * needs both for COSY signing.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { QODER_REALMS, type QoderRealm } from "./qoder-realm";
import {
  base64UrlEncode,
  nonEmptyTrimmedString,
  record,
} from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthDeviceFlow } from "../../authentication/oauth-device-flow";

/** One Qoder account profile, as much of it as the gateway uses. */
export interface QoderUserInfo {
  readonly name: string;
  readonly email: string;
  readonly id: string;
  /** Organization the account belongs to; empty when it belongs to none. */
  readonly organizationId: string;
  readonly organizationName: string;
  /** The upstream's own account class, when it states one. */
  readonly userType: string;
  readonly isOrganization: boolean;
  /** Display label for an organization with no name; empty when there is none. */
  readonly organizationLabel: string;
}

/** The profile a lookup that learned nothing returns, so callers need no `?.`. */
const EMPTY_USERINFO: QoderUserInfo = {
  name: "",
  email: "",
  id: "",
  organizationId: "",
  organizationName: "",
  userType: "",
  isOrganization: false,
  organizationLabel: "",
};

/**
 * Reads one userinfo body into {@link QoderUserInfo}.
 *
 * Exported and pure so the organization rule is testable without a network: the
 * rule is the part that decides how an account is labelled and, downstream,
 * which quota pool it draws from.
 *
 * Every field accepts both spellings the upstream has shipped (`user_type` and
 * `userType`, `organization_id` and `organizationId`) because the two login
 * paths — OAuth and PAT import — do not agree on one, and an account that took
 * the other path would otherwise read as personal.
 */
export function readQoderUserInfo(body: Record<string, unknown>): QoderUserInfo {
  const first = (...keys: readonly string[]): string =>
    keys.map((key) => nonEmptyTrimmedString(body[key])).find((value) => value !== undefined) ?? "";
  const organizationId = first("organization_id", "organizationId");
  const organizationName = first("organization_name", "organizationName");
  const userType = first("user_type", "userType");
  const credits = record(body.credits);
  const shared = credits === undefined ? undefined : record(credits["shared"]);
  const sharedPool =
    (shared !== undefined &&
      (Number(shared["size"]) > 0 || shared["unlimited"] === true)) ||
    (Array.isArray(body.packages) &&
      body.packages.some(
        (pkg) => record(pkg) !== undefined && nonEmptyTrimmedString(record(pkg)!["name"]) === "shared",
      ));
  return {
    name: (nonEmptyTrimmedString(body.name) ?? nonEmptyTrimmedString(body.username) ?? "").trim(),
    email: (nonEmptyTrimmedString(body.email) ?? "").trim(),
    id: first("id", "userId", "user_id"),
    organizationId,
    organizationName,
    userType,
    // An organization is enough on its own: an enterprise account whose
    // `userType` reads personal is still enterprise once it carries one.
    isOrganization:
      organizationId.length > 0 ||
      organizationName.length > 0 ||
      /team|enterprise/.test(userType.toLowerCase()) ||
      sharedPool,
    organizationLabel:
      organizationName.length > 0
        ? organizationName
        : organizationId.length > 0
          ? `org ${organizationId.slice(0, 8)}`
          : "",
  };
}

/** Global/intl endpoints. Kept as the default realm's values, unchanged. */
export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts" as const;
export const QODER_DEVICE_TOKEN_URL = "https://openapi.qoder.sh/api/v1/deviceToken/poll" as const;
export const QODER_USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo" as const;

/**
 * Per-realm device endpoints, derived from `QODER_REALMS`.
 *
 * Every realm's openapi host differs, so the three URLs are built from the
 * table rather than hardcoded — a CN login pointed at `openapi.qoder.sh` is
 * refused before it ever reaches an approval screen.
 */
export function qoderOAuthUrls(realm: QoderRealm): {
  readonly loginUrl: string;
  readonly deviceTokenUrl: string;
  readonly userinfoUrl: string;
} {
  const config = QODER_REALMS[realm];
  return {
    loginUrl: `${config.website}/device/selectAccounts`,
    deviceTokenUrl: `${config.openapi}/api/v1/deviceToken/poll`,
    userinfoUrl: `${config.openapi}/api/v1/userinfo`,
  };
}

/** Device authorizations live 5 minutes in the dashboard before expiring. */
const DEVICE_EXPIRY_SECONDS = 300;
/** Dashboard poll cadence for the device authorization. */
const DEVICE_INTERVAL_SECONDS = 5;
/** Individual poll request timeout; a stalled socket is a failed attempt, retried next tick. */
const POLL_TIMEOUT_MS = 15_000;
/** Token lifetime assumed when the upstream omits every expiry hint. */
const EXPIRY_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Non-secret per-account Qoder identity persisted in `auth_state`. */
export interface QoderOAuthState {
  readonly userId: string;
  readonly machineId: string;
}

/** Reads the persisted Qoder identity; `undefined` when the account predates it. */
export function parseQoderOAuthState(value: unknown): QoderOAuthState | undefined {
  let root = record(value);
  if (root === undefined && typeof value === "string") {
    // The credential loader stores `auth_state` as JSON text in SQLite, so
    // the resolver hands the adapter a string when the cache was cold. Parse
    // it before giving up — a login that works once must work again after the
    // cache is evicted.
    try {
      root = record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (root === undefined) return undefined;
  const userId = nonEmptyTrimmedString(root.userId);
  const machineId = nonEmptyTrimmedString(root.machineId);
  if (userId === undefined || machineId === undefined) return undefined;
  return { userId, machineId };
}


/**
 * Converts the upstream's expiry hint into a Unix-millisecond timestamp.
 *
 * Accepts a numeric ms-epoch (number or numeric string), an RFC3339 string,
 * or seconds-from-now. Falls back to now + 30 days when both are missing.
 * Numeric strings are checked before `Date.parse` because it accepts short
 * numerics like "2026" as years and would otherwise return a misleading date.
 */
export function parseQoderExpiry(expiresAt: unknown, expiresInSeconds: unknown): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  const trimmed = typeof expiresAt === "string" ? expiresAt.trim() : "";
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const ms = Number.parseInt(trimmed, 10);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (
    typeof expiresInSeconds === "number" &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds >= 0
  ) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + EXPIRY_FALLBACK_MS;
}

interface QoderDeviceState {
  readonly verifier: string;
  readonly machineId: string;
}

function parseDeviceState(value: string | undefined): QoderDeviceState | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const verifier = root === undefined ? undefined : nonEmptyTrimmedString(root.verifier);
  const machineId = root === undefined ? undefined : nonEmptyTrimmedString(root.machineId);
  if (verifier === undefined || machineId === undefined) return undefined;
  return { verifier, machineId };
}

export class QoderOAuthClient extends OAuthDeviceFlow {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  /**
   * Which deployment this login talks to.
   *
   * Defaults to intl, whose parameter set is left exactly as it was working:
   * the CN shape below is the only branch that changes behavior, so adding a
   * realm cannot regress an existing global login.
   */
  private readonly realm: QoderRealm;

  constructor(fetchFn: typeof fetch = globalThis.fetch, realm: QoderRealm = "intl") {
    super(fetchFn);
    this.realm = realm;
  }

  /** The three device endpoints for this client's realm. */
  get urls(): { loginUrl: string; deviceTokenUrl: string; userinfoUrl: string } {
    return qoderOAuthUrls(this.realm);
  }

  protected override readonly providerLabel = "Qoder";
  // The device endpoints take no client id; the abstract field stays empty
  // rather than inventing one, and every request below omits it.
  protected override readonly clientId = "";
  protected override readonly tokenUrl = QODER_DEVICE_TOKEN_URL;
  protected override readonly scopes = "";

  override async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult> {
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
    // CN carries a dashed nonce and additionally states the client id and
    // native redirect; intl stays on the 32-hex nonce and the two params it
    // has always sent. Both shapes are upstream fact from the donor, and only
    // the CN branch is new, so the working intl URL is untouched.
    const nonce = this.realm === "cn" ? randomUUID() : randomUUID().replaceAll("-", "");
    const machineId = randomUUID();
    const params = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    });
    if (this.realm === "cn") {
      const config = QODER_REALMS.cn;
      params.set("client_id", config.clientId);
      params.set("redirect_uri", config.redirectUri);
    }
    return {
      verificationUri: `${qoderOAuthUrls(this.realm).loginUrl}?${params.toString()}`,
      // This flow shows no user code: approval happens against the
      // nonce-bound browser session, so there is nothing to type back.
      userCode: "",
      deviceAuthId: nonce,
      intervalSeconds: DEVICE_INTERVAL_SECONDS,
      expiresInSeconds: DEVICE_EXPIRY_SECONDS,
      providerState: JSON.stringify({ verifier, machineId }),
    };
  }

  override async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const state = parseDeviceState(context?.providerState);
    if (state === undefined) return { status: "failed", reason: "unknown device authorization" };
    const url =
      `${qoderOAuthUrls(this.realm).deviceTokenUrl}?nonce=${encodeURIComponent(deviceAuthId)}` +
      `&verifier=${encodeURIComponent(state.verifier)}&challenge_method=S256`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Go-http-client/2.0" },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : "Qoder device polling failed",
      };
    }
    // 202/404 are the endpoint's "not approved yet" answers, not failures.
    if (response.status === 202 || response.status === 404) return { status: "pending" };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "failed", reason: "Qoder device polling returned invalid JSON" };
    }
    if (!response.ok) {
      const message = record(payload);
      return {
        status: "failed",
        reason:
          nonEmptyTrimmedString(message?.message) ??
          `Qoder device polling failed (${response.status})`,
      };
    }
    const body = record(payload);
    const accessToken = body === undefined ? undefined : nonEmptyTrimmedString(body.token);
    // A 200 without a token means the upstream changed shape — fail loudly
    // rather than storing an empty credential that 401s every dispatch.
    if (accessToken === undefined) {
      return { status: "failed", reason: "Qoder device polling returned no token" };
    }
    const refreshToken = nonEmptyTrimmedString(body?.refresh_token);
    const expireTime = parseQoderExpiry(body?.expires_at, body?.expires_in);
    const info = await this.fetchUserInfo(accessToken);
    const label = info.name || info.email || undefined;
    // The poll body carries user_id; the profile endpoint is only a fallback.
    // Dispatch needs the id for COSY signing, and an empty one would store an
    // account that 401s on every request ("missing its user identity") — so a
    // login that cannot resolve the id fails loudly here instead, while the
    // user is still in front of the approval screen and can just retry.
    const resolvedUserId = nonEmptyTrimmedString(body?.user_id) ?? info.id;
    if (resolvedUserId === "") {
      return {
        status: "failed",
        reason:
          "Qoder login could not resolve the user id (poll had no user_id and the profile lookup returned none); try again",
      };
    }
    const result: OAuthExchangeResult = {
      access: accessToken,
      // No refresh grant exists, so the upstream refresh token (when present)
      // is mirrored here for the identity fingerprint that keys a repeated
      // login to the same account. It is never sent to a token endpoint —
      // no refresher is registered for this provider.
      refresh: refreshToken ?? accessToken,
      expiresAt: new Date(expireTime),
      ...(label === undefined ? {} : { accountLabel: label }),
      // The token carries neither the user id nor the machine id, and every
      // dispatch needs both for COSY signing — persist them beside the tokens.
      auth_state: { userId: resolvedUserId, machineId: state.machineId },
    };
    return { status: "complete", result };
  }

  /**
   * Best-effort profile lookup for the account label; never blocks login.
   *
   * Also reports whether the account belongs to an organization. Upstream
   * decides that from whichever signal is present, in this order: an
   * organization id or name, a `userType` naming a team or enterprise, or a
   * shared credit pool. Any one of them is enough — an enterprise account whose
   * `userType` reads personal is still enterprise as soon as it carries an
   * organization, which is the case the organization check exists for.
   */
  async fetchUserInfo(accessToken: string): Promise<QoderUserInfo> {
    try {
      const response = await this.fetchFn(qoderOAuthUrls(this.realm).userinfoUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "user-agent": "Go-http-client/2.0",
        },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (!response.ok) return EMPTY_USERINFO;
      const body = record(await response.json());
      if (body === undefined) return EMPTY_USERINFO;
      return readQoderUserInfo(body);
    } catch {
      return EMPTY_USERINFO;
    }
  }

  override async refresh(
    _refreshToken: string,
    _signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    throw new Error("Qoder does not support token refresh; sign in again");
  }
}

export const qoderOAuthClient = new QoderOAuthClient();

/** Device-login client for the China deployment. */
export const qoderCnOAuthClient = new QoderOAuthClient(globalThis.fetch, "cn");
