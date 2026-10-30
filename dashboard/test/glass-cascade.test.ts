/**
 * The glass cascade lock.
 *
 * Every glass surface is driven at runtime by the Clarity/Depth sliders on the
 * Customization page: `applyCustomization` publishes `--blur-cards` /
 * `--blur-cards-depth` on `<html>`, and CSS turns them into
 * `backdrop-filter: blur(calc((100 - var(--blur-cards)) * …))`. That arithmetic
 * cannot be written as a fixed utility, so these rules live in the authored
 * sheets — which land in `@layer base`.
 *
 * Tailwind v4 declares `@layer utilities` *after* `@layer base`, and a later
 * layer wins the cascade regardless of specificity. So a plain
 * `backdrop-filter` here is silently beaten by the utilities layer on a real
 * build, and every glass surface renders with no blur at all. It reads as
 * "the transparency setting is ignored", because the `color-mix` background —
 * already `!important`, for the same reason — still paints correctly.
 *
 * It never reproduced under `bun run dev`: the dev server injects CSS without
 * the production layer ordering, so the blur worked locally and only vanished
 * once built. That is why this has to be locked at the source, since no
 * browser-less test sees the cascade.
 *
 * If a rule here genuinely no longer needs `!important` (say the sheets move
 * into `@layer utilities`), remove it from {@link GLASS_RULES} in the same
 * commit and say why — do not just weaken the assertion.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_ROOT = join(import.meta.dir, "..");
const STYLES = join(DASHBOARD_ROOT, "src", "styles");

/**
 * The glass declarations, by file. Each value is the fragment that must appear
 * with `!important` on `backdrop-filter` for that rule to survive the cascade.
 */
const GLASS_RULES: ReadonlyArray<{ file: string; selector: string }> = [
  { file: "base.css", selector: ".card-glass" },
  { file: "base.css", selector: ".glass" },
  { file: "app.css", selector: ".composer-glass" },
  { file: "app.css", selector: ".user-card-content" },
];

/**
 * The blur expression shared by every runtime-driven surface. Its presence is
 * what makes a rule one of *these* rules rather than an ordinary filter.
 */
const BLUR_EXPRESSION = "blur(calc((100 - var(--blur-cards";

/** Every `backdrop-filter` declaration in a rule whose body uses the runtime blur math. */
function unprotectedDeclarations(css: string): string[] {
  const offenders: string[] = [];
  // Split into top-level rule blocks: "selector { body }"
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(css)) !== null) {
    const body = match[2] ?? "";
    if (!body.includes(BLUR_EXPRESSION) && !body.includes("card-glass-depth")) continue;
    // Both spellings must be protected: Chromium 154+ dropped support for the
    // `-webkit-` alias, so the unprefixed property is the one that renders.
    for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
      const declaration = new RegExp(`${property}\\s*:\\s*([^;}]+)`).exec(body);
      if (declaration === null) continue;
      if (!/!important/.test(declaration[1] ?? "")) {
        offenders.push(`${(match[1] ?? "").trim()} { ${property}: ${(declaration[1] ?? "").trim()} }`);
      }
    }
  }
  return offenders;
}

describe("glass cascade", () => {
  test("every runtime blur declaration is protected from the utilities layer", () => {
    const offenders: string[] = [];
    for (const sheet of ["base.css", "app.css"]) {
      const css = readFileSync(join(STYLES, sheet), "utf8");
      offenders.push(...unprotectedDeclarations(css).map((entry) => `${sheet}: ${entry}`));
    }
    // The message is the fix: these rules sit in `@layer base`, so they lose to
    // `@layer utilities` unless the declaration is `!important`.
    expect(offenders).toEqual([]);
  });

  test("keeps the standard filter last so production retains it", () => {
    for (const sheet of ["base.css", "app.css"]) {
      const css = readFileSync(join(STYLES, sheet), "utf8");
      const block = /([^{}]+)\{([^{}]*)\}/g;
      let match: RegExpExecArray | null;
      while ((match = block.exec(css)) !== null) {
        const body = match[2] ?? "";
        const prefixedIndex = body.indexOf("-webkit-backdrop-filter:");
        const standardMatch = /(?<!-webkit-)backdrop-filter\s*:/.exec(body);
        if (prefixedIndex < 0 || standardMatch === null) continue;

        expect(
          standardMatch.index,
          `${sheet}: ${(match[1] ?? "").trim()} must put the standard property last`,
        ).toBeGreaterThan(prefixedIndex);
      }
    }
  });

  test("the locked glass rules still exist", () => {
    // Guards the guard: if a rule is renamed or moved, the suite above would
    // pass vacuously on an empty file set.
    for (const { file, selector } of GLASS_RULES) {
      const css = readFileSync(join(STYLES, file), "utf8");
      const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*backdrop-filter`).exec(
        css,
      );
      expect(rule, `${selector} in ${file} must still carry a backdrop-filter`).not.toBeNull();
    }
  });
});
