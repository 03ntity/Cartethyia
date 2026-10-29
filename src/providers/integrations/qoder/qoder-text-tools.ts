/**
 * Canonical recovery for Qoder's INTL text-mode tool-call echo.
 *
 * On the INTL realm Qoder sometimes answers with a plain-text marker plus a
 * JSON echo instead of structured `tool_calls`:
 *
 *   [assistant 请求调用工具]
 *   [{"name":"read","arguments":"{"path":"D:/a.txt"}"}, …]
 *
 * The echo is rarely strict JSON: inner quotes come unescaped, argument text
 * carries real newlines, the array brackets may be missing, and the block may
 * sit inside a ``` fence or carry trailing DSML residue. Each of those shapes
 * has leaked to the client at some point. This module owns the single tolerant
 * parser for the whole family and is the only place that decodes it; the
 * stream hold-back in `qoder.ts` withholds marker candidates and feeds them
 * here at end of stream.
 */
import { randomUUID } from "node:crypto";
import { stripDsmlCloseTags, type DsmlToolCall } from "../../../protocol/dsml";

export type DsmlCall = DsmlToolCall;

/**
 * True when the text is clearly an attempted tool-protocol echo rather than
 * ordinary prose: a leak marker followed by the start of a JSON array/object.
 *
 * Used by the adapter's fail-closed decision: an echo that cannot be recovered
 * must fail the turn (never surface the protocol text as visible content),
 * while prose that merely mentions the marker keeps passing through.
 */
export function isQoderEchoAttempt(text: string): boolean {
  const fence = text.match(/^```[a-z]*\s*\n?/i);
  const src = fence && fence[0] ? text.slice(fence[0].length) : text;
  const marker = LEAK_MARKER_ANY_RE.exec(src);
  if (!marker) return false;
  const rest = src.slice(marker.index + marker[0].length).trim();
  return rest.startsWith("[") || rest.startsWith("{");
}

/**
 * Any spelling of the INTL tool-call leak marker — the square-bracket
 * canonical form, the angle-bracket variant the upstream also emits
 * (`<assistant 请求调用工具>`), and partial variants missing the closing
 * bracket. Mirrors `_LEAK_MARKER_RE` in the reference bridge.
 */
export const LEAK_MARKER_ANY_RE = /[\[<(]*\s*assistant\s*请求调用工具\s*[\]>)]?/;

/** Canonical marker literal used to seed prefix matching. */
export const LEAK_MARKER_LITERALS: readonly string[] = [
  "[assistant 请求调用工具]",
  "<assistant 请求调用工具>",
  "assistant 请求调用工具",
];

/**
 * Escapes literal control characters that occur inside JSON string values.
 *
 * The model often writes multi-line argument content as real newlines instead
 * of `\n` escapes (`{"content":"# title\nline 2\n"}`), which is not valid JSON
 * at any depth. Only characters inside strings are escaped; whitespace between
 * tokens is left alone, so a stream with genuine structural newlines is not
 * corrupted.
 */
function escapeControlInsideStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      if (ch === "\\") {
        out += ch;
        i += 1;
        if (i < text.length) out += text[i];
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Escapes the bare quotes that belong inside a JSON string value.
 *
 * Escaped quotes are parked first so they are not escaped twice, then every
 * remaining quote is escaped, then the parked ones are restored.
 */
function repairJsonQuotes(text: string): string {
  const ph = "\u0000";
  return text.replace(/\\"/g, ph).replace(/"/g, '\\"').replaceAll(ph, '\\"');
}

/**
 * Rebuilds the leaked tool-call echo shape when strict parsing fails.
 *
 * DeepSeek-family models echo calls with their inner quotes unescaped:
 * `[{"name":"read","arguments":"{"path":"a"}"},…]` is not valid JSON at either
 * level, and a parallel batch (several calls in one echo) previously fell
 * through the single-call regex and leaked as visible text. The scanner splits
 * top-level objects without relying on JSON validity (commas and braces inside
 * string values are respected by scanning quote-by-quote), rebuilds each call,
 * and accepts it only when its arguments parse as JSON. Both bracketed arrays
 * and bare comma-separated object lists are accepted.
 *
 * Returns `null` when the text is not that shape at all, so a caller can fall
 * back rather than accepting a guess. The result still goes through the same
 * strict checks as a normally-parsed array.
 */
function salvageEchoArray(rest: string): unknown {
  const src = rest.trim();
  if (src.length === 0) return null;
  const calls: Array<{ name: string; arguments: string }> = [];
  let i = 0;
  const bracketed = src[0] === "[";
  if (bracketed) i = 1;
  const skipWs = (): void => {
    while (
      i < src.length &&
      (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")
    ) {
      i += 1;
    }
  };
  const NAME_RE = /"name"\s*:\s*"([^"]{1,200})"/y;
  const ARG_KEY_RE = /"arguments"\s*:\s*"/y;

  for (;;) {
    skipWs();
    if (i >= src.length) break;
    if (bracketed && src[i] === "]") break;
    if (src[i] !== "{") return null;
    i += 1;
    skipWs();
    NAME_RE.lastIndex = i;
    const nameMatch = NAME_RE.exec(src);
    if (!nameMatch) return null;
    const name = nameMatch[1] ?? "";
    i = NAME_RE.lastIndex;
    skipWs();
    if (i < src.length && src[i] === ",") {
      i += 1;
      skipWs();
    }
    ARG_KEY_RE.lastIndex = i;
    if (!ARG_KEY_RE.exec(src)) return null;
    const argStart = ARG_KEY_RE.lastIndex;
    // Raw arguments run to the first `}"` — the argument value's own closing
    // bracket immediately followed by the object's closing quote. Scanning for
    // that pair separates the argument JSON from the enclosing object even when
    // commas or braces appear inside string values.
    let rawEnd = -1;
    for (let j = argStart; j + 1 < src.length; j += 1) {
      if (src[j] === "}" && src[j + 1] === '"') {
        rawEnd = j;
        break;
      }
    }
    if (rawEnd < 0) return null;
    const raw = src.slice(argStart, rawEnd + 1);
    const parsedArgs = [
      raw,
      escapeControlInsideStrings(raw),
      repairJsonQuotes(raw),
      escapeControlInsideStrings(repairJsonQuotes(raw)),
    ].find((candidate) => {
      try {
        JSON.parse(candidate);
        return true;
      } catch {
        return false;
      }
    });
    if (parsedArgs === undefined) return null;
    calls.push({ name, arguments: parsedArgs });
    // Past the argument's closing quote and the object's closing brace.
    i = rawEnd + 2;
    skipWs();
    if (i >= src.length || src[i] !== "}") return null;
    i += 1;
    skipWs();
    if (i < src.length && src[i] === ",") {
      i += 1;
      continue;
    }
    if (i < src.length && bracketed && src[i] === "]") continue;
    if (i < src.length) return null;
  }
  return calls.length > 0 ? calls : null;
}

/**
 * Recovers tool calls the model echoed back as text.
 *
 * On INTL the upstream reads tool calls as prose, so a turn that called a tool
 * is described with `LEAK_MARKER_ANY_RE` followed by a JSON array of
 * `{name, arguments}`. The model occasionally reproduces that shape verbatim as
 * its answer instead of calling again, and left alone the client shows the JSON
 * as content while the tool never runs.
 *
 * Only a well-formed array whose every entry names a tool and carries parseable
 * arguments is accepted. Anything else returns no calls and the original text,
 * so a model merely talking about the format is never mistaken for a call.
 */
export function parseQoderTextToolCalls(
  text: string,
  allowedNames?: ReadonlySet<string>,
): { calls: DsmlCall[]; clean: string } {
  if (text.length === 0) {
    return { calls: [], clean: text };
  }
  // The upstream occasionally echoes the marker in variants — angle brackets,
  // a missing closing bracket, or wrapped inside a ``` fence. Strip a leading
  // fence, then locate any marker spelling, mirroring the reference bridge's
  // `_normalize_leak_marker`.
  const fence = text.match(/^```[a-z]*\s*\n?/i);
  const src = fence && fence[0] ? text.slice(fence[0].length) : text;
  const marker = LEAK_MARKER_ANY_RE.exec(src);
  if (!marker) {
    return { calls: [], clean: text };
  }
  const head = src.slice(0, marker.index).trim();
  let rest = src.slice(marker.index + marker[0].length).trim();
  // The model occasionally leaves raw DSML closing tags after the echo array
  // (`</｜DSML｜parameter>` etc.), and a ``` fence may close the block. Strip
  // trailing residue so the JSON parse is not poisoned by "Extra data".
  rest = stripDsmlCloseTags(rest);
  rest = rest.replace(/\s*```\s*$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rest);
  } catch {
    // A model echoing the call writes the inner quotes unescaped or the
    // argument text with real newlines:
    // `[{"name":"Read","arguments":"{"file_path":"a.ts"}"}]`. That is not
    // valid JSON at either level, so first try escaping only the control
    // characters that live inside string values, then rebuild the array by
    // hand. Anything that still fails is not a call this can trust.
    try {
      parsed = JSON.parse(escapeControlInsideStrings(rest));
    } catch {
      const salvaged = salvageEchoArray(rest);
      if (salvaged === null) return { calls: [], clean: text };
      parsed = salvaged;
    }
  }
  if (Array.isArray(parsed) && parsed.length === 0) return { calls: [], clean: text };

  // The model echoes the call either as a JSON array (`[{name,arguments},…]`)
  // or as a single object (`{"name":…,"arguments":…}`). Normalize the single
  // object into a one-entry array so both shapes share one validator.
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const calls: DsmlCall[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return { calls: [], clean: text };
    const rec = item as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
    if (name.length === 0) return { calls: [], clean: text };
    if (allowedNames && !allowedNames.has(name)) return { calls: [], clean: text };
    const rawArgs = rec["arguments"];
    let args: string;
    if (typeof rawArgs === "object" && rawArgs !== null) args = JSON.stringify(rawArgs);
    else if (typeof rawArgs === "string") args = rawArgs;
    else return { calls: [], clean: text };
    // Arguments that do not parse are not a call this can trust. The parsed
    // outer layer un-escapes `\n`, so multi-line argument text arrives here
    // with real newlines again — normalize them before judging.
    const argsText = args.trim();
    if (argsText.length > 0) {
      let accepted = argsText;
      let ok = false;
      try {
        JSON.parse(accepted);
        ok = true;
      } catch {
        // fall through to normalization
      }
      if (!ok) {
        accepted = escapeControlInsideStrings(argsText);
        try {
          JSON.parse(accepted);
          ok = true;
        } catch (e) {
        }
      }
      if (!ok) return { calls: [], clean: text };
      args = accepted;
    }
    calls.push({ id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`, name, arguments: args });
  }
  return { calls, clean: head };
}
