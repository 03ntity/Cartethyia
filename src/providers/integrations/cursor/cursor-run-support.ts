// Run-lifecycle helpers shared by the Cursor adapter's dispatch legs:
// usage accounting, MCP call decoding, tool-result replay detection,
// continuation scoping, and the structured terminal failure shape.
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalRequest, UsageRecord } from "../../../protocol/canonical-model";
import type { ProviderContinuationScope, ProviderDispatchContext } from "../../provider-contracts";
import type { CursorContinuationScope } from "./cursor-session-manager";
import { CURSOR_PROVIDER_ID } from "./cursor-shared";
import { CURSOR_MCP_NAMESPACE as MCP_NAMESPACE, type CursorToolDescriptor } from "./cursor-request";
import { decodeStructEntriesToJson } from "./protocol/struct";
import {
  classifyCursorFailure,
  cursorQuietError,
} from "./cursor-hardening";
import type { CursorRunFrameState } from "./cursor-run-frames";
import { resultImages, type ResultImage } from "./cursor-images";

// Bounded open retries for connection/deadline failures (donor policy).
export const CURSOR_MAX_OPEN_RETRIES = 5;

export function usageFromTurnEnded(turnEnded: Record<string, unknown>): UsageRecord {
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const input = count(turnEnded["input_tokens"]);
  const output = count(turnEnded["output_tokens"]);
  const cacheRead = count(turnEnded["cache_read"]);
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_tokens: count(turnEnded["cache_write"]),
    uncached_input_tokens: Math.max(0, input - cacheRead),
    output_tokens: output,
    reasoning_tokens: count(turnEnded["reasoning_tokens"]),
    estimated_cost: null,
    total_tokens: input + output,
  };
}

export function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads one inbound `mcp_args` request.
 *
 * Returns `undefined` for anything that is not an executable call. Cursor's own
 * host tools arrive under their own server identifiers (or none at all) and are
 * never executed here — refusing them is what keeps a model's request from
 * turning into a shell command on the gateway's host.
 */
export function readExecutableMcpCall(
  mcpArgs: Record<string, unknown>,
  descriptors: readonly CursorToolDescriptor[],
): { toolName: string; arguments: string } | undefined {
  if (nonEmptyStringOf(mcpArgs["provider_identifier"]) !== MCP_NAMESPACE) return undefined;
  const toolName = nonEmptyStringOf(mcpArgs["tool_name"]);
  if (toolName === undefined) return undefined;
  if (!descriptors.some((descriptor) => descriptor.toolName === toolName)) return undefined;
  return { toolName, arguments: decodeMcpArguments(mcpArgs) };
}

/**
 * Decodes Cursor's `McpArgs.args` — a `map<string, google.protobuf.Value>`
 * carried as repeated map-entry messages — into a canonical arguments string.
 */
export function decodeMcpArguments(mcpArgs: Record<string, unknown>): string {
  const entries = mcpArgs["args"];
  const raw = Array.isArray(entries)
    ? entries.filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
    : [];
  if (raw.length === 0) return "{}";
  try {
    return JSON.stringify(decodeStructEntriesToJson(raw));
  } catch {
    return "{}";
  }
}

/** One tool result the client sent back for a call this process is holding. */
export interface PendingToolResult {
  readonly callId: string;
  readonly text: string;
  readonly isError: boolean;
  readonly images: readonly ResultImage[];
}

/**
 * Reads the tool results this request wants delivered to a held Run.
 *
 * Only ids in the `call_cursor_<run-id>_<exec-id>` shape are considered: any
 * other id is the client's own, belongs to a different provider's conversation,
 * and must not be sent to Cursor.
 */
export function readPendingToolResult(
  request: CanonicalRequest,
  _context: ProviderDispatchContext,
): PendingToolResult[] | undefined {
  const results: PendingToolResult[] = [];
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "toolResult") continue;
      if (!part.call_id.startsWith("call_cursor_")) continue;
      const text =
        typeof part.content === "string"
          ? part.content
          : part.content.map((child) => (child.kind === "text" ? child.text : "")).join("\n");
      results.push({
        callId: part.call_id,
        text,
        isError: part.is_error === true,
        images: resultImages(part),
      });
    }
  }
  return results.length > 0 ? results : undefined;
}

/** Every `toolCall` call id the conversation carries, in one scan. */
export function toolCallIds(request: CanonicalRequest): Set<string> {
  const calledIds = new Set<string>();
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall") calledIds.add(part.call_id);
    }
  }
  return calledIds;
}

/**
 * Marks a request as a complete conversation replay rather than a tail
 * continuation: every `call_cursor_*` tool result it carries is answered by a
 * `toolCall` block in the same conversation. That is the shape a client gets
 * when it resends its recorded transcript — a gateway restart between legs or
 * an evicted Run — and the only shape safe to rebase into a fresh Run, where
 * the recorded exchange travels as history.
 *
 * The matching `toolCall` may live anywhere in the conversation, not only in
 * the trailing assistant turn: Claude Code resends the full transcript, which
 * contains several earlier `call_cursor_*` rounds. A scan that accepted only
 * one trailing assistant/tool pair refused those complete replays with
 * "no longer pending" even though every result was paired and none was live
 * (mirrors `isCompleteContinuationReplay` in the preparer).
 */
export function isCompleteToolHistoryReplay(
  calledIds: ReadonlySet<string>,
  pending: readonly PendingToolResult[],
): boolean {
  return pending.every((item) => calledIds.has(item.callId));
}

/** The `call_cursor_*` result ids with no matching `toolCall` in the conversation. */
export function missingToolCallIds(
  calledIds: ReadonlySet<string>,
  pending: readonly PendingToolResult[],
): string[] {
  return pending.filter((item) => !calledIds.has(item.callId)).map((item) => item.callId);
}

/** Attaches the donor's structured failure shape to a terminal GatewayError. */
export function structuredCursorFailure(
  failure: GatewayError,
  classification: ReturnType<typeof classifyCursorFailure>,
  state: CursorRunFrameState | undefined,
  runId: string,
): GatewayError {
  const checkpoint = state?.checkpoint;
  const quiet = classification.kind === "quiet" ? cursorQuietError(checkpoint) : undefined;
  const detail = quiet?.message ?? failure.message;
  return new GatewayError(
    failure.code,
    failure.status,
    `Cursor ${classification.kind}: ${detail} (attempt ${(state?.attempt ?? 0) + 1}/${CURSOR_MAX_OPEN_RETRIES + 1}, ` +
      `transport ${state?.transport ?? "unknown"}, checkpoint ${checkpoint?.index ?? 0}, run ${runId})`,
    {
      ...failure.details,
      providerId: CURSOR_PROVIDER_ID,
      cursorFailureKind: classification.kind,
      retryable: classification.retryable,
      checkpointIndex: checkpoint?.index ?? 0,
      checkpointStreak: checkpoint?.streak ?? 0,
    },
    failure.origin,
  );
}

/**
 * The continuation scope of one dispatch.
 *
 * Derived from the route's own account identity plus the caller's tenant and API
 * key. A route with no account cannot scope a continuation, and a Run that
 * cannot be scoped must not be held open across requests at all.
 */
export function sessionScope(context: ProviderDispatchContext): CursorContinuationScope {
  const scope: ProviderContinuationScope | undefined = context.continuation_scope;
  return {
    tenantId: scope?.tenantId ?? "",
    apiKeyId: scope?.apiKeyId ?? "",
    providerId: CURSOR_PROVIDER_ID,
    providerAccountId: scope?.providerAccountId ?? context.credential.account_id ?? "",
  };
}

