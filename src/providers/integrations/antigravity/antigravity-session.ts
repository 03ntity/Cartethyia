/**
 * Antigravity conversation session state: sticky per-(conversation, model)
 * upstream sessions and the bounded in-process store that keeps them.
 *
 * Split out of `antigravity.ts`, which re-exports this module's public surface
 * (`AntigravitySessionState`, `AntigravitySessionStore`) so no importer
 * changes. `sessionIdentityDigest`, `signedAntigravitySessionId`, and
 * `sessionStateKey` are internal helpers the adapter and envelope builder
 * import but are not part of the facade surface.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Per-conversation upstream session. Created once per (conversation, model)
 * and sticky across turns so every turn looks like the same client instead
 * of a brand-new one: stable agent/trajectory/session ids, an incrementing
 * step index, and the previous turn's execution id echoed back.
 */
export interface AntigravitySessionState {
  agentId?: string;
  trajectoryId?: string;
  sessionId?: string;
  stepIndex?: number;
  lastExecutionId?: string;
}

/** Maximum in-memory conversation sessions retained by the adapter. */
const MAX_SESSION_STATES = 256;
const DEFAULT_SESSION_STATE_IDLE_TTL_MS = 30 * 60_000;

export function sessionIdentityDigest(value: string): string {
  let hash = 1469598103934665603n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Bounded in-process conversation store keyed by route identity. Idle
 * entries expire, recency refreshes on access, and the oldest entry is
 * evicted at the cap so a fan-out over conversations cannot pin memory.
 * A dedicated class (rather than the shared TTL cache) because session
 * stickiness needs touch-on-read idle semantics plus prefix-scoped reset.
 */
export class AntigravitySessionStore {
  private readonly entries = new Map<string, { state: AntigravitySessionState; at: number }>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; idleTtlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_SESSION_STATES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_STATE_IDLE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Number of live entries. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Returns the live state for key, creating it when absent or expired. */
  getOrCreate(key: string): AntigravitySessionState {
    this.evictExpired();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.at = this.now();
      return existing.state;
    }
    const state: AntigravitySessionState = {};
    this.entries.set(key, { state, at: this.now() });
    this.evictOverCap();
    return state;
  }

  /** Deletes every entry whose key starts with prefix (except `keep`); returns the count. */
  resetByPrefix(prefix: string, keep?: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && key !== keep) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.idleTtlMs) this.entries.delete(key);
    }
  }

  private evictOverCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Negative signed session id, matching the captured client shape:
 * `"-" + (sha256(first-user-text)[0:8] & INT63 | random <9e18)`.
 * A positive or hyphenated-UUID value here is a one-glance synthetic signal.
 */
export function signedAntigravitySessionId(seed?: string): string {
  if (seed !== undefined && /^-?\d+$/.test(seed)) return seed;
  const text = seed !== undefined && seed.length > 0 ? seed : randomUUID();
  const head = BigInt(`0x${createHash("sha256").update(text).digest("hex").slice(0, 8)}`);
  const randomPart =
    BigInt(`0x${randomBytes(8).toString("hex")}`) % BigInt("9000000000000000000");
  const combined = (head & BigInt("0x7FFFFFFFFFFFFFFF")) | randomPart;
  return `-${combined.toString()}`;
}

export function sessionStateKey(routeIdentity: string, wireModelId: string): string {
  return `${sessionIdentityDigest(routeIdentity)}:antigravity:${wireModelId}`;
}
