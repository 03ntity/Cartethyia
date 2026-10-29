/**
 * Recovery for Qoder's INTL text-mode tool-call echo.
 *
 * Qoder's own wire is structured `tool_calls` deltas, but the DeepSeek model
 * sometimes *also* writes a tool call as prose with the marker:
 *
 *   assistant 请求调用工具
 *   {"name":"write","arguments":"…"},{"name":"write","arguments":"…"}
 *
 * Left alone the JSON reaches the caller as visible content while nothing runs.
 * This module owns the single tolerant parser for that echo family (JSON
 * array/object, bare comma-separated list, unescaped inner quotes). It does
 * NOT parse DSML/XML markup — that family is gone; only the marker+JSON echo
 * the model actually emits is recovered here.
 */
import { randomUUID } from "node:crypto";

/** One recovered call, in the shape the canonical events want. */
export interface QoderEchoCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Any spelling of the INTL tool-call leak marker. */
export const LEAK_MARKER_ANY_RE = /[\[<(]*\s*assistant\s*请求调用工具\s*[\]>)]?/;

/** Canonical marker literals used to seed prefix matching. */
export const LEAK_MARKER_LITERALS: readonly string[] = [
  "[assistant 请求调用工具]",
  "<assistant 请求调用工具>",
  "assistant 请求调用工具",
];

/**
 * Escapes literal control characters that occur inside JSON string values.
 * DeepSeek often writes multi-line argument content as real newlines instead
 * of `\n` escapes; only characters inside strings are escaped.
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

/** Escapes bare quotes that belong inside a JSON string value. */
function repairJsonQuotes(text: string): string {
  const ph = "\u0000";
  return text.replace(/\\"/g, ph).replace(/"/g, '\\"').replaceAll(ph, '\\"');
}

/**
 * Rebuilds the leaked echo when strict parsing fails: inner quotes unescaped
 * (`[{"name":"read","arguments":"{"path":"a"}"},…]`) or a bare comma-separated
 * object list. Scans top-level objects without relying on JSON validity.
 * Returns null when the text is not that shape at all.
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
 * True when the text is clearly an attempted tool-protocol echo rather than
 * ordinary prose: a leak marker followed by the start of a JSON array/object,
 * or of a tool-style tag (`<tool_call>`, `<execute …/>`, angle-wrapped
 * `<{…}>`). Used by the fail-closed decision: an echo that cannot be recovered
 * fails the turn instead of surfacing protocol text as visible content.
 */
export function isQoderEchoAttempt(text: string): boolean {
  const fence = text.match(/^```[a-z]*\s*\n?/i);
  const src = fence && fence[0] ? text.slice(fence[0].length) : text;
  const marker = LEAK_MARKER_ANY_RE.exec(src);
  if (!marker) return false;
  const rest = src.slice(marker.index + marker[0].length).trim();
  return (
    rest.startsWith("[") ||
    rest.startsWith("{") ||
    /^<[a-zA-Z0-9_.:-]+\b/.test(rest) ||
    (rest.startsWith("<[") || rest.startsWith("<{"))
  );
}

/**
 * Recovers tool calls the model echoed back as text. Only a well-formed echo
 * whose every entry names a tool and carries parseable arguments is accepted;
 * anything else returns no calls and the original text.
 */
export function parseQoderTextToolCalls(
  text: string,
  allowedNames?: ReadonlySet<string>,
): { calls: QoderEchoCall[]; clean: string } {
  if (text.length === 0) {
    return { calls: [], clean: text };
  }
  const fence = text.match(/^```[a-z]*\s*\n?/i);
  const src = fence && fence[0] ? text.slice(fence[0].length) : text;
  const marker = LEAK_MARKER_ANY_RE.exec(src);
  if (!marker) {
    return { calls: [], clean: text };
  }
  const head = src.slice(0, marker.index).trim();
  let rest = src.slice(marker.index + marker[0].length).trim();
  rest = rest.replace(/\s*```\s*$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rest);
  } catch {
    try {
      parsed = JSON.parse(escapeControlInsideStrings(rest));
    } catch {
      // A bare comma-separated object list (`{...},{...}`) is not valid JSON
      // on its own, but is exactly the echo the model emits. Wrap it in an
      // array before falling back to salvage.
      let wrapped: unknown;
      try {
        wrapped = JSON.parse(`[${rest}]`);
      } catch {
        wrapped = undefined;
      }
      const salvaged = salvageEchoArray(rest);
      if (salvaged === null && wrapped === undefined) {
        return { calls: [], clean: text };
      }
      parsed = salvaged ?? wrapped;
    }
  }
  if (Array.isArray(parsed) && parsed.length === 0) return { calls: [], clean: text };

  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const calls: QoderEchoCall[] = [];
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
        } catch {
          // still invalid
        }
      }
      if (!ok) return { calls: [], clean: text };
      args = accepted;
    }
    calls.push({ id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`, name, arguments: args });
  }
  return { calls, clean: head };
}
