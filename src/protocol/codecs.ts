/**
 * Shared wire-protocol primitives used by every provider codec in
 * `src/protocol/` — the single public surface for the generic guards, UTF-16
 * well-formedness coercion, JSON/argument helpers, hash helpers, endpoint
 * URL construction, image-source resolution, tool-name aliasing, tool-schema
 * sanitization, and custom-header validation that the per-wire request/
 * response codecs build on.
 *
 * The implementation is split by domain into sibling modules; this file
 * re-exports their public API so every importer keeps one import site:
 *
 * - `rewrite.ts` — bounded-depth walk primitives, UTF-16 coercion, Harmony
 *   control-token escaping, JSON-depth guard, `parseArguments`.
 * - `wire-readers.ts` — record guards, field readers, string hashes.
 * - `tool-naming.ts` — Claude tool-name prefixing, per-request alias registry,
 *   tool-call id normalization, Codex id encoding.
 * - `tool-schema.ts` — JSON-Schema normalization and the Anthropic keyword
 *   allowlist.
 * - `wire-endpoint.ts` — endpoint URLs, Codex session/effort vocabulary,
 *   image-source resolution, custom-header validation.
 *
 * Provider-specific primitives that depend on provider identity (e.g. Codex
 * identity headers) deliberately live with their provider, not here.
 */
export {
  MAX_REWRITE_DEPTH,
  MAX_JSON_DEPTH,
  ROOT_WALK,
  descend,
  shouldStop,
  toWellFormedString,
  toWellFormedDeep,
  assertBoundedJsonDepth,
  parseArguments,
  escapeHarmonyControlTokens,
  escapeHarmonyControlTokensDeep,
} from "./rewrite";
export type { RewriteWalk } from "./rewrite";
export {
  isRecord,
  stringValue,
  finiteNumber,
  readString,
  readNumber,
  readOutputIndex,
  readBoolean,
  hash32,
  hashToBase36,
} from "./wire-readers";
export type { ClaudeWireObject } from "./wire-readers";
export {
  ANTHROPIC_BUILTIN_TOOL_NAMES,
  CLAUDE_BILLING_HEADER_PREFIX,
  restoreAliasedToolName,
  recordToolAliases,
  toolAliasesFor,
  restoreToolNameFor,
  claudeToolName,
  unprefixClaudeToolName,
  isClaudeBillingHeaderText,
  clampToolCallId,
  normalizeAnthropicToolCallId,
  encodeCodexToolCallId,
  decodeCodexToolCallId,
} from "./tool-naming";
export type { ToolNameAlias } from "./tool-naming";
export {
  sanitizeSchemaForAnthropic,
  normalizeToolParameterRoot,
  completeRequiredSchema,
} from "./tool-schema";
export {
  endpointUrl,
  toAsciiJsonString,
  CODEX_WIRE_EFFORT_VALUES,
  mapReasoningEffortToWireTier,
  resolveOutputVerbosity,
  tryParseJsonObject,
  canonicalTerminal,
  BUILTIN_DEFAULT_ENDPOINTS,
  BARE_ROOT_ENDPOINTS,
  splitDataUrl,
  resolveImageSource,
  joinUrl,
  normalizeBearerToken,
  filterProviderCustomHeaders,
} from "./wire-endpoint";
export type { CodexSessionState, CodexWireEffort, AuthHeaderShape } from "./wire-endpoint";
