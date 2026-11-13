/**
 * Kiro's vendor social sign-in and refresh service.
 *
 * The social families (Google/GitHub) exchange codes and refresh tokens against
 * the vendor's own service (`app.kiro.dev`), a different host from the AWS SSO
 * OIDC endpoints with its own observed client: plain HTTPS, no AWS SDK, and the
 * device marker alone as identity. `kiro-oauth.ts` owns the flow orchestration;
 * this module owns the wire.
 */
import {
  nonEmptyString,
  readJsonResponse,
  record,
} from "../../authentication/oauth-flow-store";
import type { FetchLike } from "../../authentication/oauth-flow-store";
import { getKiroVersion } from "../../operations/client-versions";
import { KIRO_AUTH_SERVICE } from "./kiro-auth-shared";

/** Fields a social token response carries after wire parsing. */
export interface KiroSocialTokenPayload {
  readonly access: string;
  readonly refresh: string;
  readonly profileArn?: string;
  readonly expiresIn: unknown;
}

/**
 * Headers for the vendor's own sign-in and refresh service.
 *
 * The device marker is included only when the credential it belongs to is
 * already known: the code exchange runs before an account exists, and inventing
 * an identity for that request would be worse than sending none.
 */
export function socialServiceHeaders(machineId?: string): Record<string, string> {
  const device = machineId === undefined ? "KiroIDE" : `KiroIDE-${getKiroVersion()}-${machineId}`;
  return {
    "content-type": "application/json",
    accept: "application/json",
    connection: "close",
    "user-agent": device,
    "x-amz-user-agent": device,
  };
}

/**
 * Exchanges a social authorization code for tokens.
 *
 * The portal callback lands as `?login_option=google&code=…`. The exchange must
 * replay the exact redirect URI the portal saw — the callback origin + path +
 * `?login_option=…` — otherwise the vendor service rejects it.
 */
export async function exchangeKiroSocialCode(
  fetchFn: FetchLike,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<KiroSocialTokenPayload> {
  const response = await fetchFn(`${KIRO_AUTH_SERVICE}/oauth/token`, {
    method: "POST",
    headers: socialServiceHeaders(),
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  const payload = record(await readJsonResponse(response, "kiro social token exchange")) ?? {};
  const access = nonEmptyString(payload["accessToken"]);
  if (access === undefined) {
    const detail = nonEmptyString(payload["error_description"]) ?? nonEmptyString(payload["error"]);
    throw new Error(`Kiro token exchange omitted accessToken${detail === undefined ? "" : `: ${detail}`}`);
  }
  const refresh = nonEmptyString(payload["refreshToken"]) ?? "";
  const profileArn = nonEmptyString(payload["profileArn"]);
  return {
    access,
    refresh,
    ...(profileArn === undefined ? {} : { profileArn }),
    expiresIn: payload["expiresIn"],
  };
}

/** Refreshes through the vendor's social token service. */
export async function refreshKiroSocialToken(
  fetchFn: FetchLike,
  refreshToken: string,
  signal: AbortSignal | undefined,
  machineId?: string,
): Promise<KiroSocialTokenPayload> {
  const response = await fetchFn(`${KIRO_AUTH_SERVICE}/refreshToken`, {
    method: "POST",
    headers: socialServiceHeaders(machineId),
    body: JSON.stringify({ refreshToken }),
    ...(signal === undefined ? {} : { signal }),
  });
  const payload = record(await readJsonResponse(response, "kiro token refresh")) ?? {};
  const access = nonEmptyString(payload["accessToken"]);
  if (access === undefined) throw new Error("Kiro token refresh omitted accessToken");
  const profileArn = nonEmptyString(payload["profileArn"]);
  return {
    access,
    refresh: nonEmptyString(payload["refreshToken"]) ?? refreshToken,
    ...(profileArn === undefined ? {} : { profileArn }),
    expiresIn: payload["expiresIn"],
  };
}
