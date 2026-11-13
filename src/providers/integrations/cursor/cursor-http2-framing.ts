// Cursor Run HTTP/2 transport framing.
//
// This module owns the HTTP/2 wire and nothing else. It opens the stream
// through the validated HTTP/2 binding, writes Connect frames, decodes
// response frames back into protobuf messages, and maps stream/HTTP/gRPC
// outcomes onto typed errors. It never calls `node:http2.connect` itself —
// the binding owns the socket, the DNS pinning, the SSRF policy, and the pool
// tunnel. This is the HTTP/2 transport framing seam of the cursor-http2
// module family: identity headers live in `cursor-http2-headers`, and the
// normalized Run transport (HTTP/1.1 fallback plus session orchestration)
// lives in `cursor-run-transport`.
import { GatewayError } from "../../../protocol/gateway-error";
import type { GatewayErrorCode } from "../../../protocol/gateway-error";
import type { ValidatedHttp2BidiStream, Http2BidiEndReason } from "../../../network/bidi";
import type { ValidatedOutboundHttp2Bidi } from "../../provider-contracts";
import { decodeFramePayload, encodeFrame, streamFrames, FLAG_END_STREAM } from "./protocol/framing";
import { decodeMessage } from "./protocol/messages";
import { FALLBACK_CLIENT_VERSION, RUN_PATH, isAllowedAgentHost } from "./cursor-shared";
import { FrameBuffer } from "../shared/connect";
import { isRecord } from "../../../protocol/codecs";
import { runHeaders } from "./cursor-http2-headers";

/** The closing text every Cursor upstream refusal carries after its requestId. */
const UPSTREAM_REFUSAL_SUFFIX = {
  authentication: "Wrong key, right door — check the credential 🔑",
  quota: "You've maxed this window — pace yourself ⏳",
  deadline: "Some things just take longer 🐢",
  unavailable: "The upstream came back empty-handed — retry 🌙",
} as const;

type UpstreamRefusalKind = keyof typeof UPSTREAM_REFUSAL_SUFFIX;

/**
 * The one upstream-refusal builder, shared by all three upstream surfaces
 * (Connect JSON envelope, gRPC status, HTTP/1.1 status): a refusal kind maps
 * to the gateway's error taxonomy code/status and the shared closing text.
 * The headline and details stay at the call site, so the surfaces cannot
 * drift apart on codes, statuses, or closing texts.
 */
export function cursorUpstreamError(
  kind: UpstreamRefusalKind,
  headline: string,
  details: Readonly<Record<string, unknown>>,
): GatewayError {
  const [code, status]: [GatewayErrorCode, number] =
    kind === "authentication"
      ? ["authentication_failed", 401]
      : kind === "quota"
        ? ["quota_exceeded", 429]
        : kind === "deadline"
          ? ["deadline_exceeded", 504]
          : ["platform_unavailable", 502];
  return new GatewayError(
    code,
    status,
    `${headline} (request {requestId}). ${UPSTREAM_REFUSAL_SUFFIX[kind]}`,
    details,
    "upstream",
  );
}

/**
 * The refusal Cursor sends inside an otherwise-successful 200 Run stream.
 *
 * It is a Connect JSON error envelope, not protobuf, and it is where a real
 * account-level refusal lands — a rate-limited or exhausted account streams a
 * heartbeat and then this. Without it the Run looks like a deadlock: the
 * stream opened, no text ever arrived, and nothing named the reason.
 */
function connectErrorEnvelope(payload: Uint8Array): GatewayError | undefined {
  const text = new TextDecoder().decode(payload);
  if (!text.trimStart().startsWith("{\"error\"")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["error"])) return undefined;
  const error = parsed["error"];
  const code = typeof error["code"] === "string" ? error["code"] : "";
  const detail = cursorErrorDetail(error);
  const details = { providerId: "cursor", upstreamCode: code };
  return code === "resource_exhausted"
    ? cursorUpstreamError("quota", `Cursor refused the Run: ${detail}`, details)
    : cursorUpstreamError("unavailable", `Cursor refused the Run: ${detail}`, details);
}

/** The human-readable refusal, preferring Cursor's own `chatMessage`/`detail`. */
function cursorErrorDetail(error: Record<string, unknown>): string {
  const raw = typeof error["message"] === "string" ? error["message"] : "";
  for (const detail of Array.isArray(error["details"]) ? error["details"] : []) {
    if (!isRecord(detail)) continue;
    const debug = detail["debug"];
    if (!isRecord(debug)) continue;
    const info = debug["details"];
    if (isRecord(info)) {
      const chat = info["chatMessage"];
      if (typeof chat === "string" && chat.length > 0) return chat;
      const title = info["title"];
      if (typeof title === "string" && title.length > 0) return title;
    }
  }
  return raw.length > 0 ? raw : "Cursor refused the Run";
}

/** Read-idle bound for one Run stream. */
export const DEFAULT_READ_IDLE_MS = 120_000;

/**
 * Opens one Cursor Run stream.
 *
 * The host is re-validated here as well as in the binding: the Run origin comes
 * from `GetServerConfig`, which is upstream data, so it is checked against the
 * Cursor allowlist before a credentialed connection is opened to it.
 */
export async function openCursorRun(input: {
  readonly origin: string;
  readonly credential: string;
  readonly outboundHttp2: ValidatedOutboundHttp2Bidi;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
  readonly requestId?: string;
}): Promise<{ stream: ValidatedHttp2BidiStream; requestId: string; write: (message: Uint8Array) => Promise<void> }> {
  const url = new URL(`${input.origin}${RUN_PATH}`);
  if (url.protocol !== "https:" || !isAllowedAgentHost(url.hostname)) {
    throw new GatewayError(
      "invalid_request",
      400,
      "Cursor Run requires an allowlisted Cursor agent origin (request {requestId}). All roads blocked — time to find a new route 🗺️",
      { origin: input.origin },
    );
  }
  const requestId = input.requestId ?? crypto.randomUUID();
  const headers = await runHeaders(input.credential, input.clientVersion ?? FALLBACK_CLIENT_VERSION, requestId);
  const stream = await input.outboundHttp2(url, headers, {
    signal: input.signal,
    readIdleMs: input.readIdleMs ?? DEFAULT_READ_IDLE_MS,
    allowHostname: isAllowedAgentHost,
  });
  return {
    stream,
    requestId,
    write: async (message: Uint8Array): Promise<void> => {
      await stream.write(encodeFrame(0, message));
    },
  };
}

/** Map of gRPC status codes onto gateway errors. */
function grpcError(status: string, message: string | undefined): GatewayError {
  const code = Number(status);
  const detail = message === undefined || message.length === 0 ? "" : `: ${message}`;
  const details = { grpcStatus: status };
  if (code === 16 || code === 7) {
    // UNAUTHENTICATED / PERMISSION_DENIED: the credential, not the request.
    return cursorUpstreamError("authentication", `Cursor refused the credential${detail}`, details);
  }
  if (code === 8 || code === 14) {
    return cursorUpstreamError("quota", `Cursor refused the Run${detail}`, details);
  }
  if (code === 4 || code === 10) {
    return cursorUpstreamError("deadline", `Cursor Run ended before it finished${detail}`, details);
  }
  return cursorUpstreamError("unavailable", `Cursor Run failed (gRPC ${status})${detail}`, details);
}

/**
 * The terminal error for one ended Run stream.
 *
 * Status, trailers, and transport error are read in that order because that is
 * the order of authority: an HTTP status is what the edge answered, a gRPC
 * trailer is what the server decided, and a transport error is what the socket
 * did. A clean close with none of them is still a failure — a Run that ends
 * without `turn_ended` produced no answer.
 */
export function cursorRunTerminationError(input: {
  readonly stream: ValidatedHttp2BidiStream;
  readonly reason: Http2BidiEndReason;
}): GatewayError | undefined {
  if (input.reason.kind === "local-close") return undefined;
  if (input.reason.kind === "remote-error") {
    return input.reason.error instanceof GatewayError
      ? input.reason.error
      : new GatewayError(
          "transport_unavailable",
          502,
          `Cursor Run transport interrupted: ${input.reason.error.message} (request {requestId}). The connection ghosted us — come back in a moment 👻`,
          {},
          "network",
        );
  }
  const { status, headers } = input.stream.response;
  if (status !== 0 && status !== 200) {
    const message = headers["grpc-message"];
    return new GatewayError(
      status === 401 || status === 403 ? "authentication_failed" : "platform_unavailable",
      status === 401 || status === 403 ? 401 : 502,
      `Cursor Run failed by remote: ${status} (request {requestId}). The upstream came back empty-handed — retry 🌙`,
      { httpStatus: status, ...(message === undefined ? {} : { upstreamMessage: message }) },
      "upstream",
    );
  }
  const trailers = input.stream.trailers;
  const grpcStatus = trailers["grpc-status"] ?? headers["grpc-status"];
  if (grpcStatus !== undefined && grpcStatus !== "0") {
    return grpcError(grpcStatus, trailers["grpc-message"] ?? headers["grpc-message"]);
  }
  return new GatewayError(
    "platform_unavailable",
    502,
    "Cursor Run ended before turn_ended (request {requestId}). The upstream came back empty-handed — retry 🌙",
    {},
    "upstream",
  );
}

/**
 * Decodes a response byte stream into Cursor server messages.
 *
 * Reassembly rides on the shared `FrameBuffer`: chunks append into spare
 * capacity and `consume` only advances an offset, so a Run frame that spans
 * many reads no longer costs O(n²) copying — the previous implementation
 * re-concatenated the whole pending buffer on every chunk.
 */
export async function* decodeServerMessages(
  body: AsyncIterable<Uint8Array>,
  maxBufferedBytes = 64 * 1024 * 1024,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const buffered = new FrameBuffer();
  for await (const chunk of body) {
    buffered.append(chunk);
    const pending = buffered.view();
    if (pending.byteLength > maxBufferedBytes) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Cursor Run exceeded the frame buffer bound (request {requestId}). The upstream sent more than we can hold — retry 🌙",
        {},
        "upstream",
      );
    }
    const frames = [...streamFrames(pending)];
    if (frames.length === 0) continue;
    let consumed = 0;
    for (const frame of frames) consumed += 5 + frame.payload.byteLength;
    // Frame payloads stay views of the backing store, which no append touches
    // until the next loop iteration; consuming here just advances the offset.
    buffered.consume(consumed);
    for (const frame of frames) {
      const payload = decodeFramePayload(frame);
      // A refusal is a Connect JSON error envelope, not protobuf: an exhausted
      // account answers with one inside a normal 200 stream. Surfacing it is
      // the difference between "the model said nothing" and "you hit your
      // usage limit".
      const envelope = connectErrorEnvelope(payload);
      if (envelope !== undefined) throw envelope;
      try {
        const decoded = decodeMessage("AgentServerMessage", payload);
        // Shape-only wire traces and checkpoint retention need the raw frame,
        // but the decoded message must stay a plain protobuf object for the
        // adapter (and for encodeMessage round-trips). Non-enumerable keeps it
        // out of Object.keys/JSON, so no existing consumer sees a new field.
        Object.defineProperty(decoded, "__bytes", { value: payload, enumerable: false });
        yield decoded;
      } catch {
        // One undecodable frame is not a protocol failure to abort on: Cursor
        // extends this schema with fields this vendored copy does not model, and
        // a Run that produced usable output must not die on one unknown field.
        continue;
      }
      // `END_STREAM` ends the *response*, not the payload: Cursor sets it on the
      // last frame of a Run, which is exactly the frame carrying `turn_ended`
      // and the model's final text. Returning before decoding it dropped every
      // answer and left the Run looking like a heartbeat-only deadlock.
      if ((frame.flags & FLAG_END_STREAM) !== 0) return;
    }
  }
}
