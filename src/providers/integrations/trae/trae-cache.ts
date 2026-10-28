// Trae session-cache estimation.
//
// Trae's agent surface does not report prompt-cache hits: the upstream metadata
// carries `prompt_cache_pool_record: null` and every cache counter
// (`cache_read_input_tokens`, `cached_tokens`) stays 0 even for byte-identical
// prefixes. The underlying models do cache those prefixes, so for the same
// conversation we ESTIMATE the hit locally. This only fills the gap when
// upstream reports nothing (0 or unavailable); a genuine upstream report (>0)
// is trusted and left untouched.

import { createHash } from "node:crypto";
import type { CanonicalMessage, UsageRecord } from "../../../protocol/canonical-model";

/** Bounded in-memory tracker: one entry per session, oldest evicted first. */
const MAX_SESSIONS = 512;

interface TraeSessionCacheEntry {
  /** hash(full messages) -> reported input tokens for that exact list. */
  readonly seen: Map<string, number>;
  /** Insertion order for bounded eviction. */
  readonly order: string[];
}

const sessions = new Map<string, TraeSessionCacheEntry>();

function hashOf(messages: readonly CanonicalMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function sessionFor(sessionId: string): TraeSessionCacheEntry {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { seen: new Map(), order: [] };
    sessions.set(sessionId, entry);
  }
  return entry;
}

function remember(sessionId: string, fullHash: string, inputTokens: number): void {
  const entry = sessionFor(sessionId);
  if (!entry.seen.has(fullHash)) {
    entry.order.push(fullHash);
    if (entry.order.length > MAX_SESSIONS) {
      const oldest = entry.order.shift();
      if (oldest !== undefined) entry.seen.delete(oldest);
    }
  }
  entry.seen.set(fullHash, inputTokens);
  if (sessions.size > MAX_SESSIONS) {
    const oldestSession = sessions.keys().next().value;
    if (oldestSession !== undefined) sessions.delete(oldestSession);
  }
}

/**
 * Estimates how much of this request's input was served from cache.
 *
 * The longest prefix of `messages` that was ever sent as a complete request in
 * this session is considered cached, and its recorded token count is the
 * cached portion — if that prefix is the whole request, everything was cached.
 * This models how upstream prompt caching actually behaves (byte-identical
 * prefix reuse) without trusting a counter the upstream never reports.
 *
 * Returns the record unchanged when there is nothing to estimate (no session,
 * no history, or upstream already reported a real hit).
 */
export function estimateTraeSessionCache(
  record: UsageRecord,
  sessionId: string | undefined,
  messages: readonly CanonicalMessage[] | undefined,
): UsageRecord {
  if (!sessionId || !messages || messages.length === 0) return record;
  const upstreamReported =
    typeof record.cached_input_tokens === "number" && record.cached_input_tokens > 0;
  if (upstreamReported) return record;

  const fullHash = hashOf(messages);
  const entry = sessions.get(sessionId);

  if (entry) {
    // Longest prefix that matches a previously sent complete request.
    for (let len = messages.length; len >= 1; len -= 1) {
      const prefix = messages.slice(0, len);
      const tokens = entry.seen.get(hashOf(prefix));
      if (tokens === undefined) continue;
      if (len === messages.length) {
        // Byte-identical request: the whole input came from cache.
        return {
          ...record,
          cached_input_tokens: record.input_tokens,
          uncached_input_tokens: 0,
        };
      }
      const cached = Math.min(tokens, record.input_tokens);
      return {
        ...record,
        cached_input_tokens: cached,
        uncached_input_tokens: Math.max(0, record.input_tokens - cached),
      };
    }
  }

  remember(sessionId, fullHash, record.input_tokens);
  return record;
}

/** Drops all tracked sessions. Test-only. */
export function resetTraeSessionCacheForTesting(): void {
  sessions.clear();
}
