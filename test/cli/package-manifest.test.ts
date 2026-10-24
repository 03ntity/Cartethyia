/**
 * The published tarball must carry every module it imports.
 *
 * 2.5.6 shipped `scripts/cli/` but not the modules the same refactor moved out
 * of it — `scripts/build/compile.ts` and `scripts/health.ts` — so `carte` died
 * on `Cannot find module '../build/compile'`, `cartethyia doctor` on
 * `Cannot find module '../health'`, and `npm install -g` on an `install`
 * lifecycle script naming `scripts/install/install.ts`. Typecheck and every
 * suite run from the checkout, where those files are always present, so nothing
 * noticed. This test asks the packer instead of the filesystem.
 *
 * `bun pm pack --dry-run --ignore-scripts` answers "what would npm publish?"
 * with the packer's own `files` semantics, skips `prepack` (the dashboard build)
 * and writes no tarball, so the check costs milliseconds.
 *
 * Credit: adapted verbatim from the proposal in risunCodex/Cartethyia PR #3 by
 * @elliottophellia, after the same packaging regression shipped in 2.5.6-2.5.8.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

/** The package's own source trees; `dist/dashboard/` is a bundled artifact. */
const SHIPPED_SOURCE = /^(?:src|scripts)\/.*\.(?:ts|tsx|mts|js|cjs|mjs)$/;

/**
 * Ways a relative specifier can resolve inside the package. Extensionless
 * specifiers resolve to a sibling file first, then to a directory index.
 */
const RESOLUTIONS = ["", ".ts", ".tsx", ".mts", ".js", ".cjs", ".mjs", "/index.ts", "/index.js", "/index.cjs"];

/** CommonJS `require("x")`, which `Bun.Transpiler.scan` does not report. */
const REQUIRE_CALL = /\brequire\s*\(\s*(["'])([^"'\n]+)\1/g;

/** Lifecycle scripts npm runs from inside the installed package. */
const INSTALL_LIFECYCLES = ["preinstall", "install", "postinstall"] as const;

interface Manifest {
  readonly dependencies: Record<string, string>;
  readonly bin: Record<string, string>;
  readonly scripts: Record<string, string>;
}

function pack(): { readonly files: Set<string>; readonly manifest: Manifest } {
  const result = Bun.spawnSync(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  // A failed pack must fail the test, not read as "nothing ships, nothing to
  // check" — an empty file set would make every assertion below vacuous.
  expect(result.exitCode).toBe(0);
  const files = new Set<string>();
  for (const line of result.stdout.toString().split(/\r?\n/)) {
    // `packed <size> <path>`; the size is a single token (`4.1KB`, `478B`).
    const packed = /^packed\s+\S+\s+(.+)$/.exec(line);
    if (packed) files.add(packed[1]!.trim());
  }
  expect(files.size).toBeGreaterThan(0);
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as Manifest;
  return { files, manifest };
}

/**
 * Removes `//` and block comments, leaving string and template literals intact.
 *
 * `Bun.Transpiler.scan` already ignores comments, so this exists only for the
 * `require(` pass it does not report. Prose in a docstring that happens to quote
 * a path must not be read as a module reference.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index]!;
        if (inner === "\\") {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === char) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Every module specifier a shipped file imports: static imports, dynamic
 * imports, re-exports, and CommonJS requires. Type-only imports are omitted by
 * the scanner, which is correct — they are erased before the package runs.
 */
function importsOf(source: string): string[] {
  const scanned = new Bun.Transpiler({ loader: "ts" }).scan(source).imports.map((entry) => entry.path);
  const required = [...stripComments(source).matchAll(REQUIRE_CALL)].map((match) => match[2]!);
  return [...scanned, ...required];
}

/** The package a bare specifier imports, with subpaths removed. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

/**
 * Whether the runtime resolves the specifier itself: `node:`/`bun:` prefixes,
 * the bare `bun` namespace, and core modules named without a prefix (`path`,
 * `fs/promises`) are all built in, not installed.
 */
function isBuiltin(specifier: string): boolean {
  if (specifier === "bun" || specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  return builtinModules.includes(packageName(specifier));
}

function resolvesTo(specifier: string, from: string, shipped: ReadonlySet<string>): boolean {
  const base = join(from, "..", specifier).replaceAll("\\", "/");
  return RESOLUTIONS.some((suffix) => shipped.has(`${base}${suffix}`));
}

test("every relative import of a shipped module resolves inside the package", () => {
  const { files } = pack();
  const dangling: string[] = [];
  for (const file of files) {
    if (!SHIPPED_SOURCE.test(file)) continue;
    for (const specifier of importsOf(readFileSync(join(PROJECT_ROOT, file), "utf8"))) {
      if (isRelative(specifier) && !resolvesTo(specifier, file, files)) dangling.push(`${file} -> ${specifier}`);
    }
  }
  expect(dangling).toEqual([]);
});

test("every bare import of a shipped module is a declared runtime dependency", () => {
  const { files, manifest } = pack();
  const undeclared: string[] = [];
  for (const file of files) {
    if (!SHIPPED_SOURCE.test(file)) continue;
    for (const specifier of importsOf(readFileSync(join(PROJECT_ROOT, file), "utf8"))) {
      if (isRelative(specifier) || isBuiltin(specifier)) continue;
      // A devDependency is not installed for `npm install -g cartethyia`, so
      // importing one from a shipped module breaks the installed package.
      if (!(packageName(specifier) in manifest.dependencies)) undeclared.push(`${file} -> ${specifier}`);
    }
  }
  expect(undeclared).toEqual([]);
});

test("the launchers npm exposes and every install lifecycle target ship", () => {
  const { files, manifest } = pack();
  const missing: string[] = [
    ...Object.values(manifest.bin).filter((path) => !files.has(path)),
    ...INSTALL_LIFECYCLES.flatMap((name) => {
      const script = manifest.scripts[name];
      if (script === undefined) return [];
      // Lifecycle scripts run from inside the installed package, so any repo
      // path they name has to be part of it.
      return (script.match(/[\w@./-]+\.(?:ts|tsx|js|cjs|mjs|sh)/g) ?? []).filter((path) => !files.has(path));
    }),
  ];
  expect(missing).toEqual([]);
});
