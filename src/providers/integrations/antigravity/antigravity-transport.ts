/**
 * Antigravity transport-edge helpers: production→sandbox URL failover and the
 * bounded first-burst SSE drain that decides empty-stream recovery.
 *
 * Split out of `antigravity.ts`; `failoverAntigravityUrl` is re-exported by
 * the facade so importers are unchanged. `isFailoverStatus` and
 * `peekAntigravityTally` are internal helpers the adapter imports but are not
 * part of the facade surface.
 */
import { ANTIGRAVITY_SANDBOX_BASE } from "./antigravity-protocol";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  responseParts,
} from "../../../protocol/response/gemini";
import type { StreamTally } from "../../../transport/dispatch/empty-stream";

/** Statuses worth one bounded sandbox failover (throttled or server-side). */
export function isFailoverStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Drains just enough of an Antigravity SSE body to know whether it carries
 * anything, then stops.
 *
 * The caller passes a *clone*, so the original body reader is never consumed
 * and the real stream still flows untouched. Reading stops at the first
 * meaningful event or after `maxChunks` data events, whichever comes first —
 * a healthy stream therefore costs one bounded read of its opening burst
 * rather than a full drain, which is what makes the pre-commit peek cheap
 * enough to sit on the hot path.
 */
export async function peekAntigravityTally(
  response: Response,
  signal: AbortSignal,
  maxChunks = 8,
): Promise<StreamTally> {
  const body = response.body;
  if (body === null) return { dataEvents: 0, meaningful: false, thoughtOnly: false };
  let dataEvents = 0;
  let thought = false;
  for await (const sse of decodeSseEvents(body, { signal })) {
    const data = sse.data.trim();
    if (data.length === 0 || data === "[DONE]") continue;
    dataEvents++;
    const parsed = decodeGeminiStreamEvent(data, "antigravity stream error");
    if (parsed === undefined) continue;
    const { parts } = geminiCandidate(parsed);
    const output = responseParts(parts);
    if (output.thought) thought = true;
    if (output.text || output.calls.length > 0) {
      return { dataEvents, meaningful: true, thoughtOnly: false };
    }
    if (dataEvents >= maxChunks) break;
  }
  // A stream that ended with reasoning but no final output is a complete
  // provider response (the donor's thought-only carve-out): replaying it
  // burns a full reasoning pass for nothing, so it is never treated as empty.
  return { dataEvents, meaningful: false, thoughtOnly: thought };
}

/**
 * Sandbox twin of a production Antigravity URL, or undefined when the base
 * is already custom (only the known production host has a sandbox twin).
 */
export function failoverAntigravityUrl(url: string, baseUrl: string): string | undefined {
  if (!baseUrl.includes("daily-cloudcode-pa.googleapis.com")) return undefined;
  const sandboxBase = baseUrl.replace(
    "daily-cloudcode-pa.googleapis.com",
    new URL(ANTIGRAVITY_SANDBOX_BASE).host,
  );
  return url.startsWith(baseUrl) ? `${sandboxBase}${url.slice(baseUrl.length)}` : undefined;
}
