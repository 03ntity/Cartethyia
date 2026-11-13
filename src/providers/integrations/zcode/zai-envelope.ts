/**
 * Z.AI / ZCode shared wire facts.
 *
 * The ZCode surfaces (`zcode.z.ai` business endpoints and the plan lane) wrap
 * responses in a `{ code, msg, data, success }` envelope whose success codes
 * are `0`/`200` (string or number) and whose `success: false` always means
 * failure. Four call sites spelled that check out longhand with subtly
 * different tolerance for missing fields; this module owns the predicate and
 * the app-identity headers the billing endpoints require.
 *
 * `zcode/oauth.ts` keeps its own `unwrapEnvelope`: it unwraps `data` and throws
 * a provider-labelled `GatewayError`, a different contract from the boolean
 * verdict the plan-lane readers need.
 */
import { createHash } from "node:crypto";
import { asRecord } from "../../../shared/coerce";

/** App version the billing/marketing endpoints expect in headers and query. */
export const ZAI_APP_VERSION = "3.16.3";
/** Platform token the same endpoints expect. */
export const ZAI_PLATFORM = "linux-x64";

/**
 * Statuses the envelope treats as success. The OAuth token endpoint answers
 * `code: 0`; the business endpoints answer `code: 200`; both spellings arrive
 * as strings often enough that all four are accepted.
 */
const ZAI_OK_CODES: ReadonlySet<unknown> = new Set([0, 200, "0", "200"]);

/**
 * Whether a parsed body is a *successful* Z.AI envelope.
 *
 * An absent `code` is tolerated (some responses carry `data` without it) but
 * `success: false` or a non-ok `code` is always a rejection — including inside
 * an HTTP 200, which is how the plan lane reports business errors.
 */
export function zaiEnvelopeOk(payload: Record<string, unknown>): boolean {
  if (payload["success"] === false) return false;
  const code = payload["code"];
  return code === undefined || ZAI_OK_CODES.has(code);
}

/**
 * The envelope's `data` payload when the body is a successful envelope.
 * `null` covers both "rejected envelope" and "successful envelope with no
 * data" — callers that must tell those apart check {@link zaiEnvelopeOk} on
 * the payload first.
 */
export function zaiEnvelopeData(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (payload === null || payload === undefined || !zaiEnvelopeOk(payload)) return null;
  return asRecord(payload["data"]) ?? null;
}

/**
 * Stable per-account `X-Device-Mid`: the gateway validates it as a UUID and
 * attributes usage to it, so a hardcoded shared UUID would lump every account
 * into one billing identity. Deterministic per account id — quota and gift
 * claims present the same device for the same account.
 */
export function zaiDeviceMid(accountId: string): string {
  const hash = createHash("sha256").update(`zcode-device\0${accountId}`).digest("hex");
  const variant = ((parseInt(hash[16] as string, 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * App-identity headers the billing/marketing endpoints require alongside the
 * bearer. Keys are lowercase: HTTP header names are case-insensitive, and one
 * spelling keeps the three call sites byte-identical.
 */
export function zaiAppHeaders(credential: string, accountId: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    accept: "application/json",
    "content-type": "application/json",
    "x-device-mid": zaiDeviceMid(accountId),
    "x-client-language": "en-US",
    "x-zcode-app-version": ZAI_APP_VERSION,
    "x-platform": ZAI_PLATFORM,
  };
}
