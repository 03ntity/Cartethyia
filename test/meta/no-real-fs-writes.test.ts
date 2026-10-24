/**
 * No test may write to the operator's real home directory.
 *
 * CLI-tool injectors (`src/console/cli-tools/injectors/*`) edit files owned
 * by the user: `~/.codex/config.toml`, `~/.claude/settings.json`,
 * `~/.cline/data/globalState.json`, and a dozen more. Those modules read
 * their paths lazily through `homeDir()` so a test can sandbox them by
 * stubbing `process.env.HOME` and `process.env.USERPROFILE` before the first
 * call. `test/console/cli-tool-lifecycle.test.ts` does exactly that.
 *
 * The failure mode this walker guards is a new test that imports an injector
 * (directly or transitively) but forgets the HOME override. The first time
 * it runs on a developer's machine it rewrites that developer's real
 * configuration file. Codex refuses to start; the operator has no idea what
 * happened. This has not happened in the suite yet, and the point of a
 * walker is to keep it that way.
 *
 * Rule: any test file that references `homedir()`, `USERPROFILE`, `AppData`,
 * `~/.codex`, `~/.claude`, `~/.cline`, `~/.opencode`, `~/.jcode`, or imports
 * from `src/console/cli-tools/injectors/*` must also:
 * - set `process.env.HOME` (and `USERPROFILE` on Windows) to a tmpdir path,
 * - or be explicitly allowlisted as read-only (asserts about which paths
 *   would be touched, no actual mutation).
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, sep } from "node:path";

const TEST_ROOTS: readonly string[] = ["test"];

/** Patterns that mean a test is touching real HOME paths. */
const HOME_PROBES: readonly RegExp[] = [
  /\bhomedir\s*\(/,
  /\bhomeDir\s*\(/,
  /process\.env\.(?:HOME|USERPROFILE)\b/,
  /process\.env\[\s*["'](?:HOME|USERPROFILE)["']\s*\]/,
  /~\/\.codex\b/,
  /~\/\.claude\b/,
  /~\/\.cline\b/,
  /~\/\.opencode\b/,
  /~\/\.jcode\b/,
  /\bAppData\b/,
];

/** Patterns that mean a HOME override is in effect for this file. */
const HOME_OVERRIDES: readonly RegExp[] = [
  /process\.env\.HOME\s*=/,
  /process\.env\.USERPROFILE\s*=/,
  /process\.env\[\s*["']HOME["']\s*\]\s*=/,
  /process\.env\[\s*["']USERPROFILE["']\s*\]\s*=/,
];

/** Imports of a cli-tool injector module are the other way to drag HOME in. */
const INJECTOR_IMPORT = /from\s+["'][^"']*\/cli-tools\/injectors\/[^"']+["']/;

/**
 * Test files that mention a HOME path only to assert something read-only
 * about it (that the injector would resolve to such-and-such path, that a
 * registry row names such-and-such file), with no actual write. A reviewer
 * who adds a file here must have read the file.
 */
const READ_ONLY_HOME_REFERENCES: Readonly<Record<string, string>> = {
  "test/console/cli-tool-injectors.test.ts": "introductory comment names ~/.codex and ~/.claude; the suite itself writes only inside mkdtemp",
  "test/meta/no-real-fs-writes.test.ts": "this walker file; its probe patterns name the paths it bans",
};

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
        if (name === "node_modules" || name === "fixtures") continue;
        stack.push(full);
      } else if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
        out.push(full);
      }
    }
  }
  return out;
}

function anyMatches(text: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

test("every test that touches a real HOME path also stubs HOME", () => {
  const violations: Array<{ file: string; probe: string }> = [];
  for (const root of TEST_ROOTS) {
    for (const file of walkTs(root)) {
      const rel = forwardSlash(file);
      const text = readFileSync(file, "utf8");
      const touchesHome = anyMatches(text, HOME_PROBES) || INJECTOR_IMPORT.test(text);
      if (!touchesHome) continue;
      if (anyMatches(text, HOME_OVERRIDES)) continue;
      if (READ_ONLY_HOME_REFERENCES[rel] !== undefined) continue;
      // Report which specific probe matched so the fix target is obvious.
      const probe = HOME_PROBES.find((pattern) => pattern.test(text))?.source
        ?? (INJECTOR_IMPORT.test(text) ? INJECTOR_IMPORT.source : "unknown");
      violations.push({ file: rel, probe });
    }
  }
  expect(violations).toEqual([]);
});

test("the read-only allowlist only names files that actually exist", () => {
  const stale: string[] = [];
  for (const file of Object.keys(READ_ONLY_HOME_REFERENCES)) {
    try {
      if (!statSync(file).isFile()) stale.push(file);
    } catch {
      stale.push(file);
    }
  }
  expect(stale).toEqual([]);
});
