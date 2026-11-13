// Cursor provider-continuation affinity: resolve a request's pending tool
// results to the one account that owns them, so a continuation is planned
// against the same live Run instead of starting a fresh upstream turn.
import { GatewayError } from "../../protocol/gateway-error";
import type { CanonicalRequest } from "../../protocol/canonical-model";
import { toolResultParts } from "../../protocol/canonical-model";
import type { ResolvedApiKey } from "../../security/api-key-auth";
import type { RouteContinuationAffinity } from "../routing/route-model";
import { cursorRunSessions } from "../../providers/integrations/cursor/cursor-session-manager";

/** Prefix of a provider-continuation tool-call id the gateway itself minted. */
const CURSOR_CALL_PREFIX = "call_cursor_";

/**
 * The provider-continuation tool results this request carries.
 *
 * Only ids the gateway minted (`call_cursor_<run-id>_<exec-id>`) are considered.
 * Any other id belongs to a conversation the client owns; it is not a
 * continuation and must not influence routing.
 */
function continuationCallIds(request: CanonicalRequest): readonly string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "tool" && message.role !== "user") continue;
    for (const part of toolResultParts(message)) {
      if (!part.call_id.startsWith(CURSOR_CALL_PREFIX)) continue;
      if (!ids.includes(part.call_id)) ids.push(part.call_id);
    }
  }
  return ids;
}

/**
 * Resolves a request's pending tool results to the one account that owns them.
 *
 * Every pending id must resolve to the *same* live Run and the same account.
 * Ids resolving to different Runs, or to no live Run at all, are refused rather
 * than partially applied: one result cannot be delivered to another account's
 * upstream turn, and a request that cannot be satisfied as a whole must not be
 * dispatched at all.
 *
 * Returns `undefined` when the request carries no continuation ids — the
 * ordinary routing path.
 */
function resolveContinuationAffinity(
  request: CanonicalRequest,
  authorization: ResolvedApiKey,
): RouteContinuationAffinity | undefined {
  const ids = continuationCallIds(request);
  if (ids.length === 0) return undefined;
  const scope = {
    tenantId: authorization.tenantId,
    apiKeyId: authorization.id,
  };
  let affinity: RouteContinuationAffinity | undefined;
  let anyResolved = false;
  let allResolved = true;
  for (const callId of ids) {
    // The registry resolves by tenant + API key + provider + account, so a call
    // id replayed from another key or tenant resolves nothing.
    const record = lookupPendingCall(callId, scope);
    if (record === undefined) {
      // A replayed conversation carries every earlier tool result, and results
      // previous legs already answered resolve nothing here — they are history,
      // not the flight being continued. The request is a continuation only
      // through the ids that still resolve; when none do, the ordinary routing
      // path decides (a Cursor adapter may rebase the full history into a
      // fresh Run).
      allResolved = false;
      continue;
    }
    if (affinity !== undefined && affinity.providerAccountId !== record.providerAccountId) {
      throw new GatewayError(
        "invalid_request",
        400,
        "These tool results belong to different Cursor accounts (request {requestId}); resend them one account at a time. The session went cold — reconnect or resend 🔌",
        { callIds: [...ids] },
      );
    }
    anyResolved = true;
    affinity = {
      providerId: record.providerId,
      providerAccountId: record.providerAccountId,
      rebaseable: false,
    };
  }
  if (affinity !== undefined) {
    // Rebaseable when every supplied call id resolved to a live pending call
    // (so none is owed to another account) — or when none resolved and the
    // whole history is present. In both cases the conversation is complete and
    // may travel as history to a fresh Run.
    return { ...affinity, rebaseable: anyResolved ? allResolved : true };
  }
  return undefined;
}

/**
 * True when every continuation call id this request carries is answered by a
 * matching `toolCall` block in the same conversation — i.e. the request is a
 * complete replay, not a tail continuation still owed to a live Run.
 */
function isCompleteContinuationReplay(request: CanonicalRequest, ids: readonly string[]): boolean {
  const calledIds = new Set<string>();
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall") calledIds.add(part.call_id);
    }
  }
  return ids.every((id) => calledIds.has(id));
}

/**
 * Resolves a request's pending tool results to the one account that owns them,
 * with rebaseability computed from the conversation shape.
 *
 * A hard pin is only safe when the request is still owed to a live Run. But an
 * account that has since become unroutable (quota exhausted, cooling) must not
 * turn a complete replay into a hard 400: the whole recorded conversation is
 * present, so the router may fall through to normal routing and the Cursor
 * adapter rebases it into a fresh Run on whichever account serves the model.
 * That is what makes switching provider/model mid-conversation work.
 */
export function resolveContinuationAffinityWithRebase(
  request: CanonicalRequest,
  authorization: ResolvedApiKey,
): RouteContinuationAffinity | undefined {
  const affinity = resolveContinuationAffinity(request, authorization);
  if (affinity === undefined) return undefined;
  const ids = continuationCallIds(request);
  if (affinity.rebaseable) return affinity;
  return {
    ...affinity,
    rebaseable: isCompleteContinuationReplay(request, ids),
  };
}

/** Looks up one pending call across every provider that records continuations. */
function lookupPendingCall(
  callId: string,
  scope: { readonly tenantId: string; readonly apiKeyId: string },
): { readonly providerId: string; readonly providerAccountId: string } | undefined {
  const record = cursorRunSessions.describePendingCall(callId, scope);
  return record === undefined
    ? undefined
    : { providerId: record.providerId, providerAccountId: record.providerAccountId };
}
