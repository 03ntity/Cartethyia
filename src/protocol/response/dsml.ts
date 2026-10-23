/**
 * CodeBuddy-family DeepSeek sometimes emits native tool markup as assistant text.
 * Complete declared calls are recovered; incomplete and undeclared blocks stay text.
 */
const SEPARATORS = ["｜｜", "｜", "|"] as const;
const BLOCK_NAMES = ["calls", "function_calls"] as const;
const OPENERS = SEPARATORS.flatMap((separator) => BLOCK_NAMES.map((name) => `<${separator}DSML${separator} ${name}>`));
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

/** Escapes regex metacharacters so a `|` separator is literal, not alternation. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DsmlToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface DsmlRecovery {
  readonly text: string;
  readonly calls: readonly DsmlToolCall[];
}

export class DsmlToolCallParser {
  readonly #allowedNames: ReadonlySet<string>;
  #pending = "";
  #callSequence = 0;

  constructor(allowedNames: ReadonlySet<string>) {
    this.#allowedNames = allowedNames;
  }

  push(chunk: string): DsmlRecovery {
    this.#pending += chunk;
    let cursor = 0;
    let visible = "";
    const calls: DsmlToolCall[] = [];
    for (;;) {
      let openIndex = -1;
      let opener = "";
      for (const candidate of OPENERS) {
        const index = this.#pending.indexOf(candidate, cursor);
        if (index >= 0 && (openIndex < 0 || index < openIndex)) {
          openIndex = index;
          opener = candidate;
        }
      }
      if (openIndex < 0) {
        const safeEnd = this.#settledEnd(cursor);
        visible += this.#pending.slice(cursor, safeEnd);
        cursor = safeEnd;
        break;
      }
      visible += this.#pending.slice(cursor, openIndex);
      const separator = SEPARATORS.find((value) => opener.startsWith(`<${value}DSML`));
      const blockName = BLOCK_NAMES.find((value) => opener.endsWith(` ${value}>`));
      if (separator === undefined || blockName === undefined) {
        visible += "<";
        cursor = openIndex + 1;
        continue;
      }
      const close = `</${separator}DSML${separator} ${blockName}>`;
      const closeIndex = this.#pending.indexOf(close, openIndex + opener.length);
      if (closeIndex < 0) {
        cursor = openIndex;
        break;
      }
      const end = closeIndex + close.length;
      const block = this.#pending.slice(openIndex, end);
      const parsed = parseBlock(block, opener, close, separator, this.#allowedNames);
      if (parsed === undefined) visible += block;
      else {
        for (const call of parsed) calls.push({ ...call, id: `call_dsml_${this.#callSequence++}_${call.name}` });
      }
      cursor = end;
    }
    this.#pending = this.#pending.slice(cursor);
    return { text: visible, calls };
  }

  flush(): DsmlRecovery {
    const text = this.#pending;
    this.#pending = "";
    return { text, calls: [] };
  }

  #settledEnd(start: number): number {
    const remaining = this.#pending.slice(start);
    for (let length = Math.min(OPENERS.reduce((max, opener) => Math.max(max, opener.length - 1), 0), remaining.length); length > 0; length -= 1) {
      const suffix = remaining.slice(-length);
      if (OPENERS.some((opener) => opener.startsWith(suffix))) return this.#pending.length - length;
    }
    return this.#pending.length;
  }
}

export function parseDsmlToolCalls(
  text: string,
  allowedNames: ReadonlySet<string> = new Set(),
): DsmlRecovery | undefined {
  if (!text.includes("DSML")) return undefined;
  const parser = new DsmlToolCallParser(allowedNames);
  const first = parser.push(text);
  const last = parser.flush();
  const recovered = [...first.calls, ...last.calls];
  return recovered.length === 0 ? undefined : { text: `${first.text}${last.text}`.trim(), calls: recovered };
}

function parseBlock(
  block: string,
  opener: string,
  close: string,
  separator: string,
  allowedNames: ReadonlySet<string>,
): Omit<DsmlToolCall, "id">[] | undefined {
  const inner = block.slice(opener.length, -close.length);
  const pipe = escapeRegExp(separator);
  const invokePattern = new RegExp(`<${pipe}DSML${pipe}\\s+invoke\\s+name="([^"]*)"\\s*>`, "g");
  const calls: Omit<DsmlToolCall, "id">[] = [];
  // The allowlist is strict only when the caller knows the declared tools: a
  // caller without one (a direct parse) keeps the generic name rule, while a
  // dispatch that declared its tools must never execute a name it did not offer.
  const strict = allowedNames.size > 0;
  let cursor = 0;
  for (const invoke of inner.matchAll(invokePattern)) {
    const name = invoke[1] ?? "";
    if (!TOOL_NAME.test(name) || (strict && !allowedNames.has(name)) || invoke.index === undefined) return undefined;
    if (inner.slice(cursor, invoke.index).trim().length > 0) return undefined;
    const bodyStart = invoke.index + invoke[0].length;
    const invokeClose = `</${separator}DSML${separator} invoke>`;
    const invokeEnd = inner.indexOf(invokeClose, bodyStart);
    if (invokeEnd < 0) return undefined;
    const parameterPattern = new RegExp(`<${pipe}DSML${pipe}\\s+parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`, "g");
    const body = inner.slice(bodyStart, invokeEnd);
    const args: Record<string, unknown> = {};
    let parameterCursor = 0;
    for (const parameter of body.matchAll(parameterPattern)) {
      const key = parameter[1] ?? "";
      if (key.length === 0 || parameter.index === undefined || body.slice(parameterCursor, parameter.index).trim().length > 0) return undefined;
      const valueStart = parameter.index + parameter[0].length;
      const parameterClose = `</${separator}DSML${separator} parameter>`;
      const valueEnd = body.indexOf(parameterClose, valueStart);
      if (valueEnd < 0) return undefined;
      const raw = body.slice(valueStart, valueEnd);
      if (parameter[2] === "true") args[key] = raw;
      else {
        try { args[key] = JSON.parse(raw); }
        catch { args[key] = raw; }
      }
      parameterCursor = valueEnd + parameterClose.length;
    }
    if (body.slice(parameterCursor).trim().length > 0) return undefined;
    calls.push({ name, arguments: JSON.stringify(args) });
    cursor = invokeEnd + invokeClose.length;
  }
  return calls.length > 0 && inner.slice(cursor).trim().length === 0 ? calls : undefined;
}
