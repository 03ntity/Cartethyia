// Factory-blocked (Phase C4): Gemini native generateContent RPC envelope
// (per-model `:generateContent`/`:streamGenerateContent` paths, `contents`/
// `candidates` shapes, `x-goog-api-key`) — non-OpenAI wire; stays bespoke.
import { GatewayError } from "../../protocol/gateway-error";
import { mapUpstreamHttpError } from "../../protocol/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../protocol/canonical-model";
import { readCredentialSecret, assertWireFamily, type ImageGenerationOutcome, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext, type WebSearchOutcome } from "../provider-contracts";
import type { ModelDefinition } from "../provider-model-definition";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { isRecord } from "../../protocol/codecs";
import { providerBaseUrl } from "../provider-metadata";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import { geminiModelUrl, buildGeminiPayload } from "../../protocol/request/gemini";
import { geminiInlineImages, imageCreatedSeconds } from "../../protocol/image-generation";
import { toCanonicalStopReason } from "../../protocol/response/gemini";
import {
  geminiNonStreamEvents,
  geminiStreamEvents,
  geminiStreamTerminal,
  groundingResults,
  parseWebsearchRequest,
  resolveImagePromptModel,
} from "./shared/gemini-wire";

// Gemini provider constants.

export const GEMINI_BASE_URL = providerBaseUrl("gemini");
export const GEMINI_PROVIDER_ID = "gemini" as const;
export const GEMINI_SEARCH_MODEL = "gemini-2.5-flash" as const;



import { defineModel } from "../provider-model-definition";

export const GEMINI_MODELS: readonly ModelDefinition[] = [
  ...[
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ].map((id) =>
    defineModel({
      id,
      endpoint: "/v1beta/models",
      ctx: 1_000_000,
      out: 32768,
      vision: true,
      reasoning: true,
    }),
  ),
  // Image-generation models answer `:generateContent` with `inlineData`, not
  // the chat text path.
  ...[
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
  ].map((id) =>
    defineModel({
      id,
      endpoint: "/v1beta/models",
      ctx: 1_000_000,
      out: 32_768,
      vision: true,
      serviceKind: "imageGeneration",
      output: ["image"],
      toolCall: false,
    }),
  ),
];

/**
 * Gemini's Google Search grounding rows, served by `POST /v1/search`.
 *
 * The chat catalog above already declares `gemini-2.5-flash` as an ordinary
 * `llm` row, and that is what `GEMINI_SEARCH_MODEL` falls back to — but a
 * `serviceKind: "llm"` row is not a search route, so `POST /v1/search` had no
 * resolvable target and the Search tab listed nothing for Gemini despite the
 * provider serving hosted grounding. These rows declare the same models on the
 * `websearch` service kind, which is the dimension the search route resolves
 * against. The chat rows stay: the same model serves both surfaces, and one
 * model id cannot carry two service kinds.
 *
 * `gemini-2.5-flash` is the documented default and the one the adapter falls
 * back to when a caller sends no model. `gemini-3-flash` is the newer generation
 * on the same grounding support.
 *
 * The endpoint differs from the chat row's `/v1beta/models` on purpose: the
 * unique key on a catalog row is `(provider, model, endpoint)`, so a search
 * row sharing the chat row's endpoint would upsert over it and lose the
 * service kind — the provider would keep one `llm` row and the Search tab
 * would list nothing. Grounding posts to the per-model `:generateContent`
 * path, which is the route it actually takes.
 */
export const GEMINI_SEARCH_MODELS: readonly ModelDefinition[] = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
].map((id) =>
  defineModel({
    id,
    providerId: GEMINI_PROVIDER_ID,
    serviceKind: "websearch",
    wireFamily: "chat",
    endpoint: `/v1beta/models/${id}:generateContent`,
    ctx: 1_000_000,
    out: 32_768,
    vision: true,
    reasoning: true,
    // Grounding is a hosted Google Search tool, not a function the gateway
    // declares on the caller's behalf, so the row exposes no tool calls.
    toolCall: false,
  }),
);

import type { DiscoveryInput } from "../discovery/discovery-types";

// SSE mapper
// (moved: shared Gemini-wire mapping lives in `./shared/gemini-wire`)

// Dispatch — manual, preserves x-goog-api-key header & v1beta baseUrl

export interface GeminiAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class GeminiAdapter implements ProviderAdapter {
  readonly provider_id = GEMINI_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GeminiAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat" && candidate.wire_family !== "responses" && candidate.wire_family !== "messages") {
      assertWireFamily(candidate, ["chat", "responses", "messages"], "gemini");
    }
    const apiKey = readCredentialSecret(context.credential, "Gemini API key is required");

    const model = candidate.model_id || request.model;
    const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = geminiModelUrl(this.baseUrl, model, action);

    const payload = buildGeminiPayload(
      request,
      ...(context.image_clamp_max_bytes === undefined
        ? []
        : [{ maxBytesOverride: context.image_clamp_max_bytes }]),
    );
    if (
      request.tools?.some(
        (tool) =>
          tool.name === "web_search" ||
          tool.name === "web_search_preview",
      )
    ) {
      const tools = Array.isArray(payload.tools)
        ? [...(payload.tools as Record<string, unknown>[])]
        : [];
      if (!tools.some((tool) => isRecord(tool) && isRecord(tool.google_search))) {
        tools.push({ google_search: {} });
      }
      payload.tools = tools;
    }
    const outboundFetch: typeof fetch =
      (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, "gemini");

      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();

      if (!request.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const summary = yield* geminiNonStreamEvents(json, request.model);
        yield {
          type: "terminal",
          sequence_number: summary.nextSeq,
          state: "complete",
          stop_reason: toCanonicalStopReason(summary.candidate, summary.toolCalls),
          provider_stop_reason: typeof summary.candidate["finishReason"] === "string" ? (summary.candidate["finishReason"] as string) : undefined,
          usage: summary.usage,
        } as CanonicalEvent;
        return;
      }

      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Gemini returned empty stream (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      const summary = yield* geminiStreamEvents(response.body as ReadableStream<Uint8Array>, request.model, {
        signal: lifecycle.signal,
        errorLabel: "Gemini stream error",
      });
      yield geminiStreamTerminal(summary, context.abort_signal.aborted);
    } catch (err: unknown) {
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
  async websearch(
    body: Record<string, unknown>,
    _candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<WebSearchOutcome> {
    const { query, maxResults } = parseWebsearchRequest(body);
    const apiKey = readCredentialSecret(context.credential, "Gemini API key is required");
    const requested = typeof body.model === "string" ? body.model.trim() : "";
    const model = requested.length > 0 && requested !== "gemini" ? requested : GEMINI_SEARCH_MODEL;
    const outboundFetch = context.outbound_fetch ?? this.fetchFn;
    let response: Response;
    try {
      response = await outboundFetch(geminiModelUrl(this.baseUrl, model, "generateContent"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: query }] }],
          tools: [{ google_search: {} }],
        }),
        signal: context.abort_signal,
      });
    } catch (error) {
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Gemini search unreachable (request {requestId}): ${error instanceof Error ? error.message : String(error)}. The connection ghosted us — come back in a moment 👻`,
      );
    }
    if (!response.ok) throw await mapUpstreamHttpError(response, "gemini search");
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GatewayError("platform_unavailable", 502, "Gemini search returned invalid JSON (request {requestId}). The upstream came back empty-handed — retry 🌙");
    }
    const results = groundingResults(data, maxResults);
    if (results.length === 0)
      throw new GatewayError("platform_unavailable", 502, "Gemini search returned no grounded results (request {requestId}). The upstream came back empty-handed — retry 🌙");
    return { results, total_results: results.length };
  }

  async generateImage(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<ImageGenerationOutcome> {
    const { prompt, model } = resolveImagePromptModel(body, candidate);
    const apiKey = readCredentialSecret(context.credential, "Gemini API key is required");
    const outboundFetch = context.outbound_fetch ?? this.fetchFn;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    let response: Response;
    try {
      // the reference client's Gemini image client asks for IMAGE only. TEXT+IMAGE lets
      // the model answer in prose and skip the inline image part.
      response = await outboundFetch(geminiModelUrl(this.baseUrl, model, "generateContent"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
        signal: lifecycle.signal,
      });
    } catch (error: unknown) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      if (abortError) throw abortError;
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Gemini image generation unreachable (request {requestId}): ${error instanceof Error ? error.message : String(error)}. The connection ghosted us — come back in a moment 👻`,
        {},
        "upstream",
      );
    } finally {
      lifecycle.release();
    }
    if (!response.ok) throw await mapUpstreamHttpError(response, "gemini");
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GatewayError("platform_unavailable", 502, "Gemini image generation returned invalid JSON (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
    }
    const images = geminiInlineImages(data);
    if (images.length === 0) {
      throw new GatewayError("platform_unavailable", 502, "Gemini image generation returned no image (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
    }
    return { created: imageCreatedSeconds(), data: images };
  }

}

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ProviderAdapter {
  return new GeminiAdapter(options);
}

export async function discoverGeminiModels(input: DiscoveryInput): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl("gemini"),
    headers: { "x-goog-api-key": input.credential },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
