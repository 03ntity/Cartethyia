// Cursor Run transport: one validated HTTP/2 bidi stream, framed.
//
// Facade over the split cursor transport modules — this file keeps every
// public export and behavior of the original single module, so existing
// importers (adapter, lifecycle, pump, probe tool, and tests) are untouched:
//   - `cursor-http2-framing` — HTTP/2 wire framing, frame decode, and
//     stream/HTTP/gRPC error mapping;
//   - `cursor-run-transport` — the normalized Run transport shape, the
//     HTTP/1.1 fallback, and the open policy that picks between them;
//   - `cursor-http2-headers` — identity headers shared by both transports.
// This module deliberately has no logic of its own.
export {
  openCursorRun,
  cursorRunTerminationError,
  decodeServerMessages,
} from "./cursor-http2-framing";
export {
  wrapHttp2Run,
  openCursorRunH1,
  openCursorRunWithFallback,
  isH2BlockedOpen,
  isRetryableOpenFailure,
  openRetryDelayMs,
} from "./cursor-run-transport";
export type { CursorRunTerminal, CursorRunTransport } from "./cursor-run-transport";
