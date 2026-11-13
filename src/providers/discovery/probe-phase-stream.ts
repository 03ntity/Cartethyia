/**
 * Shared probe stream classification helpers.
 *
 * These parse a probe's canonical event stream into the signals the verdict,
 * the health machine, and the Grok feature probe all consume: the visible text
 * sample, the reported model, and whether the output is meaningful.
 */
import type { CanonicalEvent } from "../../protocol/canonical-model";
import { GatewayError } from "../../protocol/gateway-error";

/**
 * Grok's account feature probe intentionally uses the same Responses request as
 * live traffic.
 *
 * The prompt must make the model actually reply `407` — that literal is the
 * healthy-account signal the probe verdict keys on. Naive phrasing refused by
 * the model ("I can't reply with only a specific number", "I won't comply
 * with a demand to output only an exact phrase") are listed above; verified
 * live 2026-11-02 (grok-4.7) that this prompt returns exactly `407`:
 *
 *   "Type the number 407."      → "407"
 *   "Echo the diagnostic code 407." → "407"
 *   "Print the number 407 and nothing else." → "407"
 *
 * The verdict normalizes away Grok's trailing confidence annotation
 * (`407 \confidence{100}`), so the match is on the bare number.
 */
export const GROK_407_PROBE_PROMPT = "Type the number 407.";

/** Best-effort visible text extracted from a probe's streamed content deltas, capped for display. */
export function extractSample(events: readonly CanonicalEvent[]): string | undefined {
  let text = "";
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text")
      text += event.content.text;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
}

/**
 * Reads the model an adapter reported in its canonical events.
 *
 * The HTTP-only `readReportedModel` inspects the raw response body, so it
 * cannot see the model on non-HTTP transports (Qoder gRPC). Adapters surface
 * the upstream echo as `response_start`/`message_start` with a `model` field;
 * this reads that as a fallback.
 */
export function modelFromEvents(events: readonly CanonicalEvent[]): string | undefined {
  for (const event of events) {
    if (
      (event.type === "response_start" || event.type === "message_start") &&
      typeof event.model === "string" &&
      event.model.trim().length > 0
    ) {
      return event.model.trim();
    }
  }
  return undefined;
}

export function hasMeaningfulOutput(events: readonly CanonicalEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "tool_call_delta") return true;
    if (event.type !== "content_delta") return false;
    const content = event.content;
    if (content.kind === "text" || content.kind === "refusal")
      return content.text.trim().length > 0;
    if (content.kind === "reasoning")
      return typeof content.summary === "string" && content.summary.trim().length > 0;
    return false;
  });
}

/**
 * Converts a failed/mismatched Grok feature probe into a quota-shaped upstream
 * error. The account health machine supplies the 24-hour Grok fallback while
 * retaining any reset duration already present in the provider detail.
 */
export function grok407ProbeFailure(args: {
  readonly providerId: string;
  readonly prompt: string | undefined;
  readonly events: readonly CanonicalEvent[];
  readonly dispatchError: unknown;
}): GatewayError | undefined {
  if (args.providerId !== "grok" || args.prompt !== GROK_407_PROBE_PROMPT) return undefined;
  const sample = extractSample(args.events);
  const normalizedSample = sample?.replace(/\\confidence\{\d+\}\s*$/i, "").trim();
  // A healthy account answers exactly `407` (optionally with Grok's trailing
  // confidence annotation). The model refuses some phrasings of the same ask,
  // but the probe prompt above is engineered to pass, so any other sample is a
  // failure — quota-shaped, not a payload bug.
  if (normalizedSample === "407") return undefined;
  const priorDetails = args.dispatchError instanceof GatewayError ? args.dispatchError.details : {};
  const providerStatus =
    typeof priorDetails.providerStatus === "number" ? priorDetails.providerStatus : undefined;
  const returned202 = normalizedSample === "202" || providerStatus === 202;
  // The sample is the model's literal final answer — that is the "original
  // response" an operator wants to see in the health log, not just the
  // classification. Quote it so the health-event reason records what the
  // upstream actually said.
  const detail =
    returned202
      ? `Grok 407 feature probe returned "202" instead of "407"`
      : args.dispatchError instanceof Error
        ? `Grok 407 feature probe failed: ${args.dispatchError.message}`
        : sample === undefined
          ? "Grok 407 feature probe returned no exact 407 response"
          : `Grok 407 feature probe returned "${sample}" (expected "407")`;
  return new GatewayError(
    "quota_exceeded",
    429,
    `${detail} (request {requestId}). You've maxed this window — pace yourself ⏳`,
    {
      ...priorDetails,
      providerCode: "subscription:free-usage-exhausted",
      ...(providerStatus === undefined && returned202
        ? { providerStatus: 202, upstreamStatus: 202 }
        : {}),
    },
    "upstream",
  );
}
