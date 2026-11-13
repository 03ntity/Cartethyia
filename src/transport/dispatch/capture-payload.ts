// Provider-exchange payload capture: tee the validated outbound request and
// response into the stored request-detail panels. Bounded, best-effort, and
// never allowed to fail the dispatch path or disturb the caller's stream.
import { readReportedModel } from "../../providers/operations/reported-model";
import type { ValidatedOutboundFetch } from "../../providers/provider-contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  resolvePayloadCapture,
  TelemetryPayloadCapture,
  truncateUtf8,
  type PayloadCaptureState,
} from "../../observability/payload-capture";
import { payloadDirectory } from "../../observability/payload-store";
import type { ProxyRequestState } from "../request/state";
import { log } from "../../observability/logger";
import { captureDepthMaxBytes, providerCaptureMaxBytes } from "./capture-policy";

export function parseCapturedBody(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const PROVIDER_CAPTURE_AWAIT_MS = 2_000;
const CAPTURABLE_RESPONSE_TYPES = /^(text\/|application\/(json|x-ndjson|sse))/i;

/** Only JSON/SSE/text bodies are parseable; binary native wire is skipped. */
function shouldCaptureProviderResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType === "") return true;
  return CAPTURABLE_RESPONSE_TYPES.test(contentType);
}

/** Bounded read of a response clone's body; never disturbs the caller's stream. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Collect decoded chunks and join once: `+=` per chunk reallocates the
  // prefix (O(n^2)). The budget is UTF-8 **bytes** — the same basis the record
  // budget and the request-line slice use — measured per decoded chunk, with
  // the final chunk trimmed by truncateUtf8 so a code point is never split.
  const parts: string[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (totalBytes + chunkBytes > maxBytes) {
        parts.push(truncateUtf8(chunk, maxBytes - totalBytes));
        totalBytes = maxBytes;
        break;
      }
      parts.push(chunk);
      totalBytes += chunkBytes;
    }
  } catch {
    // Best-effort capture must never fail the request path.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The clone branch is discarded either way.
    }
  }
  return parts.join("");
}

export interface ProviderExchangeCapture {
  request: unknown;
  response: Promise<unknown>;
  /**
   * The model the upstream named in its own response, read from the raw bytes.
   *
   * Filled by `captureProviderExchange` — the one wrapper every provider's
   * network call passes through — rather than by each adapter. Adapters were
   * synthesizing their opening event with the model *we asked for*, so a
   * provider answering a different one reported as if it had complied; reading
   * the bytes here is the only place that sees what the upstream actually
   * wrote, for every wire, without six adapters to keep in step.
   */
  reportedModel?: Promise<string | undefined>;
}

/**
 * Outbound request headers worth recording for diagnosis.
 *
 * Deliberately an allowlist of non-secret protocol headers: the capture store
 * is read through the console, so a blanket copy would persist bearer tokens
 * and API keys. These are the headers that describe *how* a request was
 * framed (session identity, turn index, model routing), which is what makes a
 * provider bug reproducible after the fact.
 */
const CAPTURED_REQUEST_HEADERS = [
  "x-opencode-client",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-opencode-request",
  "x-opencode-project",
  "x-session-affinity",
  "x-grok-session-id",
  "x-grok-conv-id",
  "x-grok-turn-idx",
  "x-grok-req-id",
  "x-grok-model-override",
  "x-grok-client-version",
  "x-grok-client-identifier",
  "x-grok-agent-id",
  "x-session-id",
  "x-parent-session-id",
  "traceparent",
  "b3",
  // The buddy channel check reads this family. A capture that kept only
  // `x-session-id` could not show whether a `11-128 conversation id missing`
  // refusal was a missing header or something else.
  "x-conversation-id",
  "x-conversation-request-id",
  "x-conversation-message-id",
  "x-root-request-id",
  "x-request-id",
  "x-trace-id",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-sampled",
  "x-claude-code-session-id",
  "user-agent",
] as const;
/** Copies only the allowlisted, non-empty headers from an outbound request. */
function selectCapturedHeaders(init?: RequestInit): Record<string, string> | undefined {
  if (init?.headers === undefined) return undefined;
  let source: Headers;
  try {
    source = new Headers(init.headers);
  } catch {
    return undefined;
  }
  const selected: Record<string, string> = {};
  for (const name of CAPTURED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && value.length > 0) selected[name] = value;
  }
  return Object.keys(selected).length === 0 ? undefined : selected;
}

/**
 * Keeps the Proxy→Provider request line (method, URL, allowlisted headers) and
 * drops the body. Used by the `metadata` capture mode so operators can inspect
 * framing without retaining prompt/response content.
 */
export function providerRequestMetadataOnly(request: unknown): unknown {
  if (typeof request !== "object" || request === null) return null;
  const record = request as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  if (typeof record["method"] === "string") metadata["method"] = record["method"];
  if (typeof record["url"] === "string") metadata["url"] = record["url"];
  if (
    typeof record["headers"] === "object" &&
    record["headers"] !== null &&
    !Array.isArray(record["headers"])
  ) {
    metadata["headers"] = record["headers"];
  }
  return Object.keys(metadata).length === 0 ? null : metadata;
}

/**
 * Captures one provider request body into the stored provider-request panel.
 *
 * Providers send bodies in several shapes: a plain string (the common case), a
 * `Uint8Array`/Buffer (Qoder's custom cosy encoding), or another BodyInit
 * type (URLSearchParams, Blob, FormData) that cannot be sliced safely here.
 * Strings and byte arrays are decoded and stored; anything else is recorded as
 * present-but-opaque, same as the metadata path.
 */
function captureRequestBodyBody(
  body: BodyInit,
  maxBytes: number,
): { body: unknown } | { body_present: true; body_bytes: number } {
  if (typeof body === "string") {
    return { body: parseCapturedBody(truncateUtf8(body, maxBytes)) };
  }
  if (body instanceof Uint8Array) {
    return { body: parseCapturedBody(truncateUtf8(new TextDecoder().decode(body), maxBytes)) };
  }
  return { body_present: true, body_bytes: capturedBodyByteLength(body) };
}

/** Byte length of a request body in whatever shape the provider sent it. */
function capturedBodyByteLength(body: BodyInit): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  if (typeof body === "object" && body !== null && "size" in body) {
    const size = (body as { size?: unknown }).size;
    if (typeof size === "number" && Number.isFinite(size)) return Math.round(size);
  }
  if (typeof body === "object" && body !== null && "byteLength" in body) {
    const byteLength = (body as { byteLength?: unknown }).byteLength;
    if (typeof byteLength === "number" && Number.isFinite(byteLength)) return Math.round(byteLength);
  }
  return 0;
}

/**
 * Wraps a validated outbound fetch to tee the provider request/response.
 *
 * `captureBody=false` records the request line but skips the response
 * `clone()` + bounded read: tenants in `none`/`metadata` mode paid a full
 * 256 KiB tee + decode + parse per attempt for bodies the terminal capture
 * discarded. The request line is metadata-cheap and always kept.
 */
export function captureProviderExchange(
  inner: ValidatedOutboundFetch,
  sink: ProviderExchangeCapture,
  captureBody = true,
  maxBytes = providerCaptureMaxBytes(),
): ValidatedOutboundFetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody = init?.body;
    const headers = selectCapturedHeaders(init);
    sink.request = {
      method: init?.method ?? "GET",
      url,
      ...(headers === undefined ? {} : { headers }),
      // `captureBody=false` is the `none`/`metadata` path: record that a body
      // was sent and how big it was, without slicing or parsing it. The old
      // shape sliced up to `maxBytes` of the translated body and ran it through
      // `JSON.parse` for every attempt — content a metadata-mode tenant had
      // explicitly declined to retain, paid on every dispatch.
      ...(rawBody === null || rawBody === undefined
        ? {}
        : captureBody
          ? captureRequestBodyBody(rawBody, maxBytes)
          : { body_present: true, body_bytes: capturedBodyByteLength(rawBody) }),
    };
    const response = await inner(input, init);
    sink.response =
      captureBody && shouldCaptureProviderResponse(response)
        ? readBoundedBody(response.clone(), maxBytes).then(parseCapturedBody)
        : Promise.resolve(null);
    // Read regardless of `captureBody`: this is metadata about the dispatch, not
    // payload retention, so a tenant in `metadata` mode still records which
    // model answered. It clones internally and reads only the head.
    sink.reportedModel = readReportedModel(response).catch(() => undefined);
    return response;
  };
}

/**
 * Resolves the captured provider payload with a bounded wait.
 *
 * Exported for the fake-timer suite, which pins that the race timer is
 * cleared as soon as the race settles.
 */
export async function resolvedProviderResponse(
  provider: ProviderExchangeCapture | undefined,
): Promise<unknown> {
  if (!provider) return null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      provider.response,
      new Promise<null>((resolve) => {
        // Cleared in `finally` on every exit: an uncleared timer would
        // outlive the attempt, retain the capture's promise chain, and keep
        // the event loop busy for the capture window after the response.
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, PROVIDER_CAPTURE_AWAIT_MS);
      }),
    ]);
    if (settled === null || settled === undefined) {
      // Distinguish "slow payload" from "no payload": a bare null cannot tell the
      // two apart, so the timeout is reported explicitly.
      return timedOut ? { _truncated: true, _reason: "provider_capture_timeout" } : null;
    }
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Captures terminal payloads before telemetry finalization. It never throws into
 * the request path, but awaiting the bounded storage operation ensures the
 * request-detail endpoint cannot race the payload row and report a false miss.
 */
export async function captureTerminalPayload(
  state: ProxyRequestState,
  db: CartethyiaDatabase,
  tenantId: string | null,
  requestId: string,
  requestBody: unknown,
  responseBody: unknown,
  clientResponseBody?: string,
  providerCapture?: ProviderExchangeCapture,
): Promise<void> {
  // Every exit below records *why*. The drawer reads empty for all of them
  // alike, so without this an operator debugging remotely — with no access to
  // the server's logs — cannot distinguish "capture is off" from "capture is
  // broken", and the four blank panels look like a bug either way.
  const note = (reason: PayloadCaptureState): void => {
    state.payloadCaptureState = reason;
  };
  if (!tenantId) {
    note("skipped_no_tenant");
    return;
  }
  try {
    // Resolved once per request and memoized on the request state. The
    // per-attempt call in the dispatch paths and this terminal call were
    // resolving the same tenant setting independently, so a request with
    // several attempts paid for it repeatedly and the two call sites could
    // disagree about whether capture is on at all.
    if (state.payloadCapturePreference === undefined) {
      state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
    }
    const resolved = state.payloadCapturePreference;
    if (!resolved.ok) {
      note("skipped_preference_read_failed");
      return;
    }
    const { mode, depth, retentionMs } = resolved;
    if (mode === "none") {
      note("skipped_mode_none");
      return;
    }
    if (mode === "metadata") {
      const providerRequest = providerRequestMetadataOnly(providerCapture?.request ?? null);
      if (providerRequest === null) {
        note("captured_metadata");
        return;
      }
      const metadataCapture = await new TelemetryPayloadCapture(db).capture({
        tenantId,
        requestId,
        requestBody: null,
        responseBody: null,
        providerRequestBody: providerRequest,
        retentionMs,
        scope: "tenant",
        tenantOptIn: true,
      });
      note(metadataCapture.payloadCaptureState ?? "captured_metadata");
      return;
    }
    const maxBytes = captureDepthMaxBytes(depth);
    const providerRequest = providerCapture?.request ?? null;
    const providerResponse = await resolvedProviderResponse(providerCapture);
    const terminalCapture = await new TelemetryPayloadCapture(db).capture({
      tenantId,
      requestId,
      requestBody: requestBody ?? null,
      responseBody: responseBody ?? null,
      ...(clientResponseBody === undefined ? {} : { clientResponseBody: clientResponseBody ?? null }),
      ...(providerRequest === null ? {} : { providerRequestBody: providerRequest }),
      ...(providerResponse === null ? {} : { providerResponseBody: providerResponse }),
      maxBytes,
      retentionMs,
      scope: "tenant",
      tenantOptIn: true,
    });
    note(terminalCapture.payloadCaptureState ?? "captured");
  } catch (error) {
    note("failed_write");
    reportCaptureFailure(error);
  }
}

let captureFailureReported = false;

/**
 * One warning per process for a failing payload capture. The cause is a
 * deployment condition that does not change per request, so repeating it for
 * every request would bury the rest of the log without adding information.
 */
function reportCaptureFailure(error: unknown): void {
  if (captureFailureReported) return;
  captureFailureReported = true;
  const directory = payloadDirectory();
  const reason = error instanceof Error ? error.message : String(error);
  log.warn(
    `[telemetry] payload capture is enabled for this tenant but the body was not stored ` +
      `(${reason}). Check that "${directory}" exists and is writable by the runtime user; ` +
      `a bind-mounted data directory is often owned by root while the container runs unprivileged.`,
  );
}
