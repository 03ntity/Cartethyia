/**
 * Dynamic imports in shipped code must be deliberate, not accidental.
 *
 * `await import("<literal>")` with a string-literal specifier is nearly
 * always convertible to a static `import` at the top of the file. Static
 * imports fail at build time if the target does not resolve, participate in
 * the package-manifest tarball walk, and let the reader see every dependency
 * of a module in one place.
 *
 * There are, however, three deliberate shapes the gateway uses dynamic
 * imports for:
 *
 * 1. **Lazy registry.** `src/providers/default-registry.ts` and
 *    `src/providers/integrations/buddy/capabilities.ts` are maps of
 *    provider id to `async () => (await import("..."))`. Loading every
 *    integration at process start would pay for providers nobody uses.
 * 2. **CLI command dispatch.** `scripts/cli/main.ts` and the admin dispatcher
 *    lazy-load each subcommand so that `cartethyia --help` does not drag the
 *    whole gateway and its database driver into memory.
 * 3. **Cycle breaks.** A handful of modules in the provider tree reach into
 *    siblings that transitively depend on them; a dynamic import at the one
 *    call site is cheaper than refactoring the whole dependency graph.
 *
 * This walker makes those shapes explicit. Each dynamic import either has a
 * `// dynamic-import: <reason>` comment on the preceding non-blank line (for
 * one-off sites) or the file carries a `// dynamic-import-ok: <reason>`
 * banner near its top (for files that are deliberately lazy-registry style).
 * Anything else fails here, and the message names the file and line so the
 * reviewer can either static-ify the import or document why it stays dynamic.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

/** Shipped trees scanned by this walker (tracked by package.json `files`). */
const SHIPPED_ROOTS: readonly string[] = [
  "src",
  join("scripts", "cli"),
  join("scripts", "build"),
  join("scripts", "install"),
  join("scripts", "tools"),
];

const DYNAMIC_IMPORT_PATTERN = /await\s+import\s*\(\s*(["'])([^"']+)\1/g;
const PER_LINE_COMMENT = /\/\/\s*dynamic-import:/;
const FILE_LEVEL_BANNER = /\/\/\s*dynamic-import-ok:/;

function forwardSlash(path: string): string {
  return path.split(sep).join("/");
}

function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(current, name);
      let kind: Stats;
      try {
        kind = statSync(full);
      } catch {
        continue;
      }
      if (kind.isDirectory()) {
        if (name === "node_modules" || name === ".codegen-stamp") continue;
        stack.push(full);
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        out.push(full);
      }
    }
  }
  return out;
}

interface DynamicImportSite {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

/** Window of lines above a dynamic import to search for the escape comment. */
const COMMENT_WINDOW_LINES = 8;

/**
 * A single `// dynamic-import: <reason>` comment above a block of dynamic
 * imports (a `switch` by wire family, a contiguous lazy-boot sequence)
 * covers every call within COMMENT_WINDOW_LINES below it.
 */
function hasCommentAbove(lines: readonly string[], index: number): boolean {
  const start = Math.max(0, index - COMMENT_WINDOW_LINES);
  for (let i = index - 1; i >= start; i -= 1) {
    const current = lines[i];
    if (current !== undefined && PER_LINE_COMMENT.test(current)) return true;
  }
  return false;
}

function collectViolations(): DynamicImportSite[] {
  const violations: DynamicImportSite[] = [];
  for (const root of SHIPPED_ROOTS) {
    for (const file of walkTs(root)) {
      const text = readFileSync(file, "utf8");
      // File-level banner anywhere in the file whitelists every dynamic
      // import below. The banner itself documents why the file is lazy.
      if (FILE_LEVEL_BANNER.test(text)) continue;

      const lines = text.split(/\r?\n/);
      DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
      for (const match of text.matchAll(DYNAMIC_IMPORT_PATTERN)) {
        const specifier = match[2];
        if (specifier === undefined) continue;
        const offset = match.index ?? 0;
        const lineIndex = text.slice(0, offset).split(/\r?\n/).length - 1;
        const own = lines[lineIndex];
        if (own !== undefined && PER_LINE_COMMENT.test(own)) continue;
        if (hasCommentAbove(lines, lineIndex)) continue;
        violations.push({
          file: forwardSlash(relative(".", file)),
          line: lineIndex + 1,
          specifier,
        });
      }
    }
  }
  return violations;
}

test("every dynamic import in shipped code has a deliberate escape-hatch", () => {
  const violations = collectViolations();
  if (violations.length > 0) {
    const formatted = violations
      .map(({ file, line, specifier }) => `  ${file}:${line} -> import("${specifier}")`)
      .join("\n");
    throw new Error(
      `Dynamic imports without an escape-hatch comment:\n${formatted}\n\n` +
        "Fix: either convert to a static `import` at the top of the file, or " +
        "add `// dynamic-import: <reason>` on the line above the call. Files " +
        "that are deliberately lazy-registry style (default-registry, buddy " +
        "capabilities) carry a `// dynamic-import-ok: <reason>` banner near " +
        "the top of the file.",
    );
  }
  expect(violations).toEqual([]);
});
