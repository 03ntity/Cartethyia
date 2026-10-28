/**
 * Gateway-executed "server tools" for the Buddy family, ported from the
 * reference gateway (`lib/server/proxy/server-tools/` in `codebuddy2api`).
 *
 * Some clients ask the *provider* to run a web tool by declaring a
 * provider-executed type: Anthropic sends `web_search_20250305` /
 * `web_fetch_20250910`, the Responses API sends `web_search_preview`.
 * Upstream CodeBuddy has none of these, so the gateway executes the call
 * against a backend and hands the findings back as if upstream had produced
 * them.
 *
 * The distinction is declaration-driven, never name-driven: a client's own
 * ordinary `function` named `WebSearch` (Claude Code) is resolved by the
 * client, and the gateway must not pick it up. Only calls whose *declared
 * type* carries the provider-executed prefix are server tools.
 *
 * This module is the pure engine: classification, invocation building,
 * execution against injected backends, and the transcript messages a follow-up
 * upstream call needs. The streaming loop that re-drives the upstream within
 * one request is the adapter-side consumer.
 */
import type { ToolDefinition } from "../../../protocol/canonical-model";

export type ServerToolKind = "web_search" | "web_fetch";

export interface ServerToolDeclaration {
  readonly kind: ServerToolKind;
  readonly name: string;
}

export interface ServerToolInvocation {
  readonly id: string;
  readonly kind: ServerToolKind;
  readonly rawArguments: string;
}

export interface ServerToolRunResult {
  /** Text handed back upstream as the tool's result message. */
  readonly content: string;
  readonly toolCallId: string;
}

export interface ServerToolExecutor {
  /** Runs one web fetch; `null` means the backend is unavailable. */
  readonly fetch?: ((input: { url: string }) => Promise<string>) | undefined;
  /** Runs one web search; `null` means the backend is unavailable. */
  readonly search?: ((input: { query: string }) => Promise<string>) | undefined;
}

/** The declared-type prefixes the provider-executed tools carry. */
const SEARCH_TYPE_PREFIX = "web_search_";
const FETCH_TYPE_PREFIX = "web_fetch_";

function normalizeTypeName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ");
}

function classifyByType(type: string): ServerToolKind | null {
  const normalized = normalizeTypeName(type);
  if (normalized.startsWith(normalizeTypeName(SEARCH_TYPE_PREFIX))) return "web_search";
  if (normalized.startsWith(normalizeTypeName(FETCH_TYPE_PREFIX))) return "web_fetch";
  return null;
}

/**
 * Classifies one canonical tool declaration, or returns `null` for a
 * client-owned tool. Only the declared type counts; the name is never
 * consulted, so a client function named `WebSearch` is never mistaken for the
 * server tool. `native_type` retains the raw Anthropic/OpenAI type spelling
 * (`web_search_20250305`, `web_fetch_20250910`) when the surface carries one;
 * otherwise the normalized `tool_type` decides.
 */
export function classifyServerToolDeclaration(tool: ToolDefinition): ServerToolKind | null {
  const raw = tool.native_type?.trim();
  if (raw !== undefined && raw.length > 0) {
    const byRaw = classifyByType(raw);
    if (byRaw !== null) return byRaw;
  }
  if (tool.tool_type === "web_search") return "web_search";
  if (tool.tool_type !== undefined && tool.tool_type !== "function") {
    const byType = classifyByType(tool.tool_type);
    if (byType !== null) return byType;
  }
  return null;
}

/** Indexes declared server tools by the name a call would carry. */
export function findServerToolDeclarations(
  tools: readonly ToolDefinition[] | undefined,
): Map<string, ServerToolKind> {
  const out = new Map<string, ServerToolKind>();
  for (const tool of tools ?? []) {
    const kind = classifyServerToolDeclaration(tool);
    if (kind !== null) out.set(tool.name, kind);
  }
  return out;
}

/** True when a call's name matches a declared server tool. */
export function isServerToolCall(
  name: string,
  declared: ReadonlyMap<string, ServerToolKind>,
): boolean {
  return declared.has(name);
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Builds one invocation from a tool call, kind already classified. */
export function buildServerToolInvocation(
  callId: string,
  name: string,
  kind: ServerToolKind,
  rawArguments: string,
): ServerToolInvocation {
  return { id: callId || `server_tool_${name}`, kind, rawArguments };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeFetchUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.toString();
}

/**
 * Runs one invocation against the injected backend. Failures become text
 * rather than exceptions: the arguments came from the model, so the useful
 * outcome is for it to see what went wrong and retry or answer without the
 * findings — not for the whole turn to fail.
 */
async function runOne(
  executor: ServerToolExecutor,
  invocation: ServerToolInvocation,
): Promise<ServerToolRunResult> {
  const args = parseJsonArguments(invocation.rawArguments);
  if (invocation.kind === "web_fetch") {
    const url = safeFetchUrl(textOf(args["url"] ?? args["target"]));
    if (url === null) {
      return {
        toolCallId: invocation.id,
        content: "web_fetch failed: the model supplied an invalid or unsupported URL and nothing was fetched.",
      };
    }
    if (executor.fetch === undefined) {
      return {
        toolCallId: invocation.id,
        content: "web_fetch unavailable: the gateway has no fetch backend configured.",
      };
    }
    try {
      const content = await executor.fetch({ url });
      return { toolCallId: invocation.id, content };
    } catch (error) {
      return {
        toolCallId: invocation.id,
        content: `web_fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const query = textOf(args["query"]);
  if (query.length === 0) {
    return {
      toolCallId: invocation.id,
      content: "web_search failed: the model supplied an empty query and nothing was searched.",
    };
  }
  if (executor.search === undefined) {
    return {
      toolCallId: invocation.id,
      content: "web_search unavailable: the gateway has no search backend configured.",
    };
  }
  try {
    const content = await executor.search({ query });
    return { toolCallId: invocation.id, content };
  } catch (error) {
    return {
      toolCallId: invocation.id,
      content: `web_search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Runs every invocation and returns one tool message per call. */
export async function executeServerToolInvocations(
  executor: ServerToolExecutor,
  invocations: readonly ServerToolInvocation[],
): Promise<readonly ServerToolRunResult[]> {
  return Promise.all(invocations.map((invocation) => runOne(executor, invocation)));
}

/**
 * Builds the transcript messages a follow-up upstream call needs: the
 * assistant turn carrying the calls, then one `tool` result per call. Matches
 * the OpenAI-shaped transcript the buddy upstream expects.
 */
export function buildServerToolFollowUpMessages(
  assistantToolCalls: Array<{ id: string; name: string; arguments: string }>,
  results: readonly ServerToolRunResult[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (assistantToolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: assistantToolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
  }
  for (const result of results) {
    messages.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      content: result.content,
    });
  }
  return messages;
}
