/**
 * Per-session state store for the Codex adapter.
 *
 * Holds the sticky-routing state (`x-codex-turn-state`) and session identity
 * for live Codex sessions, bounded by an LRU size cap and a TTL. Split out
 * of `codex.ts` so the adapter file stays focused on the adapter lifecycle.
 */
import type { CodexSessionState } from "../../../protocol/codecs";

/**
 * Bounded LRU + TTL store for Codex session state.
 *
 * An unbounded map would leak memory forever under a long-running process
 * serving many distinct Codex sessions; both the size cap and the TTL keep
 * the store bounded.
 */
export class CodexSessionStore {
  readonly #states = new Map<
    string,
    { state: CodexSessionState; lastAccessMs: number }
  >();
  readonly #maxStates: number;
  readonly #ttlMs: number;

  constructor(maxStates: number, ttlMs: number) {
    this.#maxStates = maxStates;
    this.#ttlMs = ttlMs;
  }

  #pruneExpired(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [id, entry] of this.#states) {
      if (entry.lastAccessMs < cutoff) this.#states.delete(id);
    }
  }

  get(id: string): CodexSessionState | undefined {
    const entry = this.#states.get(id);
    if (entry === undefined) return undefined;
    if (entry.lastAccessMs < Date.now() - this.#ttlMs) {
      this.#states.delete(id);
      return undefined;
    }
    // Refresh recency: delete+set moves the entry to the end (Map preserves
    // insertion order), making eviction below a true least-recently-used sweep.
    this.#states.delete(id);
    entry.lastAccessMs = Date.now();
    this.#states.set(id, entry);
    return entry.state;
  }

  set(id: string, state: CodexSessionState): void {
    this.#pruneExpired();
    this.#states.delete(id);
    this.#states.set(id, { state, lastAccessMs: Date.now() });
    while (this.#states.size > this.#maxStates) {
      const oldest = this.#states.keys().next();
      if (oldest.done) break;
      this.#states.delete(oldest.value);
    }
  }
}
