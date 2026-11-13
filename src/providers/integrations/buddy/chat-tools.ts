/**
 * Tool-declaration normalization shared by the buddy family providers
 * (CodeBuddy International `cb` and CodeBuddy CN `cbcn`).
 *
 * The upstream validates tool schemas with RE2 and rejects shapes the OpenAI
 * wire allows, so the declarations are rewritten before dispatch:
 *
 * - names must match `[a-zA-Z0-9_-]+` and fit the 64-char cap;
 * - `web_search`/`web_search_preview` hosted tools become an ordinary function
 *   named `web_search` so the caller's own tool loop can run it;
 * - RE2-incompatible `\_` escapes are stripped from schema `pattern`
 *   positions; and
 * - every `parameters`/`format` payload is run through
 *   `completeRequiredSchema` so `required` lists cover all properties.
 *
 * Tool references inside messages (`tool_calls[].function.name`) and the
 * `tool_choice` selection are rewritten with the same renames so the wire
 * stays consistent.
 *
 * Split out of `chat.ts`; `chat.ts` re-exports the public entry point so
 * importers keep their existing module path.
 */
import { completeRequiredSchema } from "../../../protocol/codecs";
import { isRecord } from "../../../protocol/codecs";

const BUDDY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const INVALID_BUDDY_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
const MAX_BUDDY_TOOL_NAME_LENGTH = 64;

function uniqueToolName(base: string, used: Set<string>): string {
  const clipped = (base || "tool").slice(0, MAX_BUDDY_TOOL_NAME_LENGTH);
  if (!used.has(clipped)) return clipped;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${clipped.slice(0, MAX_BUDDY_TOOL_NAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizedToolName(value: string, index: number, used: Set<string>): string {
  const base =
    BUDDY_TOOL_NAME_PATTERN.test(value) && value.length <= MAX_BUDDY_TOOL_NAME_LENGTH
      ? value
      : value.replace(INVALID_BUDDY_TOOL_NAME_CHARS, "");
  return uniqueToolName(base || `tool_${index + 1}`, used);
}

/**
 * Schema keywords whose values are schemas (recursed as schema objects).
 * Mirrors the donor gateway's `upstream_compat._SCHEMA_MAPS/_ARRAYS/CHILDREN`.
 */
const RE2_SCHEMA_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);
const RE2_SCHEMA_ARRAYS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "items",
]);
const RE2_SCHEMA_CHILDREN: ReadonlySet<string> = new Set([
  "items",
  "additionalItems",
  "contains",
  "unevaluatedItems",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/**
 * Removes unescaped backslashes before underscores in one regex pattern. The
 * CodeBuddy upstream validates tool schemas with RE2, which does not support
 * `\_` escapes — a client schema that serializes `\_` (a common JSON
 * representation of a literal underscore) is rejected with a 400. The donor
 * gateway normalizes this before dispatch; a backslash that escapes a
 * backslash is preserved.
 */
function normalizeRe2Pattern(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && value[i + 1] === "\\") {
      // Escaped backslash: keep the pair so a following `_` stays escaped.
      out += "\\\\";
      i += 1;
      continue;
    }
    if (char === "\\" && value[i + 1] === "_") {
      // `\_` — the upstream's RE2 rejects it; drop the backslash.
      out += "_";
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Normalizes RE2-incompatible underscore escapes in schema pattern positions. */
function normalizeRe2SchemaPatterns(schema: unknown): void {
  if (!isRecord(schema)) return;
  const pattern = schema["pattern"];
  if (typeof pattern === "string") schema["pattern"] = normalizeRe2Pattern(pattern);
  const patternProperties = schema["patternProperties"];
  if (isRecord(patternProperties)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patternProperties)) {
      const key2 = normalizeRe2Pattern(key);
      if (key2 in normalized) {
        normalized[key2] = { allOf: [normalized[key2], value] };
      } else {
        normalized[key2] = value;
      }
    }
    schema["patternProperties"] = normalized;
  }
  for (const key of RE2_SCHEMA_MAPS) {
    const map = schema[key];
    if (!isRecord(map)) continue;
    for (const child of Object.values(map)) normalizeRe2SchemaPatterns(child);
  }
  for (const key of RE2_SCHEMA_ARRAYS) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    for (const child of list) normalizeRe2SchemaPatterns(child);
  }
  for (const key of RE2_SCHEMA_CHILDREN) {
    normalizeRe2SchemaPatterns(schema[key]);
  }
}

/** JSON-serializes a value to cheaply detect a backslash-before-underscore. */
function hasUnderscoreEscape(value: unknown): boolean {
  try {
    return JSON.stringify(value).includes("\\_");
  } catch {
    return true;
  }
}

/** Returns the declaration with RE2-safe schema patterns, or the same object. */
function normalizeRe2Declaration(declaration: Record<string, unknown>): Record<string, unknown> {
  const parameters = declaration["parameters"];
  if (!hasUnderscoreEscape(parameters)) return declaration;
  // Deep-copy only when a rewrite is needed; the shared object must not be
  // mutated for every dispatch.
  const out: Record<string, unknown> = { ...declaration };
  out["parameters"] = structuredClone(parameters);
  normalizeRe2SchemaPatterns(out["parameters"]);
  return out;
}

/**
 * Buddy's Chat Completions wire has no `web_search_preview` hosted tool; its
 * search is an ordinary function named `web_search` with a `{query}` schema.
 * Rewriting the hosted declaration here lets the caller's own tool loop
 * (Model Lab, or any client that executes its functions) run the query at
 * `POST /v1/search`. The gateway never executes it: an unexecuted call is
 * returned to the caller like any other function call.
 */
function buddyHostedSearchFunction(rawTool: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = rawTool["type"];
  if (type !== "web_search" && type !== "web_search_preview") return undefined;
  return {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}


export function normalizeBuddyToolNames(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload["tools"])) return;
  const used = new Set<string>();
  const replacements = new Map<string, string>();
  payload["tools"] = payload["tools"].map((rawTool, index) => {
    if (!isRecord(rawTool)) return rawTool;
    const hostedSearch = buddyHostedSearchFunction(rawTool);
    if (hostedSearch !== undefined) {
      used.add("web_search");
      return hostedSearch;
    }
    const fn = isRecord(rawTool["function"]) ? rawTool["function"] : undefined;
    const custom = isRecord(rawTool["custom"]) ? rawTool["custom"] : undefined;
    const sourceName = fn?.["name"] ?? custom?.["name"] ?? rawTool["name"];
    if (typeof sourceName !== "string") return rawTool;
    const name = normalizedToolName(sourceName, index, used);
    used.add(name);
    if (!replacements.has(sourceName)) replacements.set(sourceName, name);
    if (fn !== undefined) {
      const fnOut = {
        ...fn,
        name,
        ...(fn["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(fn["parameters"]) }),
      };
      return { ...rawTool, function: normalizeRe2Declaration(fnOut) };
    }
    if (custom !== undefined) {
      const customOut = {
        ...custom,
        name,
        ...(custom["format"] === undefined ? {} : { format: completeRequiredSchema(custom["format"]) }),
      };
      return { ...rawTool, custom: normalizeRe2Declaration(customOut) };
    }
    const bareOut = {
      ...rawTool,
      name,
      ...(rawTool["parameters"] === undefined ? {} : { parameters: completeRequiredSchema(rawTool["parameters"]) }),
    };
    return { ...bareOut, ...normalizeRe2Declaration(bareOut) };
  });
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message["tool_calls"])) continue;
      for (const call of message["tool_calls"]) {
        if (!isRecord(call) || !isRecord(call["function"])) continue;
        const name = call["function"]["name"];
        const replacement = typeof name === "string" ? replacements.get(name) : undefined;
        if (replacement !== undefined) call["function"]["name"] = replacement;
      }
    }
  }
  const responseFormat = payload["response_format"];
  if (isRecord(responseFormat) && hasUnderscoreEscape(responseFormat)) {
    const copied = structuredClone(responseFormat) as Record<string, unknown>;
    const jsonSchema = copied["json_schema"];
    if (isRecord(jsonSchema)) normalizeRe2SchemaPatterns(jsonSchema["schema"]);
    payload["response_format"] = copied;
  }
  const choice = payload["tool_choice"];
  if (!isRecord(choice)) return;
  if (choice["type"] === "allowed_tools" && Array.isArray(choice["tools"])) {
    for (const rawAllowed of choice["tools"]) {
      if (!isRecord(rawAllowed)) continue;
      const allowedFn = isRecord(rawAllowed["function"]) ? rawAllowed["function"] : rawAllowed;
      const name = allowedFn["name"];
      const replacement = typeof name === "string" ? replacements.get(name) : undefined;
      if (replacement !== undefined) allowedFn["name"] = replacement;
    }
    return;
  }
  const choiceFn = isRecord(choice["function"]) ? choice["function"] : undefined;
  const choiceCustom = isRecord(choice["custom"]) ? choice["custom"] : undefined;
  const choiceName = choiceFn?.["name"] ?? choiceCustom?.["name"] ?? choice["name"];
  if (typeof choiceName !== "string") return;
  const replacement = replacements.get(choiceName);
  if (replacement === undefined) return;
  if (choiceFn !== undefined) choice["function"] = { ...choiceFn, name: replacement };
  else if (choiceCustom !== undefined) choice["custom"] = { ...choiceCustom, name: replacement };
  else choice["name"] = replacement;
}
