/**
 * Wire endpoint and header plumbing: endpoint URL construction, the Codex
 * session-state/effort wire vocabulary, image-source resolution, and outbound
 * custom-header validation.
 */
import { providerBaseUrl } from "../providers/provider-metadata";
import { GatewayError } from "./gateway-error";
import type { CanonicalTerminalEvent, UsageRecord } from "./canonical-model";
import type { CanonicalStopReason } from "./canonical-model";
import { type WireFamily } from "./canonical-model";
import type { GenerationControls } from "./canonical-model";
import { BASE_PROTECTED_HEADERS, HEADER_CONTROL, HEADER_TOKEN } from "../security/outbound-headers";
import { unwrapProviderToken } from "../providers/provider-credentials";

// Endpoint URL construction

export function endpointUrl(
  baseUrl: string | undefined,
  endpointPath: string,
  isOAuth = false,
): string {
  if (/^https?:\/\//i.test(endpointPath)) {
    if (isOAuth && !endpointPath.includes("?beta=true")) {
      const separator = endpointPath.includes("?") ? "&" : "?";
      return `${endpointPath}${separator}beta=true`;
    }
    return endpointPath;
  }
  const url = joinUrl((baseUrl ?? providerBaseUrl("claude")).replace(/\/+$/, ""), endpointPath);
  if (isOAuth) return `${url}?beta=true`;
  return url;
}

/** Session-scoped state (turn-state / session identity). */
export interface CodexSessionState {
  sessionId: string;
  threadId: string;
  windowId: string;
  turnState?: string;
  turnStartedAtUnixMs?: number;
}

/**
 * ASCII-safe JSON: escapes every non-ASCII code unit as `\uXXXX`. The
 * `x-codex-turn-metadata` header must stay ASCII-clean and = ~100 KB;
 * mirrors provider `toAsciiJsonString` (openai-codex-responses.ts:623-628).
 */
export function toAsciiJsonString(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(
    /[\x7f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export const CODEX_WIRE_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexWireEffort = (typeof CODEX_WIRE_EFFORT_VALUES)[number];

/**
 * Maps canonical `ReasoningIntent.effort` to the wire tier strings the
 * ChatGPT backend accepts. Identity for the exact canonical vocabulary; an
 * unknown value falls back to `"medium"` rather than dropping the request.
 */
export function mapReasoningEffortToWireTier(
  effort: string | undefined,
): CodexWireEffort | undefined {
  if (effort === undefined) return undefined;
  if ((CODEX_WIRE_EFFORT_VALUES as readonly string[]).includes(effort))
    return effort as CodexWireEffort;
  return "medium";
}

/**
 * Resolves the requested output verbosity from a canonical request's
 * generation controls, independent of the surface it arrived on.
 *
 * Each surface files the same caller intent under a different key: Chat and
 * Completion carry the documented top-level `verbosity` as
 * `extension:verbosity`, Responses nests it under `text.verbosity` and stores
 * it as `extension:responses.verbosity`, and `GenerationControls.verbosity` is
 * the canonical slot. Reading only the canonical slot silently drops the
 * control on every real request, because no surface parser writes it — the
 * caller's `verbosity: "high"` reached the upstream as the model's default.
 *
 * The precedence mirrors `resolvePromptCacheKey`: the surface-specific
 * spelling wins over the bare one, and both win over the canonical slot.
 */
export function resolveOutputVerbosity(
  controls: GenerationControls | undefined,
): string | undefined {
  if (controls === undefined) return undefined;
  const candidates = [
    controls["extension:responses.verbosity"],
    controls["extension:verbosity"],
    controls.verbosity,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function tryParseJsonObject(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Builds the canonical terminal event.
 *
 * Eight call sites across the four response decoders assembled this envelope by
 * hand with the same conditional-spread idiom. Owning it here keeps one field
 * set and one omission rule: an absent optional is omitted, never emitted as an
 * explicit `undefined`.
 */
export function canonicalTerminal(input: {
  readonly sequenceNumber: number;
  readonly state: CanonicalTerminalEvent["state"];
  readonly stopReason?: CanonicalStopReason | undefined;
  readonly providerStopReason?: string | undefined;
  readonly stopDetails?: Record<string, unknown> | undefined;
  readonly usage?: UsageRecord | undefined;
  readonly responseId?: string | undefined;
  readonly eventId?: string | undefined;
}): CanonicalTerminalEvent {
  return {
    type: "terminal",
    sequence_number: input.sequenceNumber,
    state: input.state,
    ...(input.responseId === undefined ? {} : { response_id: input.responseId }),
    ...(input.eventId === undefined ? {} : { event_id: input.eventId }),
    ...(input.stopReason === undefined ? {} : { stop_reason: input.stopReason }),
    ...(input.providerStopReason === undefined
      ? {}
      : { provider_stop_reason: input.providerStopReason }),
    ...(input.stopDetails === undefined ? {} : { stop_details: input.stopDetails }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

export type AuthHeaderShape = "authorization_bearer" | "x_api_key";

/**
 * Fallback endpoint paths for builtin providers on versioned bases.
 * Used only when an adapter omits `endpoint_paths_by_wire_family` and the
 * candidate carries no `endpoint_path` override.
 */
export const BUILTIN_DEFAULT_ENDPOINTS: Record<WireFamily, string> = {
  chat: "/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  gemini: "/api/llm/g/v1/generate",
};

/**
 * Endpoint paths for bare-host roots (operator-provided BYOK roots and the
 * generic API-key providers). A bare host has no version segment, so these
 * paths carry their own `/v1` prefix — unlike `BUILTIN_DEFAULT_ENDPOINTS`,
 * whose `chat` value assumes a base that already ends in `/v1`.
 *
 * Pinned explicitly rather than derived: these are wire bytes an operator's
 * upstream expects, so they must not shift when the builtin default changes.
 */
export const BARE_ROOT_ENDPOINTS: Partial<Record<WireFamily, string>> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

/** An image part's provider-neutral source, resolved from any supported origin shape. */
interface ResolvedImageSource {
  /** URL or `data:` URI. Mutually usable with `fileId`. */
  url?: string;
  /** Files API reference (Chat/Responses `file_id`). */
  fileId?: string;
  /** OpenAI `detail` hint (`auto`/`low`/`high`), when the origin carried one. */
  detail?: string;
}

/** An RFC 2397 base64 `data:` URL split into the media type and bytes it carries. */
interface DataUrlPayload {
  /** The declared media type (the `image/png` of `data:image/png;base64,…`). */
  readonly mediaType: string;
  /** The base64 payload, with the `data:` prefix and media type removed. */
  readonly data: string;
}

/**
 * Splits a base64 `data:` URL into its media type and payload.
 *
 * Returns `undefined` for a non-`data:` URL, and for a `data:` URL that is not
 * base64-encoded: every wire this gateway speaks carries inline bytes as
 * base64, so a percent-encoded payload has no transport to land in and the
 * caller must fall back rather than forward bytes it cannot decode.
 *
 * This is the single home for the split. A codec that hand-rolls the regex
 * instead tends to keep the whole `data:` string as a URI, which the upstream
 * then cannot fetch — the attachment is lost while the request still succeeds.
 */
export function splitDataUrl(url: string): DataUrlPayload | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (mediaType === undefined || data === undefined || data.length === 0) return undefined;
  return { mediaType, data };
}

/**
 * Resolves an opaque canonical `image` content part into its URL/file-id/detail
 * triple, tolerating every origin shape this codebase produces:
 * - a bare URL / `data:` URI string (an OpenAI Responses `input_image` payload
 *   is a string, and a tolerant Chat parser keeps a string `image_url` as-is)
 * - OpenAI Chat `{image_url: {url, detail?}}` / `{url, detail?}`
 * - OpenAI Responses `{type:"input_image", image_url, detail?, file_id?}`
 * - Anthropic `{type:"image", source:{type:"base64"|"url"|"file", ...}}`
 *
 * Returns `undefined` only for a shape this gateway cannot re-encode, so
 * callers can degrade explicitly instead of silently dropping the image.
 */
export function resolveImageSource(payload: unknown): ResolvedImageSource | undefined {
  // A bare string is already the URL the wire wants. Accepting it here — rather
  // than in each builder — is what keeps a string-payload image from being
  // dropped on every surface at once.
  if (typeof payload === "string") {
    return payload.length > 0 ? { url: payload } : undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  const topDetail = typeof value["detail"] === "string" ? value["detail"] : undefined;
  // A Responses `input_image` may reference the Files API with a top-level
  // `file_id` and no `image_url` at all; check it before the `image_url` arms,
  // which would otherwise fall through to the generic `url`/`file_id` scan and
  // lose a payload that carries only the id.
  const topFileId = typeof value["file_id"] === "string" ? value["file_id"] : undefined;
  const nested = value["image_url"];
  if (nested === undefined && topFileId !== undefined) {
    return { fileId: topFileId, ...(topDetail === undefined ? {} : { detail: topDetail }) };
  }
  if (typeof nested === "string") {
    return { url: nested, ...(topDetail === undefined ? {} : { detail: topDetail }) };
  }
  if (nested !== null && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    const url = typeof inner["url"] === "string" ? inner["url"] : undefined;
    const fileId = typeof inner["file_id"] === "string" ? inner["file_id"] : undefined;
    const detail = typeof inner["detail"] === "string" ? inner["detail"] : topDetail;
    if (url !== undefined || fileId !== undefined) {
      return {
        ...(url === undefined ? {} : { url }),
        ...(fileId === undefined ? {} : { fileId }),
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }
  const url = typeof value["url"] === "string" ? value["url"] : undefined;
  const fileId = typeof value["file_id"] === "string" ? value["file_id"] : undefined;
  if (url !== undefined || fileId !== undefined) {
    return {
      ...(url === undefined ? {} : { url }),
      ...(fileId === undefined ? {} : { fileId }),
      ...(topDetail === undefined ? {} : { detail: topDetail }),
    };
  }
  const source = value["source"];
  if (source !== null && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (s["type"] === "base64" && typeof s["data"] === "string") {
      const mediaType = typeof s["media_type"] === "string" ? s["media_type"] : "image/png";
      return {
        url: `data:${mediaType};base64,${s["data"]}`,
        ...(topDetail === undefined ? {} : { detail: topDetail }),
      };
    }
    if (s["type"] === "url" && typeof s["url"] === "string") {
      return { url: s["url"], ...(topDetail === undefined ? {} : { detail: topDetail }) };
    }
    if (s["type"] === "file" && typeof s["file_id"] === "string") {
      return { fileId: s["file_id"], ...(topDetail === undefined ? {} : { detail: topDetail }) };
    }
  }
  return undefined;
}

export function joinUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // A base that already ends at a version segment (`…/v1`) plus a path that
  // starts with the same segment (`/v1/chat/completions`) would otherwise
  // produce `…/v1/v1/chat/completions` and 404. Drop the duplicated prefix.
  const baseVersion = normalizedBase.match(/\/(v\d+)$/);
  const version = baseVersion?.[1];
  if (version !== undefined && normalizedPath.startsWith(`/${version}/`)) {
    return `${normalizedBase}${normalizedPath.slice(version.length + 1)}`;
  }
  // A base that already is the full endpoint (`…/v1/chat/completions`) plus a
  // path that is that same endpoint is valid as-is — keep the base.
  if (normalizedPath !== "/" && normalizedBase.endsWith(normalizedPath)) {
    return normalizedBase;
  }
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Strips a single leading Bearer envelope (case-insensitive) so adapters
 * never emit `Bearer Bearer`. Delegates to `unwrapProviderToken`
 * (registry.ts), the single token-envelope implementation.
 */
export function normalizeBearerToken(raw: string): string {
  return TEXT_DECODER.decode(unwrapProviderToken(raw, "bearer"));
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Validates operator-configured outbound custom headers. Protected credential,
 * transport, proxy-identity, and gateway identity names can never be overridden.
 *
 * Single home for custom-header validation (RFC-token name check, 4KiB value
 * cap, control-character check, protected-name rejection).
 *
 * @param extraAllowed additional header names reserved by the calling provider
 * family beyond the base protected list — operator-supplied values for these
 * names are rejected exactly like base protected names. Despite the name,
 * these are extra non-overridable names: "allowed" refers to the family stack
 * itself, which remains allowed to set them (e.g. Claude's stainless
 * SDK-identity and client-identity headers managed by `buildClaudeHeaders`).
 */
export function filterProviderCustomHeaders(
  input: Readonly<Record<string, unknown>> | undefined,
  extraAllowed?: readonly string[],
): Record<string, string> {
  if (!input) return {};
  const extraReserved = new Set((extraAllowed ?? []).map((name) => name.toLowerCase()));
  const filtered: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!HEADER_TOKEN.test(name)) {
      throw new GatewayError("invalid_request", 400, `invalid custom header name: ${rawName} (request {requestId}). Check the shape of what you sent — then resend 🪞`, {
        header: rawName,
      });
    }
    if (
      BASE_PROTECTED_HEADERS[name] ||
      extraReserved.has(name) ||
      name.startsWith("x-forwarded-")
    ) {
      throw new GatewayError("invalid_request", 400, `custom header is protected: ${rawName} (request {requestId}). Not allowed by policy — no hard feelings 🫂`, {
        header: rawName,
      });
    }
    if (typeof rawValue !== "string") {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value must be a string: ${rawName} (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        { header: rawName },
      );
    }
    if (TEXT_ENCODER.encode(rawValue).byteLength > 4096) {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value exceeds 4KiB: ${rawName} (request {requestId}). We love long reads, but not that long 📚`,
        { header: rawName },
      );
    }
    if (HEADER_CONTROL.test(rawValue)) {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value contains control characters: ${rawName} (request {requestId}). Check the shape of what you sent — then resend 🪞`,
        { header: rawName },
      );
    }
    filtered[name] = rawValue;
  }
  return filtered;
}
