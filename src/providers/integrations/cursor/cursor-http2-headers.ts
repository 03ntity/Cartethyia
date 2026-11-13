// Cursor Run identity headers for the HTTP/2 and HTTP/1.1 transports.
//
// Both transports open a Run with the same header set: bearer credential,
// Connect protocol version, device-derived checksums, and timezone. Keeping
// them in one place stops the two transports from drifting apart on the
// identity surface. The header row is built from device identity helpers in
// `cursor-identity` and shared constants in `cursor-shared`.
import {
  CONTENT_TYPE_CONNECT_PROTO,
  CONNECT_PROTOCOL_VERSION,
  resolveCursorTimezone,
} from "./cursor-shared";
import { createCursorChecksumHeader, resolveCursorDeviceIds } from "./cursor-identity";

/** Cursor identity headers for the Run stream. */
export async function runHeaders(
  credential: string,
  clientVersion: string,
  requestId: string,
): Promise<Record<string, string>> {
  const { machineId, macMachineId } = await resolveCursorDeviceIds();
  return {
    authorization: `Bearer ${credential}`,
    "content-type": CONTENT_TYPE_CONNECT_PROTO,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "connect-accept-encoding": "gzip,br",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": clientVersion,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    // The CLI's streaming interceptor sets this on the bidi Run stream.
    // Without it Cursor may treat the stream as non-streaming.
    "x-cursor-streaming": "true",
    "x-ghost-mode": "true",
    "x-request-id": requestId,
    ...(resolveCursorTimezone() === "" ? {} : { "x-cursor-timezone": resolveCursorTimezone() }),
    "user-agent": "connect-es/1.6.1",
  };
}
