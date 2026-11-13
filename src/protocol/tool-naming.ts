/**
 * Claude-wire tool naming: OAuth traffic renames caller tools under a
 * reserved-safe prefix, and this module owns the rename on the way out plus
 * the alias registry that restores the caller's original name on the way
 * back — the same two-way pattern the OpenCode free-tier fingerprint uses
 * (conceal on the way out, restore on the way back).
 *
 * It also owns the tool-call id normalization the Anthropic wire requires
 * (`^[a-zA-Z0-9_-]{1,64}$`) and the billing-header marker helpers.
 */
import { hash32, hashToBase36 } from "./wire-readers";

const CLAUDE_TOOL_PREFIX = "_";

/**
 * Per-request tool-name rename map. `claudeToolName` renames a caller tool
 * whose name collides with an upstream-reserved name (or with the built-in
 * prefix) under an alias, and `restoreClaudeToolName` restores the caller's
 * original name on the way back.
 *
 * The map is a bag of `{ sent, original }` pairs rather than a fixed-prefix
 * strip because the prefix alone is ambiguous: a caller that already uses it
 * (`_bash`) would restore to the wrong name without the recorded pair.
 */
export interface ToolNameAlias {
  /** Name sent to the upstream wire. */
  readonly sent: string;
  /** Caller's original name; restore to this on the way back. */
  readonly original: string;
}

/** Restore a sent name to the caller's original, when it was renamed. */
export function restoreAliasedToolName(
  sent: string,
  aliases: ReadonlyArray<ToolNameAlias>,
): string {
  for (const alias of aliases) {
    if (alias.sent === sent) return alias.original;
  }
  return sent;
}

/**
 * Registry of per-request tool renames, keyed by the canonical request object
 * (the same object the builder saw and the decoder receives). This is the
 * transport-agnostic way to pair `encodeWireRequest` with `decodeWireResponse`
 * without threading a new parameter through every adapter: a request records
 * its aliases at build time, and any decoder that still has the request can
 * restore the caller's original tool names exactly.
 *
 * The WeakMap keeps no lifetime: entries die with the request object.
 */
const toolAliasesByRequest = new WeakMap<object, readonly ToolNameAlias[]>();

/** Record the rename map a request produced. Idempotent per request. */
export function recordToolAliases(request: object, aliases: readonly ToolNameAlias[]): void {
  if (aliases.length === 0) return;
  toolAliasesByRequest.set(request, aliases);
}

/** Read the rename map a request recorded, if any. */
export function toolAliasesFor(request: object): readonly ToolNameAlias[] {
  return toolAliasesByRequest.get(request) ?? [];
}

/** Restore a tool name exactly from the request's recorded renames. */
export function restoreToolNameFor(request: object, sent: string): string {
  return restoreAliasedToolName(sent, toolAliasesFor(request));
}

export const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "code_execution",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
  "text_editor",
  "computer",
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
  "mcp_toolset",
]);

/**
 * The single name-mapping owner for the Claude wire: returns the name sent
 * upstream for `name` under the given auth mode. OAuth traffic prefixes every
 * non-built-in name with `_`; API-key traffic passes names through verbatim.
 *
 * The restore side is `restoreClaudeToolName` in `response/messages.ts`, which
 * consults the per-request alias registry first and falls back to
 * `unprefixClaudeToolName` — the two rules can never disagree because both
 * live next to this function.
 */
export function claudeToolName(name: string, isOAuth: boolean): string {
  if (!isOAuth || ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
  return `${CLAUDE_TOOL_PREFIX}${name}`;
}

export function unprefixClaudeToolName(name: string, isOAuth: boolean): string {
  if (!isOAuth || !name.startsWith(CLAUDE_TOOL_PREFIX)) return name;
  return name.slice(CLAUDE_TOOL_PREFIX.length);
}

/** Prefix marking an echoed billing attestation block in replayed history. */
export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * Whether a system text block is an echoed billing attestation from a prior
 * turn. Such blocks must never be forwarded upstream again: they attest a
 * different body, and replaying them is precisely what abuse detection keys
 * on. Builders drop them when projecting system content.
 */
export function isClaudeBillingHeaderText(text: string): boolean {
  return text.startsWith(CLAUDE_BILLING_HEADER_PREFIX);
}

// Tool-call ID normalization

const ANTHROPIC_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function hashId(input: string): string {
  return hash32(input).toString(16).padStart(8, "0");
}

function isValidAnthropicToolCallId(id: string): boolean {
  return ANTHROPIC_ID_RE.test(id);
}

/**
 * Clamps a tool call id to a wire's length limit while keeping it recognisable.
 *
 * OpenCode Zen rejects a Responses `call_id` longer than 64 characters:
 * `` `input[5].call_id` The length of the value must be `<= 64` ``. The ids
 * that trip it come from the client (signature-style ids run to 156 chars), so
 * forwarding one verbatim fails a request the caller had no way to know was
 * oversized — and fails it on every replay, because the transcript keeps the
 * long id.
 *
 * Unlike {@link normalizeAnthropicToolCallId} this does not rewrite the id into
 * another provider's shape: only the length is a wire constraint here, so the
 * caller's alphabet is preserved. Truncation alone would collide — the ids
 * share a long common prefix — so the tail is replaced with a hash of the
 * original, which keeps distinct ids distinct.
 *
 * Returns the input unchanged when it already fits.
 */
export function clampToolCallId(raw: string, limit = 64): string {
  if (raw.length <= limit) return raw;
  const hash = hashId(raw);
  const suffix = `_${hash}`;
  if (suffix.length >= limit) return raw.slice(0, limit);
  return `${raw.slice(0, limit - suffix.length)}${suffix}`;
}

function fallbackAnthropicToolCallId(original: string): string {
  return `toolu_${hashId(original)}`;
}

/** Appends `_dupN`, carving the suffix out of the 64-char budget. */
function withDuplicateSuffix(canonical: string, index: number): string {
  const suffix = `_dup${index}`;
  return `${canonical.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Normalizes a tool-call ID for Anthropic's strict 64-char `^[a-zA-Z0-9_-]+$` requirement.
 * - Handles OpenAI Responses composite `callId|itemId` by taking the first segment.
 * - Replaces invalid chars with `_`, truncates to 64, and falls back to `toolu_<hash>` if empty.
 *
 * `seen` is the per-request uniqueness ledger: one map for a whole request, passed
 * in so every id in that request is distinct. It counts how many times each id has
 * been emitted (or reserved as a base), and this function is its only writer.
 *
 * The ledger is keyed on the CANONICAL form — the value after replacement,
 * truncation, and the hash fallback — not on the raw id. Keying on the raw was the
 * bug: two raws that canonicalize to the same base (`call!x` and `call@x` both
 * become `call_x`) have to share one counter, or the second one re-derives a
 * suffix the first already handed out. Both ends of the ledger are therefore
 * reserved: the base, and any generated `_dupN` result, so a later id that
 * naturally equals a generated one does not collide with it.
 */
export function normalizeAnthropicToolCallId(
  raw: string,
  seen: Map<string, number> = new Map(),
): string {
  // Handle composite IDs from Responses API: `call_id|item_id`
  const base = raw.includes("|") ? (raw.split("|")[0] ?? raw) : raw;
  let canonical = base.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (canonical.length === 0) canonical = fallbackAnthropicToolCallId(raw);
  if (canonical.length > 64) {
    // Keep prefix + hash suffix to avoid collisions
    const hash = hashId(raw);
    canonical = `${canonical.slice(0, 55)}_${hash.slice(0, 8)}`.slice(0, 64);
  }
  if (!isValidAnthropicToolCallId(canonical)) {
    canonical = fallbackAnthropicToolCallId(raw);
  }
  // Walk forward from this base's next free index until an id nobody holds is
  // found. The first candidate is the canonical form itself, which is free
  // exactly when the base has never been emitted.
  let index = seen.get(canonical) ?? 0;
  let normalized = index === 0 ? canonical : withDuplicateSuffix(canonical, index);
  while (seen.has(normalized)) {
    index += 1;
    normalized = withDuplicateSuffix(canonical, index);
  }
  // Reserve both ends: the base so the next call starts past this index, and the
  // generated id so a later raw that canonicalizes to it is forced to a new one.
  seen.set(canonical, index + 1);
  if (normalized !== canonical) seen.set(normalized, (seen.get(normalized) ?? 0) + 1);
  return normalized;
}

// Codex tool-call id wire encoding

/**
 * Encodes a tool-call ID as a Responses-safe composite `callId__itemId`.
 * Codex rejects punctuation such as `|` in `id`/`call_id`, so the separator
 * must stay within the upstream `[A-Za-z0-9_-]` contract.
 */
export function encodeCodexToolCallId(
  callId: string,
  itemId?: string | null,
): string {
  const stableItemId =
    itemId !== undefined && itemId !== null && itemId.length > 0
      ? itemId
      : `fc_${hashToBase36(callId)}`;
  return `${callId}__${stableItemId}`;
}

/** Decodes current `__` composites and accepts legacy `|` values on replay. */
export function decodeCodexToolCallId(raw: string): string {
  const separator = raw.includes("__") ? "__" : "|";
  const idx = raw.indexOf(separator);
  return idx === -1 ? raw : raw.slice(0, idx);
}
