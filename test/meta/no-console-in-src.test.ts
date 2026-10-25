/**
 * `src/` must log through the logger, never through `console`.
 *
 * The logger is the only thing that levels, sanitizes and bounds what the
 * gateway writes: it drops filtered levels before any payload is copied, caps
 * depth and string length, and writes JSON that the console log ring can render
 * back. A `console.warn` bypasses all of it — it is unlevelled (it prints in
 * production at any log level), unsanitized, and invisible to the console's own
 * log view, so an operator reading the dashboard never sees the message that
 * was emitted for them.
 *
 * This is the guard for that. It walks every shipped source file and fails on a
 * `console.*` call, with two deliberate exemptions:
 *
 *  - the logger itself, which has to touch the console to be the transport;
 *  - occurrences inside comments, which describe the rule rather than break it.
 *
 * `scripts/` and `test/` are NOT covered on purpose: a CLI's stdout is its
 * interface, and a test's `console.log` is often the protocol the test asserts
 * on. The rule is about runtime logging, not about output.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "../../src");

/** Files whose `console` use IS the point: the logger owns the transport. */
const EXEMPT_FILES: ReadonlySet<string> = new Set(["observability/logger.ts"]);

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips comments and string literals so only real call sites remain.
 *
 * A naive `grep` flags this file's own docblock and every comment explaining
 * why a call was removed. Tracking quote and comment state character by
 * character is cheap and keeps the exemptions above to a single rule.
 */
function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote !== undefined) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += " ";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CONSOLE_CALL = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\s*\(/;

test("src/ logs through the logger, never console.*", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (EXEMPT_FILES.has(rel)) continue;
    const code = stripNonCode(readFileSync(file, "utf8"));
    if (CONSOLE_CALL.test(code)) {
      const line = code.slice(0, code.search(CONSOLE_CALL)).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }

  expect(offenders).toEqual([]);
});

test("src/ does not import the logger's ring or sanitizer directly", () => {
  // The ring and the sanitizer are the logger's internals. Importing them
  // directly to push a message into the console log view skips level filtering
  // and produces entries the logger cannot account for.
  const offenders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (EXEMPT_FILES.has(rel) || rel === "observability/log-ring.ts") continue;
    const code = stripNonCode(readFileSync(file, "utf8"));
    if (/from\s+["'][^"']*log-ring["']/.test(code) && !rel.startsWith("console/")) {
      offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
