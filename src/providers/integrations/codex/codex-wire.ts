/**
 * Codex wire-level helpers shared by the adapter's dispatch paths.
 *
 * Owns the pieces of the Codex HTTP contract that need no adapter state:
 * bearer-auth header construction, first-frame SSE sniffing, and web-search
 * citation normalization. Split out of `codex.ts` so the adapter file stays
 * focused on the adapter lifecycle.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import type { ResolvedCredential, WebSearchResult } from "../../provider-contracts";

export const CODEX_SEARCH_DEFAULT_MODEL = "gpt-5.6-luna";

export function normalizeCodexSearchCitations(
  citations: readonly unknown[],
  answerText: string,
): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const snippet = answerText.trim().slice(0, 400);
  for (const raw of citations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const nested = record.url_citation;
    const source =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : record;
    const url = typeof source.url === "string" ? source.url : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: typeof source.title === "string" ? source.title : "",
      url,
      snippet,
      published_at: null,
      score: null,
    });
  }
  return results;
}

export function authHeadersForCodex(
  credential: ResolvedCredential,
): Record<string, string> {
  if (!credential.secret || credential.secret.length === 0) {
    throw new GatewayError(
      "invalid_request",
      400,
      "codex: OAuth credential is missing a bearer token (request {requestId}). Wrong key, right door — check the credential 🔑",
    );
  }
  const token = new TextDecoder().decode(credential.secret);
  return { authorization: `Bearer ${token}` };
}

/** Reads just enough of an untyped body to tell SSE from JSON, then replays it. */
export async function sniffSseBody(body: ReadableStream<Uint8Array> | null): Promise<{
  readonly sse: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
}> {
  if (body === null) return { sse: false, body };
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done || first.value.byteLength === 0) return { sse: false, body: null };
  const head = new TextDecoder().decode(first.value.subarray(0, 32)).trimStart();
  const sse = head.startsWith("event:") || head.startsWith("data:") || head.startsWith(":");
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { sse, body: replay };
}
