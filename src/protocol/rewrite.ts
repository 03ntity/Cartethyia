/**
 * Request-supplied value rewriting: the bounded-depth walk primitives and the
 * rewriters every wire codec applies to caller-controlled data before it is
 * forwarded upstream.
 *
 * This module owns `RewriteWalk`/`descend`/`ROOT_WALK`/`shouldStop`, the
 * `MAX_REWRITE_DEPTH`/`MAX_JSON_DEPTH` bounds, UTF-16 well-formedness
 * coercion, Harmony control-token escaping, and `parseArguments` — the helpers
 * `sanitizeSchemaForAnthropic` (tool-schema.ts) and the Gemini sanitizer
 * (request/gemini.ts) thread through their own walks.
 *
 * The depth bound exists because these rewriters recurse over values a
 * caller supplied — tool schemas, tool-call argument strings, thinking
 * payloads — and plain recursion over that data overflows the call stack at
 * roughly 10,000 levels (measured: a 400 KB body whose JSON nests 20,000 deep
 * parses fine and then throws `RangeError: Maximum call stack size exceeded`).
 * The ingress guard's `MAX_JSON_DEPTH = 64` does not cover this: it measures
 * the envelope, and a value carried as a JSON **string** inside that envelope
 * (`function.arguments` on the Chat wire, a schema in a string field) is
 * parsed by a decoder *after* the guard has passed.
 */
import { GatewayError } from "./gateway-error";

/**
 * Deepest nesting the recursive rewriters below will descend into.
 *
 * 256 is far above any real schema — a hand-written tool schema nests a
 * handful of levels — and far below the ~10,000 frames that overflow V8. A
 * value past the bound is forwarded **unchanged**, not dropped: these helpers
 * exist to make a value safe to forward, and discarding a caller's schema
 * would be worse than forwarding a shape the upstream may reject on its own.
 */
export const MAX_REWRITE_DEPTH = 256;

/**
 * Whether a walk is already inside `value` — i.e. the input contains a cycle.
 *
 * A depth bound cannot stop a cycle: a two-node loop overflows at any bound.
 * The check is per-walk rather than global, so the same node may legitimately
 * appear twice in a tree (a shared subschema) without being mistaken for one.
 */
function createsCycle(path: readonly object[], value: object): boolean {
  return path.includes(value);
}

/**
 * The recursion state every rewriter below threads through its walk.
 *
 * Kept in a private worker rather than as optional parameters on the exported
 * function. `Array.prototype.map` passes the element *index* as the second
 * argument, so an exported `(value, depth = 0)` would let a bare
 * `.map(toWellFormedDeep)` hand the index to `depth` — and past the bound the
 * guard would forward the value **unrewritten** instead of failing loudly. A
 * one-parameter export makes that call a type error.
 */
export interface RewriteWalk {
  readonly depth: number;
  readonly path: readonly object[];
}

/** The walk one level down, descending into `value`. */
export function descend(walk: RewriteWalk, value: object): RewriteWalk {
  return { depth: walk.depth + 1, path: [...walk.path, value] };
}

/** The walk state every rewrite starts from. */
export const ROOT_WALK: RewriteWalk = { depth: 0, path: [] };

/** True when this node must be forwarded as-is rather than rewritten. */
export function shouldStop(walk: RewriteWalk, value: object): boolean {
  return walk.depth >= MAX_REWRITE_DEPTH || createsCycle(walk.path, value);
}

export function toWellFormedString(value: string): string {
  // String.prototype.toWellFormed is ES2024; guaranteed by Bun ≥1.4, the only
  // supported runtime.
  return value.toWellFormed();
}

export function toWellFormedDeep(value: unknown): unknown {
  return toWellFormedWalk(value, ROOT_WALK);
}

function toWellFormedWalk(value: unknown, walk: RewriteWalk): unknown {
  if (typeof value === "string") return toWellFormedString(value);
  if (Array.isArray(value)) {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = toWellFormedWalk(entry, inner);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = toWellFormedWalk(v, inner);
      if (sanitized !== v) changed = true;
      out[k] = sanitized;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Deepest nesting accepted for a JSON document carried by a request.
 *
 * One bound for both transports of the same content. A body may carry a
 * structure as nested JSON **objects** or as a JSON **string** in a field
 * (`function.arguments` on the Chat wire), and a limit applied to only one of
 * them is not a limit: the string form sidesteps it entirely. Measured before
 * this existed, an arguments string nesting 20,000 deep returned HTTP 200
 * through the real encoder and then threw `RangeError` inside the request
 * builder, and one at 50,000 threw from `JSON.stringify` on the outbound body.
 *
 * The ingress middleware (`body-policy.ts`) imports this constant for the
 * envelope check, so the two enforcement points cannot drift apart.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Rejects a value nested deeper than {@link MAX_JSON_DEPTH}.
 *
 * Fails fast — it throws *before* recursing past the bound — so it spends at
 * most 65 frames and cannot overflow the stack it is protecting. `JSON.parse`
 * never returns a cyclic graph, so a cycle cannot reach here.
 */
export function assertBoundedJsonDepth(value: unknown): void {
  assertBoundedDepthWalk(value, 0);
}

function assertBoundedDepthWalk(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH)
    throw new GatewayError("invalid_request", 400, `The request body is nested deeper than this endpoint accepts (${MAX_JSON_DEPTH} levels) (request {requestId}). Flatten the payload. Check the shape of what you sent — then resend 🪞`);
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedDepthWalk(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    // for...in avoids allocating the Object.values() array per node.
    for (const key in value as Record<string, unknown>) {
      assertBoundedDepthWalk((value as Record<string, unknown>)[key], depth + 1);
    }
  }
}

export function parseArguments(value: unknown): unknown {
  // A zero-arg tool call carries "" (or absent) arguments. Callers on the
  // Messages wire need an object (`input`), so an empty string coerces to {}
  // rather than passing "" through and drawing an upstream 400.
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      // The envelope guard measured only the string, so this is the first
      // place the nesting inside it becomes visible. Reject it here, exactly
      // as the envelope guard would have rejected the same content sent as
      // nested objects — the alternative is forwarding a value the outbound
      // serializer cannot handle.
      assertBoundedJsonDepth(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      return value;
    }
  }
  return value ?? {};
}

/**
 * Reserved Harmony dialect control-token spellings. Escaping these to the
 * inert backslash form lets untrusted data (user text, tool results,
 * replayed history) reach Harmony-dialect models (gpt-5.x family) without
 * the backend's prompt validator rejecting the whole request as
 * `invalid_prompt` / "Request blocked".
 */
const HARMONY_CONTROL_TOKEN_ESCAPE_RE =
  /<\|(start|end|message|channel|constrain|return|call)\|>/g;

/**
 * Escapes reserved Harmony control tokens. Idempotent — no-op on text
 * without a reserved spelling — so it is safe to apply unconditionally.
 */
export function escapeHarmonyControlTokens(text: string): string {
  return text.replace(HARMONY_CONTROL_TOKEN_ESCAPE_RE, "<\\|$1\\|>");
}

/** Recursively escapes every string leaf of a JSON-like value. */
export function escapeHarmonyControlTokensDeep(value: unknown): unknown {
  return escapeHarmonyWalk(value, ROOT_WALK);
}

function escapeHarmonyWalk(value: unknown, walk: RewriteWalk): unknown {
  if (typeof value === "string") {
    // Cheap reject before the regex: most strings carry no control token, and
    // `replace` on a clean string still allocates — skip it entirely so the
    // Codex encode path returns the input graph untouched.
    return value.includes("<|") ? escapeHarmonyControlTokens(value) : value;
  }
  if (Array.isArray(value)) {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    let changed = false;
    const next = value.map((v) => {
      const escaped = escapeHarmonyWalk(v, inner);
      if (escaped !== v) changed = true;
      return escaped;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    if (shouldStop(walk, value)) return value;
    const inner = descend(walk, value);
    const source = value as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(source)) {
      const escaped = escapeHarmonyWalk(v, inner);
      if (escaped === v) {
        if (out !== undefined) out[k] = escaped;
        continue;
      }
      // Copy-on-change: the copy is built lazily at the first differing leaf,
      // and entries before it are filled from the source on demand below.
      if (out === undefined) {
        out = {};
        for (const [pk, pv] of Object.entries(source)) {
          if (pk === k) break;
          out[pk] = pv;
        }
      }
      out[k] = escaped;
    }
    return out ?? value;
  }
  return value;
}
