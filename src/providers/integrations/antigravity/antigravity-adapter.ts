/**
 * Antigravity adapter: the ProviderAdapter implementation and its factory.
 *
 * Split out of `antigravity.ts`, which re-exports this module's public surface
 * (`AntigravityAdapterOptions` is internal; `AntigravityAdapter`,
 * `createAntigravityAdapter`, `antigravityAdapter` are exported) so no
 * importer changes.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { firstUserText } from "../../../protocol/canonical-model";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import { geminiInlineImages, imageAspectRatio, imageCreatedSeconds } from "../../../protocol/image-generation";
import { mapUpstreamHttpError } from "../../../protocol/failure-policy";
import { isRecord } from "../../../protocol/codecs";
import { createHash, randomUUID } from "node:crypto";
import { toCanonicalStopReason } from "../../../protocol/response/gemini";
import {
  geminiNonStreamEvents,
  geminiStreamEvents,
  geminiStreamTerminal,
  groundingResults,
  parseWebsearchRequest,
  resolveImagePromptModel,
} from "../shared/gemini-wire";
import {
  antigravityWireModelId,
  getAntigravityUserAgent,
  loadAntigravityProject,
} from "./antigravity-protocol";
import { assertCredentialKind, assertWireFamily } from "../../provider-contracts";
import type { ImageGenerationOutcome, ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext, WebSearchOutcome } from "../../provider-contracts";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { log } from "../../../observability/logger";
import {
  fetchWithEmptyStreamRecovery,
  isEmptyStream,
} from "../../../transport/dispatch/empty-stream";
import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_PROVIDER_ID,
  GENERATE_PATH,
  STREAM_GENERATE_PATH,
} from "./antigravity-models";
import {
  AntigravitySessionStore,
  sessionIdentityDigest,
  sessionStateKey,
} from "./antigravity-session";
import { buildAntigravityEnvelope } from "./antigravity-envelope";
import {
  failoverAntigravityUrl,
  isFailoverStatus,
  peekAntigravityTally,
} from "./antigravity-transport";

interface AntigravityAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  /** Maximum session states when the host needs explicit limits. */
  readonly sessionStateMaxEntries?: number;
  /** Idle session lifetime in milliseconds. */
  readonly sessionStateIdleTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

class AntigravityAdapter implements ProviderAdapter {
  readonly provider_id = ANTIGRAVITY_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly sessionStates: AntigravitySessionStore;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? ANTIGRAVITY_BASE_URL).replace(/\/+$/, "");
    this.sessionStates = new AntigravitySessionStore({
      ...(options.sessionStateMaxEntries === undefined ? {} : { maxEntries: options.sessionStateMaxEntries }),
      ...(options.sessionStateIdleTtlMs === undefined ? {} : { idleTtlMs: options.sessionStateIdleTtlMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Number of live conversation states (diagnostics/tests). */
  sessionStateSize(): number {
    return this.sessionStates.size;
  }

  /** Resets one conversation/model state, or all model states for a conversation. */
  resetSession(routeIdentity: string, wireModelId?: string): number {
    if (wireModelId !== undefined)
      return this.sessionStates.resetByPrefix(sessionStateKey(routeIdentity, wireModelId));
    return this.sessionStates.resetByPrefix(`${sessionIdentityDigest(routeIdentity)}:`);
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (
      candidate.wire_family !== "chat" &&
      candidate.wire_family !== "responses" &&
      candidate.wire_family !== "messages"
    ) {
      assertWireFamily(candidate, ["chat", "responses", "messages"], "antigravity");
    }
    if (context.credential.credential_kind !== "oauth") {
      assertCredentialKind(context.credential, "oauth", "antigravity");
    }
    const accessToken = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret).trim()
      : "";
    if (!accessToken) {
      throw new GatewayError(
        "authentication_failed",
        401,
        "antigravity: OAuth access token is required (request {requestId}). Wrong key, right door — check the credential 🔑",
      );
    }

    const model = candidate.model_id || request.model;
    const wireModelId = antigravityWireModelId(model);
    const url = `${this.baseUrl}${request.stream ? STREAM_GENERATE_PATH : GENERATE_PATH}`;

    // Conversation stickiness: one state per (conversation, model); other
    // models under the same conversation reset so parallel stale states
    // never shadow the live one. The anonymous fallback is scoped per
    // credential (never one static bucket shared by all anonymous traffic).
    const accountId = context.credential.account_id;
    const credentialScope =
      accountId ??
      (context.credential.secret
        ? `cred:${createHash("sha256").update(context.credential.secret).digest("hex").slice(0, 16)}`
        : "anon");
    const routeIdentity =
      request.conversation?.conversation_id ??
      request.conversation_id ??
      `account:${credentialScope}`;
    const stateKey = sessionStateKey(routeIdentity, wireModelId);
    const sessionState = this.sessionStates.getOrCreate(stateKey);
    // Reset sibling-model states under the same conversation so parallel
    // stale states never shadow the live one; the live key is kept.
    this.sessionStates.resetByPrefix(`${sessionIdentityDigest(routeIdentity)}:`, stateKey);

    // Every outbound call goes through the context's fetch: a probe injects one
    // that strips `User-Agent`, so the control-plane lookups below never
    // announce a desktop client the probe is not, while real dispatch keeps the
    // Antigravity identity the backend gates on.
    const outboundFetch: typeof fetch =
      (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    // Best-effort project-id: CloudCode accepts requests without one for
    // free-tier accounts; enterprise/subscribed accounts need it. Cached
    // per access-token hash, so this is a single background call at first
    // use per token.
    const projectId = await loadAntigravityProject(accessToken, {
      baseUrl: this.baseUrl,
      fetcher: outboundFetch,
      signal: context.abort_signal,
    });

    const payload = buildAntigravityEnvelope(
      request,
      projectId,
      wireModelId,
      model,
      sessionState,
      firstUserText(request),
    );

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": getAntigravityUserAgent(),
      };
      const attempt = (target: string): Promise<Response> =>
        outboundFetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: lifecycle.signal,
        });
      let response = await attempt(url);
      if (!response.ok && isFailoverStatus(response.status)) {
        // Production→sandbox auto-failover (captured client behavior): one
        // bounded retry on a fresh host for throttled/server-side failures.
        // Auth and client errors never fail over.
        const sandboxUrl = failoverAntigravityUrl(url, this.baseUrl);
        if (sandboxUrl !== undefined) {
          response = await attempt(sandboxUrl);
        }
      }
      if (!response.ok) throw await mapUpstreamHttpError(response, "antigravity");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body.
      lifecycle.release();

      if (!request.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const summary = yield* geminiNonStreamEvents(json, request.model, {
          onEvent: (decoded) => {
            if (typeof decoded["responseId"] === "string") {
              sessionState.lastExecutionId = decoded["responseId"] as string;
            }
          },
        });
        const finishReason = summary.finishReason;
        const providerStopReason = isRecord(summary.candidate["groundingMetadata"])
          ? `grounding:${JSON.stringify(summary.candidate["groundingMetadata"])}`
          : finishReason;
        yield {
          type: "terminal",
          sequence_number: summary.nextSeq,
          // No finishReason on a full body means the upstream response was
          // truncated: never complete.
          state: finishReason === undefined ? "failed" : "complete",
          stop_reason: toCanonicalStopReason(summary.candidate, summary.toolCalls),
          ...(providerStopReason ? { provider_stop_reason: providerStopReason } : {}),
          usage: summary.usage,
        } as CanonicalEvent;
        return;
      }

      if (!response.body) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "antigravity returned empty stream (request {requestId}). The upstream came back empty-handed — retry 🌙",
          {},
          "upstream",
        );
      }
      // Empty-stream recovery: a 200 whose first burst carries nothing is a
      // routable request the backend answered with silence. Peek on a *clone*
      // (the original reader stays untouched and fully readable) and stop at
      // the first meaningful event, so a healthy stream costs one bounded read
      // of its opening burst and no extra request. Only a silent first burst
      // triggers the byte-identical replay across prod → sandbox.
      {
        const firstBurst = await peekAntigravityTally(response.clone(), lifecycle.signal);
        if (isEmptyStream(firstBurst)) {
          const frozenBody = JSON.stringify(payload);
          const sandbox = failoverAntigravityUrl(url, this.baseUrl);
          const recovery = await fetchWithEmptyStreamRecovery(
            sandbox === undefined ? [url] : [url, sandbox],
            { headers, body: frozenBody },
            {
              fetch: (target, init) =>
                outboundFetch(target, {
                  method: "POST",
                  headers: init.headers,
                  body: init.body,
                  signal: init.signal,
                }),
              drain: (res, signal) => peekAntigravityTally(res.clone(), signal),
              signal: lifecycle.signal,
              deadlineMs: context.deadline,
            },
          );
          log.warn("antigravity: empty stream, replayed", {
            endpoint: recovery.endpoint,
            replays: recovery.replaysUsed,
          });
          response = recovery.response;
        }
      }
      const summary = yield* geminiStreamEvents(response.body as ReadableStream<Uint8Array>, request.model, {
        signal: lifecycle.signal,
        errorLabel: "antigravity stream error",
        stopAtDoneMarker: true,
        onEvent: (decoded) => {
          if (typeof decoded["responseId"] === "string") {
            sessionState.lastExecutionId = decoded["responseId"] as string;
          }
        },
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
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<WebSearchOutcome> {
    const { query, maxResults } = parseWebsearchRequest(body);
    const requested = typeof body.model === "string" ? body.model.trim() : "";
    const model = requested.length > 0 && requested !== "antigravity" ? requested : "gemini-2.5-flash";
    const request: CanonicalRequest = {
      model,
      messages: [{ role: "user", content: [{ kind: "text", text: query }] }],
      tools: [{ name: "web_search", tool_type: "web_search", jsonSchema: {} }],
      generation_controls: {},
      stream: false,
      source_surface: "chat",
    };
    let grounded: unknown;
    for await (const event of this.dispatch(request, { ...candidate, model_id: model }, context)) {
      const reason = event.type === "terminal" ? event.provider_stop_reason : undefined;
      if (reason?.startsWith("grounding:")) grounded = JSON.parse(reason.slice("grounding:".length));
    }
    const results = groundingResults(grounded, maxResults);
    if (results.length === 0)
      throw new GatewayError("platform_unavailable", 502, "Antigravity search returned no grounded results (request {requestId}). The upstream came back empty-handed — retry 🌙");
    return { results, total_results: results.length };
  }

  async generateImage(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<ImageGenerationOutcome> {
    if (context.credential.credential_kind !== "oauth") {
      assertCredentialKind(context.credential, "oauth", "antigravity");
    }
    const accessToken = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret).trim()
      : "";
    if (!accessToken) {
      throw new GatewayError("authentication_failed", 401, "antigravity: OAuth access token is required (request {requestId}). Wrong key, right door — check the credential 🔑");
    }
    const { prompt, model } = resolveImagePromptModel(body, candidate);
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const projectId = await loadAntigravityProject(accessToken, {
      baseUrl: this.baseUrl,
      fetcher: outboundFetch,
      signal: context.abort_signal,
    });
    const aspectRatio = imageAspectRatio(body.size);
    const count = typeof body.n === "number" && Number.isFinite(body.n) ? Math.max(1, Math.floor(body.n)) : 1;
    // the reference client's Antigravity image client streams the agent envelope and asks
    // for IMAGE only. The chat envelope (tools, thinking, identity turn) makes
    // Cloud Code answer as an agent instead of returning inline image bytes.
    const payload: Record<string, unknown> = {
      model: antigravityWireModelId(model),
      request: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [
            {
              text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.",
            },
          ],
        },
        generationConfig: {
          responseModalities: ["IMAGE"],
          candidateCount: count,
          ...(aspectRatio === undefined ? {} : { imageConfig: { aspectRatio } }),
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
        ],
      },
      requestType: "agent",
      requestId: `agent-${Date.now()}-${randomUUID().slice(0, 9)}`,
      userAgent: "antigravity",
      ...(projectId === undefined ? {} : { project: projectId }),
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "user-agent": getAntigravityUserAgent(),
    };
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const url = `${this.baseUrl}${STREAM_GENERATE_PATH}`;
    let response: Response;
    try {
      const attempt = (target: string): Promise<Response> =>
        outboundFetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: lifecycle.signal,
        });
      response = await attempt(url);
      if (!response.ok && isFailoverStatus(response.status)) {
        const sandboxUrl = failoverAntigravityUrl(url, this.baseUrl);
        if (sandboxUrl !== undefined) response = await attempt(sandboxUrl);
      }
    } catch (error: unknown) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      if (abortError) throw abortError;
      throw new GatewayError(
        "platform_unavailable",
        502,
        `Antigravity image generation unreachable (request {requestId}): ${error instanceof Error ? error.message : String(error)}. The connection ghosted us — come back in a moment 👻`,
        {},
        "upstream",
      );
    }
    if (!response.ok) {
      lifecycle.release();
      throw await mapUpstreamHttpError(response, "antigravity");
    }
    lifecycle.release();
    const images: Record<string, unknown>[] = [];
    // One generated image is already several megabytes of base64, so the
    // shared 4 MiB SSE cap would reject a successful generation.
    for await (const event of decodeSseEvents(response.body, {
      signal: context.abort_signal,
      maxEventBytes: 32 * 1024 * 1024,
    })) {
      if (event.data.trim().length === 0 || event.data.trim() === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new GatewayError("platform_unavailable", 502, "Antigravity image stream returned malformed JSON (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      }
      images.push(...geminiInlineImages(parsed));
    }
    if (images.length === 0) {
      throw new GatewayError("platform_unavailable", 502, "Antigravity image generation returned no image (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
    }
    return { created: imageCreatedSeconds(), data: images };
  }
}

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {},
): ProviderAdapter {
  return new AntigravityAdapter(options);
}

export const antigravityAdapter: ProviderAdapter = createAntigravityAdapter();

export { AntigravityAdapter };
