/**
 * Shared plumbing for the CLI-client integrations (free-pi, Perch, …): the
 * read-only JSON probe every quota collector runs, the null-result shape the
 * quota contract treats as "unknown, not dead", the upstream-error →
 * GatewayError construction, and the OpenAI chat finish-reason map.
 *
 * These four pieces were re-implemented per integration and drifted (the
 * freepi quota percent bug was exactly that kind of drift); one owner keeps
 * the next CLI-client port on the same rails.
 */
import type { CanonicalStopReason } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";

/**
 * Options for {@link readJsonOrNull}: request headers, the per-request timeout
 * (defaults to 15 seconds), and an optional caller abort signal composed with
 * the timeout.
 */
export interface ReadJsonOptions {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * One authenticated GET whose parsed JSON body is the result, or `null` when
 * the request fails, the endpoint answers non-2xx, or the body is not JSON.
 * This is the fetch-and-null shape every integration used to re-implement and
 * drift (the shared-probing header documents that class of bug); new surfaces
 * call this instead of copying the try/catch ladder. The caller decides what
 * `null` means for its surface.
 */
export async function readJsonOrNull<T = unknown>(
  fetcher: FetchLike,
  url: string | URL,
  options: ReadJsonOptions = {},
): Promise<T | null> {
  const { headers = {}, timeoutMs = 15_000, signal } = options;
  try {
    const res = await fetcher(url, {
      method: "GET",
      headers,
      signal:
        signal === undefined
          ? AbortSignal.timeout(timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * One authenticated GET returning a JSON object, or `null` when the endpoint
 * is unreachable, answers non-2xx, or returns a non-object body. The caller
 * decides what `null` means for its surface (quota collectors report an
 * unknown balance rather than cooling the account).
 */
export function readJsonOk(
  fetcher: FetchLike,
  url: string | URL,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  return readJsonOrNull<Record<string, unknown>>(fetcher, url, { headers });
}

/**
 * The shared quota null-result: no plan, no windows, and an operator-readable
 * reason. Never carries `error: "…"` semantics beyond "could not read" — see
 * the quota contract on why an unreadable balance must not cool an account.
 */
export function quotaUnreadable(source: string, error: string | null): ProviderQuotaResult {
  return { source, plan: null, windows: [], error };
}

/**
 * Builds the upstream verdict shared by the CLI-client surfaces. `origin:
 * "upstream"` is what lets the account-health machine see the failure; a
 * locally minted error never cools the account.
 */
export function upstreamGatewayError(
  providerId: string,
  code: GatewayError["code"],
  status: number,
  message: string,
  extra: {
    readonly providerCode?: string;
    readonly upstreamCode?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {},
): GatewayError {
  return new GatewayError(
    code,
    status,
    message,
    {
      providerId,
      ...(extra.upstreamCode !== undefined ? { upstream_code: extra.upstreamCode } : {}),
      ...(extra.providerCode !== undefined ? { providerCode: extra.providerCode } : {}),
      ...(extra.details ?? {}),
    },
    "upstream",
  );
}

/**
 * Maps an OpenAI-style chat `finish_reason` onto the canonical stop reason.
 * Unknown values map to `undefined` so each surface applies its own default
 * (freepi falls back to `stop`; Qoder omits the field).
 */
export function mapChatFinishReason(raw: unknown): CanonicalStopReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls" || raw === "function_call") return "tool_use";
  if (raw === "content_filter") return "content_filter";
  if (raw === "error") return "error";
  if (raw === "refusal") return "refusal";
  return undefined;
}
