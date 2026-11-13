// Cursor Run transport: one normalized wire shape across HTTP/2 and HTTP/1.1,
// plus the open policy that picks between them.
//
// HTTP/2 is the Run's native shape, but a network that cannot carry a
// bidirectional HTTP/2 stream (a tunneling proxy, an ALPN-restricted middlebox)
// must not turn Cursor into a provider that cannot serve at all: Cursor's own
// clients run the same conversation over HTTP/1.1, with the server's frames
// down one `AgentService/RunSSE` stream and each client message up as a
// numbered `BidiService/BidiAppend` call (donor wire, verified: the append
// body is raw protobuf — hex message, the request id, the sequence number —
// not a Connect frame). This is the session/request handling seam of the
// cursor-http2 module family: framing lives in `cursor-http2-framing`, and
// identity headers live in `cursor-http2-headers`.
import { GatewayError } from "../../../protocol/gateway-error";
import type { ValidatedOutboundHttp2Bidi } from "../../provider-contracts";
import { encodeFrame, FLAG_END_STREAM } from "./protocol/framing";
import { CURSOR_API_BASE_URL, FALLBACK_CLIENT_VERSION } from "./cursor-shared";
import { fnv1a32 } from "../shared/hash";
import { TtlCache } from "../../../persistence/ttl-cache";
import { runHeaders } from "./cursor-http2-headers";
import {
  cursorRunTerminationError,
  cursorUpstreamError,
  DEFAULT_READ_IDLE_MS,
  openCursorRun,
} from "./cursor-http2-framing";
import type { ValidatedHttp2BidiStream } from "../../../network/bidi";

/** Why one Run transport ended, with the failure the pump should surface. */
export interface CursorRunTerminal {
  readonly kind: "remote-error" | "remote-clean-close" | "local-close";
  readonly failure: GatewayError | undefined;
}

/**
 * One Run's wire, normalized across transports.
 *
 * `body` yields raw response bytes (Connect-framed server messages) and
 * `write` sends one framed client message; the frame pump in the adapter
 * consumes both without knowing which transport is underneath.
 */
export interface CursorRunTransport {
  readonly mode: "http2" | "http1";
  readonly body: AsyncIterable<Uint8Array>;
  write(message: Uint8Array): Promise<void>;
  abort(): void;
  /** Terminal listener; at most one terminal is delivered per transport. */
  onTerminal(listener: (terminal: CursorRunTerminal) => void): () => void;
}

/**
 * Listener hub for one transport's single terminal event.
 *
 * At most one terminal is ever delivered, listeners may unsubscribe, and a
 * listener failure never skips the remaining listeners. Shared by both
 * transports so their settle semantics cannot drift apart.
 */
function makeTerminalHub(): {
  settle(terminal: CursorRunTerminal): void;
  onTerminal(listener: (terminal: CursorRunTerminal) => void): () => void;
} {
  const listeners = new Set<(terminal: CursorRunTerminal) => void>();
  let settled = false;
  return {
    settle(terminal: CursorRunTerminal): void {
      if (settled) return;
      settled = true;
      for (const listener of [...listeners]) {
        try {
          listener(terminal);
        } catch {
          // A listener failure must not skip the remaining listeners.
        }
      }
      listeners.clear();
    },
    onTerminal(listener: (terminal: CursorRunTerminal) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Wraps the validated HTTP/2 stream in the normalized transport shape. */
export function wrapHttp2Run(
  stream: ValidatedHttp2BidiStream,
  write: (message: Uint8Array) => Promise<void>,
): CursorRunTransport {
  const hub = makeTerminalHub();
  stream.onTerminal((reason) => {
    if (reason.kind === "local-close") {
      hub.settle({ kind: "local-close", failure: undefined });
      return;
    }
    if (reason.kind === "remote-clean-close") {
      // A clean close carries no failure of its own: the pump decides whether
      // a turn that ended without `turn_ended` is complete (text/step/tool
      // batch) or quiet. `cursorRunTerminationError` is for status/trailer
      // refusals, not for a stream the server simply closed.
      hub.settle({ kind: "remote-clean-close", failure: undefined });
      return;
    }
    hub.settle({
      kind: "remote-error",
      failure: cursorRunTerminationError({ stream, reason }) ?? undefined,
    });
  });
  return {
    mode: "http2",
    body: stream.body,
    write,
    abort: () => stream.abort(),
    onTerminal: hub.onTerminal,
  };
}

/** HTTP/1.1 Run constants, as the donor's clients pin them. */
const H1 = {
  /** ms a BidiAppend may take before the Run fails (donor appendWait). */
  appendWaitMs: 60_000,
  /** BidiAppends allowed on the wire at once (donor atOnce). */
  atOnce: 16,
} as const;

/** ms after one h2-blocked open that fresh Runs go straight to HTTP/1.1. */
const H2_RETRY_AFTER_MS = 10 * 60_000;
/** ms an HTTP/2 open may take before the transport itself is declared blocked. */
const H2_HEAD_WAIT_MS = 15_000;

/**
 * Per-credential HTTP/1.1 window after one h2-blocked open, digest-keyed.
 *
 * The window is the entry's TTL: a hit means HTTP/2 was declared blocked
 * within `H2_RETRY_AFTER_MS`. Bounded (LRU) like the roster cache — without a
 * cap, rotated credentials would grow the map forever.
 */
const H1_FALLBACK_MAX_CREDENTIALS = 1024;
const h1UntilByCredential = new TtlCache<true>({
  ttlMs: H2_RETRY_AFTER_MS,
  maxEntries: H1_FALLBACK_MAX_CREDENTIALS,
  lru: true,
});

function credentialDigest(credential: string): string {
  return String(fnv1a32(credential));
}

/** True when the failure to open an HTTP/2 Run says HTTP/2 itself is blocked. */
export function isH2BlockedOpen(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = String((error as Error & { code?: string }).code ?? "");
  if (/^ERR_HTTP2|^EPROTO/.test(code)) return true;
  const message = `${error.message} ${code}`.toLowerCase();
  return (
    /http\/?2|nghttp2|alpn|protocol error|settings frame|flow control/.test(message) &&
    !/refused|enotfound|econn|enetunreach|ehostunreach|epipe/.test(message)
  );
}

/**
 * Whether a failed Run *open* is worth retrying on a fresh transport.
 *
 * Connection and deadline failures are retried; auth, quota, and request-shape
 * refusals are not — retrying those just burns the account's remaining window.
 */
export function isRetryableOpenFailure(error: unknown): boolean {
  if (!(error instanceof GatewayError)) {
    // Raw transport throws (DNS, dial, TLS) come through as plain errors.
    return true;
  }
  if (error.code === "authentication_failed") return false;
  if (error.code === "quota_exceeded") return false;
  if (error.code === "invalid_request") return false;
  return true;
}

/** Backoff for open retries: 500 ms doubling, capped at 8 s (donor policy). */
export function openRetryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

/** The refusal every write on an already-ended HTTP/1.1 Run raises. */
function cursorH1TransportClosedError(): GatewayError {
  return new GatewayError(
    "transport_unavailable",
    502,
    "Cursor Run transport is closed (request {requestId}). The connection ghosted us — come back in a moment 👻",
    {},
    "network",
  );
}

/** Connect's code for an HTTP status that carried no Connect error of its own. */
function connectCodeForStatus(status: number): string {
  return { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 429: "resource_exhausted" }[
    status
  ] ?? "unavailable";
}

/** Maps an HTTP/1.1 Run failure onto the gateway's error taxonomy. */
function h1OpenFailure(status: number, message: string): GatewayError {
  if (status === 401 || status === 403) {
    return cursorUpstreamError("authentication", `Cursor refused the credential over HTTP/1.1: ${message}`, {});
  }
  if (status === 429) {
    return cursorUpstreamError("quota", `Cursor refused the Run over HTTP/1.1: ${message}`, {});
  }
  return cursorUpstreamError("unavailable", `Cursor Run failed over HTTP/1.1: ${message}`, {});
}

/** varint encoding for the BidiAppend body builder. */
function appendVarint(out: number[], value: number): void {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * Builds one raw `aiserver.v1.BidiAppendRequest` body:
 * field 1 `data` (hex string), field 2 `requestId` (message, field 1 string),
 * field 3 `appendSeqno` (int64). Verified against the donor's wire encoder.
 */
function bidiAppendBody(message: Uint8Array, requestId: string, seqno: number): Uint8Array {
  const hex = Buffer.from(message).toString("hex");
  const data = new TextEncoder().encode(hex);
  const id = new TextEncoder().encode(requestId);
  const out: number[] = [];
  out.push(0x0a);
  appendVarint(out, data.byteLength);
  for (const byte of data) out.push(byte);
  out.push(0x12, 2 + id.byteLength, 0x0a);
  appendVarint(out, id.byteLength);
  for (const byte of id) out.push(byte);
  out.push(0x18);
  appendVarint(out, seqno);
  return new Uint8Array(out);
}

/** True when a client message is a KV blob reply, which no append waits on. */
function isKvReply(message: Uint8Array): boolean {
  return message.byteLength > 0 && message[0] === 0x1a;
}

/**
 * Opens one Run over HTTP/1.1: the server's frames come down one RunSSE
 * stream, every client message goes up as a numbered BidiAppend call.
 *
 * Failures of an append or of the down stream end the Run with a synthesized
 * Connect error envelope (END_STREAM), so the shared decoder surfaces it as
 * the Run's own refusal — the pump cannot tell the transports apart.
 */
export async function openCursorRunH1(input: {
  readonly requestId: string;
  readonly credential: string;
  readonly fetcher: typeof fetch;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
}): Promise<CursorRunTransport> {
  const ac = new AbortController();
  const forwardAbort = (): void => ac.abort();
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  if (input.signal.aborted) ac.abort();

  const headers = await runHeaders(input.credential, input.clientVersion ?? FALLBACK_CLIENT_VERSION, input.requestId);
  const wireHeaders = {
    ...headers,
    "accept-encoding": "identity",
    "x-cursor-streaming": "true",
  };

  const hub = makeTerminalHub();
  let ended = false;
  let seqno = 0;
  const inflight = new Set<Promise<void>>();

  const queue: Array<Uint8Array | null> = [];
  let waiter: (() => void) | undefined;
  const pushDown = (chunk: Uint8Array | null): void => {
    queue.push(chunk);
    const wake = waiter;
    waiter = undefined;
    wake?.();
  };

  const failStream = (code: string, message: string, status: number): void => {
    if (ended) return;
    ended = true;
    // Synthesized Connect error envelope: the shared decoder reads it as the
    // Run's own refusal, exactly as it does over HTTP/2.
    const json = new TextEncoder().encode(JSON.stringify({ error: { code, message } }));
    pushDown(encodeFrame(FLAG_END_STREAM, json));
    pushDown(null);
    hub.settle({ kind: "remote-error", failure: h1OpenFailure(status, message) });
  };

  const endCleanly = (): void => {
    if (ended || inflight.size > 0) return;
    ended = true;
    pushDown(null);
    hub.settle({ kind: "remote-clean-close", failure: undefined });
  };

  const append = async (message: Uint8Array): Promise<void> => {
    const seq = seqno;
    seqno += 1;
    const body = bidiAppendBody(message, input.requestId, seq);
    const deadlineMs = H1.appendWaitMs + Math.ceil(body.byteLength / 65_536) * 1_000;
    const deadline = AbortSignal.timeout(deadlineMs);
    try {
      const response = await input.fetcher(`${CURSOR_API_BASE_URL}/aiserver.v1.BidiService/BidiAppend`, {
        method: "POST",
        headers: { ...wireHeaders, "content-type": "application/proto" },
        body: body as unknown as BodyInit,
        signal: AbortSignal.any([ac.signal, deadline]),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        failStream(connectCodeForStatus(response.status), text.trim() || `HTTP ${response.status}`, response.status);
        return;
      }
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      if (ac.signal.aborted || input.signal.aborted) return;
      if (deadline.aborted) {
        failStream("deadline_exceeded", `BidiAppend got no answer in ${Math.round(deadlineMs / 1_000)}s`, 504);
        return;
      }
      failStream("unavailable", `BidiAppend: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  };

  const track = (promise: Promise<void>): void => {
    inflight.add(promise);
    void promise.finally(() => {
      inflight.delete(promise);
      // A down stream that already ended cleanly while appends were on the
      // wire becomes terminal only once they have all been answered.
      if (inflight.size === 0 && sseDone && !ended) endCleanly();
    });
  };
  let sseDone = false;
  /** One append whose completion the write path waits on. */
  const appendTracked = (message: Uint8Array): Promise<void> => {
    const promise = append(message);
    track(promise);
    return promise;
  };

  const transport: CursorRunTransport = {
    mode: "http1",
    body: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            for (;;) {
              const front = queue.shift();
              if (front === undefined) {
                if (ended) return { done: true, value: undefined };
                await new Promise<void>((resolve) => {
                  waiter = resolve;
                });
                continue;
              }
              if (front === null) return { done: true, value: undefined };
              return { done: false, value: front };
            }
          },
        };
      },
    },
    write: async (message: Uint8Array): Promise<void> => {
      if (ended || ac.signal.aborted) {
        throw cursorH1TransportClosedError();
      }
      // KV blob replies never wait: nothing else depends on them, and Cursor
      // asks for a fresh Run's whole history at once (donor kvReply rule).
      if (isKvReply(message)) {
        track(append(message));
        return;
      }
      // Every other message serializes: it goes up only after the appends
      // before it were answered, in sequence order (donor ordering rule).
      while (inflight.size > 0 && !ended && !ac.signal.aborted) {
        await Promise.race([...inflight]);
      }
      if (ended || ac.signal.aborted) {
        throw cursorH1TransportClosedError();
      }
      await appendTracked(message);
    },
    abort: () => {
      ac.abort();
      if (!ended) {
        ended = true;
        pushDown(null);
        hub.settle({ kind: "local-close", failure: undefined });
      }
    },
    onTerminal: hub.onTerminal,
  };

  // Down stream: RunSSE, opened with one Connect frame carrying the request
  // id (field 1, string) — the linkage every append repeats. The opener is
  // a regular message frame (flags 0), not an END_STREAM frame: END_STREAM
  // ends the *response*, not the request body.
  void (async () => {
    try {
      const id = new TextEncoder().encode(input.requestId);
      const runOpen = new Uint8Array(2 + id.byteLength);
      runOpen[0] = 0x0a;
      runOpen[1] = id.byteLength;
      runOpen.set(id, 2);
      const response = await input.fetcher(`${CURSOR_API_BASE_URL}/agent.v1.AgentService/RunSSE`, {
        method: "POST",
        headers: wireHeaders,
        body: encodeFrame(0, runOpen) as unknown as BodyInit,
        signal: ac.signal,
      });
      if (!response.ok || response.body === null) {
        const text = response.body === null ? "no response body" : await response.text().catch(() => "");
        failStream(
          connectCodeForStatus(response.status),
          text.trim() || `HTTP ${response.status}`,
          response.status,
        );
        return;
      }
      const reader = response.body.getReader();
      const readIdleMs = input.readIdleMs ?? DEFAULT_READ_IDLE_MS;
      for (;;) {
        if (ended) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`RunSSE idle past ${readIdleMs}ms`)), readIdleMs);
            timer.unref?.();
          }),
        ]);
        if (chunk.done) {
          sseDone = true;
          endCleanly();
          return;
        }
        pushDown(chunk.value);
      }
    } catch (error) {
      if (ac.signal.aborted || input.signal.aborted) {
        if (!ended) {
          ended = true;
          pushDown(null);
          hub.settle({ kind: "local-close", failure: undefined });
        }
        return;
      }
      failStream("unavailable", `RunSSE: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  })();

  return transport;
}

/**
 * Opens one Cursor Run with the donor's transport policy: HTTP/2 first, and —
 * when HTTP/2 itself is blocked here — HTTP/1.1 immediately, with fresh Runs
 * staying on HTTP/1.1 for a window. A plain connection failure leaves the next
 * Run on HTTP/2 again; it says nothing about HTTP/2 being unavailable.
 */
export async function openCursorRunWithFallback(input: {
  readonly origin: string;
  readonly credential: string;
  readonly outboundHttp2: ValidatedOutboundHttp2Bidi | undefined;
  readonly outboundFetch: typeof fetch | undefined;
  readonly signal: AbortSignal;
  readonly clientVersion?: string;
  readonly readIdleMs?: number;
  /** Stable request id across H2 → H1 fallback and stream retries. */
  readonly requestId?: string;
  /** Force HTTP/1.1 after a mid-stream HTTP/2 failure. */
  readonly forceH1?: boolean;
}): Promise<{ transport: CursorRunTransport; requestId: string }> {
  const digest = credentialDigest(input.credential);
  const onH1Window = h1UntilByCredential.get(digest) !== undefined;
  if (input.forceH1 === true) h1UntilByCredential.set(digest, true);
  if (input.forceH1 === true || onH1Window || input.outboundHttp2 === undefined) {
    return openH1OrThrow(input, input.requestId ?? crypto.randomUUID());
  }
  let openedPromise: ReturnType<typeof openCursorRun> | undefined;
  try {
    openedPromise = openCursorRun({
      origin: input.origin,
      credential: input.credential,
      outboundHttp2: input.outboundHttp2,
      signal: input.signal,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
      ...(input.readIdleMs === undefined ? {} : { readIdleMs: input.readIdleMs }),
    });
    let headTimedOut = false;
    let headTimer: ReturnType<typeof setTimeout> | undefined;
    let opened: Awaited<typeof openedPromise>;
    try {
      opened = await Promise.race([
        openedPromise,
        new Promise<never>((_, reject) => {
          headTimer = setTimeout(() => {
            headTimedOut = true;
            reject(Object.assign(new Error("HTTP/2 Run got no response head in 15s"), { name: "H2HeadTimeout" }));
          }, H2_HEAD_WAIT_MS);
          headTimer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(headTimer);
      // A head that arrived after the timeout is a live stream nobody owns:
      // abort it instead of leaking the socket.
      if (headTimedOut) void openedPromise.then((o) => o.stream.abort(), () => undefined);
    }
    return {
      transport: wrapHttp2Run(opened.stream, opened.write),
      requestId: opened.requestId,
    };
  } catch (error) {
    if (!isH2BlockedOpen(error)) throw error;
    h1UntilByCredential.set(digest, true);
    // The donor keeps one request id across the fallback: RunSSE's opener and
    // every BidiAppend repeat the id the HTTP/2 Run was opened with.
    return openH1OrThrow(
      input,
      input.requestId ?? openedPromise?.then((o) => o.requestId).catch(() => crypto.randomUUID()) ?? crypto.randomUUID(),
    );
  }
}

/** Opens the HTTP/1.1 fallback, refusing when no validated egress can carry it. */
async function openH1OrThrow(
  input: {
    readonly credential: string;
    readonly outboundFetch: typeof fetch | undefined;
    readonly signal: AbortSignal;
    readonly clientVersion?: string;
    readonly readIdleMs?: number;
  },
  requestId: string | Promise<string>,
): Promise<{ transport: CursorRunTransport; requestId: string }> {
  const id = await requestId;
  if (input.outboundFetch === undefined) {
    throw new GatewayError(
      "admission_unavailable",
      503,
      "Cursor fell back to HTTP/1.1 but no validated egress is configured for this route (request {requestId}). No bridge to cross — configure a pool first 🏗️",
      { providerId: "cursor" },
    );
  }
  const transport = await openCursorRunH1({
    requestId: id,
    credential: input.credential,
    fetcher: input.outboundFetch,
    signal: input.signal,
    ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
    ...(input.readIdleMs === undefined ? {} : { readIdleMs: input.readIdleMs }),
  });
  return { transport, requestId: id };
}
