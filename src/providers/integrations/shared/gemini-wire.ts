/**
 * Shared Gemini-wire mapping for the two Gemini-envelope adapters
 * (`gemini.ts` and `antigravity/antigravity.ts`).
 *
 * Both adapters speak the Gemini `contents`/`candidates` wire over an SSE
 * stream (or a one-shot JSON body) and translate it to canonical events. The
 * translation was previously copy-pasted per adapter and drifted in small ways
 * (stop-map spelling, usage capture point). This module owns the mapping; the
 * adapters keep only their genuinely provider-specific terminal semantics and
 * session bookkeeping via the `onEvent` hook.
 *
 * Stop reasons come from the single mapper `toCanonicalStopReason` in
 * `protocol/response/gemini` — the module that owns the vocabulary. Note its
 * precedence: any tool calls win over `finishReason`, so a stream that emitted
 * calls ends `tool_use` even under `MAX_TOKENS`, and a `SAFETY` finish maps to
 * `stop`/`tool_use` rather than `content_filter`. This matches the non-stream
 * decode both adapters already shared.
 */
import type { CanonicalEvent } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import { isRecord } from "../../../protocol/codecs";
import { imagePrompt } from "../../../protocol/image-generation";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  mapGeminiUsage,
  responseParts,
  toCanonicalStopReason,
} from "../../../protocol/response/gemini";
import { usageFromProvider } from "../../provider-usage";
import type { ProviderDispatchTarget, WebSearchResult } from "../../provider-contracts";

/** What one decoded stream/body produced, plus the next sequence number. */
export interface GeminiWireSummary {
  readonly usage: ReturnType<typeof usageFromProvider>;
  /** The upstream `candidates[0]` record (stop reason + provider metadata). */
  readonly candidate: Record<string, unknown>;
  readonly finishReason: string | undefined;
  readonly toolCalls: number;
  /** Sequence number the caller's terminal event must use. */
  readonly nextSeq: number;
}

export interface GeminiWireOptions {
  /**
   * Called once per decoded upstream response body (per stream chunk, or once
   * for a non-stream body). Antigravity uses it to capture `responseId` into
   * its sticky session state.
   */
  readonly onEvent?: (decoded: Record<string, unknown>) => void;
}

export interface GeminiStreamOptions extends GeminiWireOptions {
  readonly signal: AbortSignal;
  /** Fallback message for an unlabelled error envelope; per-adapter so the operator can name the upstream. */
  readonly errorLabel: string;
  /**
   * The two streams disagree about `[DONE]`: Gemini skips the marker and keeps
   * reading, Antigravity stops. `true` (Antigravity) breaks the loop.
   */
  readonly stopAtDoneMarker?: boolean;
}

/**
 * Emits `response_start` plus the content/tool deltas of a non-stream Gemini
 * body, and returns the summary the caller builds its terminal from.
 */
export function* geminiNonStreamEvents(
  json: Record<string, unknown>,
  model: string,
  options: GeminiWireOptions = {},
): Generator<CanonicalEvent, GeminiWireSummary, void> {
  const { response: decoded, candidate: cand, parts } = geminiCandidate(json);
  options.onEvent?.(decoded);
  const output = responseParts(parts);
  let seq = 1;
  yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  if (output.thought) {
    yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: output.thought, ...(output.thoughtSignature ? { signature: output.thoughtSignature } : {}) } } as CanonicalEvent;
  }
  if (output.text) {
    yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
  }
  for (const call of output.calls) {
    yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, name: call.name, arguments_delta: JSON.stringify(call.args) } as CanonicalEvent;
  }
  const finishReason = typeof cand["finishReason"] === "string" ? (cand["finishReason"] as string) : undefined;
  return {
    usage: usageFromProvider(mapGeminiUsage(decoded)),
    candidate: cand,
    finishReason,
    toolCalls: output.calls.length,
    nextSeq: seq,
  };
}

/**
 * Consumes a Gemini-family SSE stream and emits `response_start` plus the
 * content/tool deltas. Tool calls are announced once (empty arguments) and then
 * incrementally by their serialized `args`, so a repeated call id accumulates
 * arguments instead of re-announcing.
 */
export async function* geminiStreamEvents(
  stream: ReadableStream<Uint8Array>,
  model: string,
  options: GeminiStreamOptions,
): AsyncGenerator<CanonicalEvent, GeminiWireSummary, void> {
  const { signal, errorLabel, stopAtDoneMarker = false, onEvent } = options;
  let seq = 1;
  yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  const activeCalls = new Set<string>();
  let rawUsage: Record<string, unknown> | undefined;
  let finishReason: string | undefined;
  let toolCalls = 0;
  let lastCandidate: Record<string, unknown> = {};
  for await (const sse of decodeSseEvents(stream, { signal })) {
    const data = sse.data.trim();
    if (data === "[DONE]") {
      if (stopAtDoneMarker) break;
      continue;
    }
    if (!data) continue;
    const parsed = decodeGeminiStreamEvent(data, errorLabel);
    if (parsed === undefined) continue;
    const { response: decoded, candidate: cand, parts } = geminiCandidate(parsed);
    onEvent?.(decoded);
    const output = responseParts(parts);
    if (output.thought) {
      yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: output.thought, ...(output.thoughtSignature ? { signature: output.thoughtSignature } : {}) } } as CanonicalEvent;
    }
    if (output.text) {
      yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
    }
    for (const call of output.calls) {
      if (!activeCalls.has(call.id)) {
        activeCalls.add(call.id);
        yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, name: call.name, arguments_delta: "" } as CanonicalEvent;
      }
      const argsText = JSON.stringify(call.args);
      if (argsText !== "{}") {
        yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, arguments_delta: argsText } as CanonicalEvent;
      }
      toolCalls++;
    }
    if (isRecord(decoded["usageMetadata"])) {
      rawUsage = decoded["usageMetadata"] as Record<string, unknown>;
    }
    if (typeof cand["finishReason"] === "string") {
      finishReason = cand["finishReason"] as string;
      lastCandidate = cand;
    }
  }
  return {
    usage: usageFromProvider(rawUsage ? mapGeminiUsage({ usageMetadata: rawUsage }) : undefined),
    candidate: lastCandidate,
    finishReason,
    toolCalls,
    nextSeq: seq,
  };
}

/**
 * The stream terminal both adapters emit with identical semantics: no
 * `finishReason` means the stream ended without a terminal chunk (truncated,
 * never complete), and an abort mid-body reports `aborted` only when the body
 * was otherwise complete.
 */
export function geminiStreamTerminal(
  summary: GeminiWireSummary,
  aborted: boolean,
): CanonicalEvent {
  const truncated = summary.finishReason === undefined;
  return {
    type: "terminal",
    sequence_number: summary.nextSeq,
    state: truncated ? "failed" : aborted ? "aborted" : "complete",
    stop_reason: toCanonicalStopReason(summary.candidate, summary.toolCalls),
    ...(summary.finishReason ? { provider_stop_reason: summary.finishReason } : {}),
    usage: summary.usage,
  } as CanonicalEvent;
}

/**
 * Query + `max_results` preamble shared by the two `websearch` implementations.
 */
export function parseWebsearchRequest(body: Record<string, unknown>): {
  readonly query: string;
  readonly maxResults: number;
} {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    throw new GatewayError("invalid_request", 400, "search query is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  const rawMax = body.max_results;
  const maxResults =
    typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.min(Math.max(1, Math.floor(rawMax)), 50)
      : 10;
  return { query, maxResults };
}

/**
 * Prompt + model preamble shared by the two `generateImage` implementations:
 * the candidate's model id wins over the body's, and an empty resolution is a
 * dispatch error.
 */
export function resolveImagePromptModel(
  body: Record<string, unknown>,
  candidate: ProviderDispatchTarget,
): { readonly prompt: string; readonly model: string } {
  const prompt = imagePrompt(body);
  const model = candidate.model_id.length > 0 ? candidate.model_id : typeof body.model === "string" ? body.model : "";
  if (model.length === 0) {
    throw new GatewayError("invalid_request", 400, "model is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
  }
  return { prompt, model };
}

/**
 * Reads grounding chunks into web-search results.
 *
 * Accepts either a full Gemini response body (the Gemini adapter passes the
 * whole `generateContent` payload) or the bare `groundingMetadata` record
 * (Antigravity passes what its `provider_stop_reason` carried). Snippets come
 * from `groundingSupports` segment text keyed by chunk index, falling back to
 * the chunk title — the Gemini adapter's richer reading, now shared.
 */
export function groundingResults(data: unknown, maxResults: number): readonly WebSearchResult[] {
  const metadata = groundingMetadataOf(data);
  if (metadata === undefined) return [];
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  const snippetsByUrl = new Map<string, Set<string>>();
  const supports = Array.isArray(metadata.groundingSupports) ? metadata.groundingSupports : [];
  for (const support of supports) {
    if (!isRecord(support) || !isRecord(support.segment)) continue;
    const text = typeof support.segment.text === "string" ? support.segment.text.trim() : "";
    if (!text || !Array.isArray(support.groundingChunkIndices)) continue;
    for (const rawIndex of support.groundingChunkIndices) {
      if (!Number.isInteger(rawIndex)) continue;
      const chunk = chunks[rawIndex];
      const web = isRecord(chunk) && isRecord(chunk.web) ? chunk.web : undefined;
      const url = web && (typeof web.uri === "string" ? web.uri : typeof web.url === "string" ? web.url : "");
      if (!url) continue;
      const snippets = snippetsByUrl.get(url) ?? new Set<string>();
      snippets.add(text);
      snippetsByUrl.set(url, snippets);
    }
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (!isRecord(chunk) || !isRecord(chunk.web)) continue;
    const web = chunk.web;
    const url = typeof web.uri === "string" ? web.uri : typeof web.url === "string" ? web.url : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof web.title === "string" ? web.title : "";
    const snippet = [...(snippetsByUrl.get(url) ?? [])].join(" ").trim() || title;
    results.push({ title, url, snippet, published_at: null, score: null });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Full response body → `candidates[0].groundingMetadata`; bare metadata passes through. */
function groundingMetadataOf(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  if (Array.isArray(data.groundingChunks) || Array.isArray(data.groundingSupports)) return data;
  const candidate = Array.isArray(data.candidates) && isRecord(data.candidates[0]) ? data.candidates[0] : undefined;
  const metadata = candidate && isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
  return metadata;
}
