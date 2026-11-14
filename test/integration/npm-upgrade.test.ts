/**
 * Opt-in consumer rehearsal: requires npm registry access and a real build.
 *
 * Gated behind `CARTETHYIA_TEST_NPM_UPGRADE=1` because it exercises the npm
 * registry as much as the code: the rehearsal downloads a published release
 * through whatever network the host has, and a sandboxed or throttled egress
 * (ping succeeds, tarball fetches stall for minutes) turns it into a
 * 12-minute timeout that says nothing about the upgrade path. Release
 * pipelines set the variable; ordinary suite runs skip it.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const optedIn = process.env.CARTETHYIA_TEST_NPM_UPGRADE === "1";
const rehearsal = optedIn ? test : test.skip;

rehearsal("an npm upgrade from 2.5.4 succeeds from the packed tarball", () => {
  const root = mkdtempSync(join(tmpdir(), "cartethyia-npm-upgrade-test-"));
  const project = join(import.meta.dir, "..", "..");
  const run = (args: string[]) => {
    const result = spawnSync("npm", args, {
      cwd: project,
      encoding: "utf8",
      timeout: 600_000,
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  try {
    run(["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "cartethyia@2.5.4"]);
    const manifestAt = () => join(root, "node_modules", "cartethyia", "package.json");
    expect(JSON.parse(readFileSync(manifestAt(), "utf8")).version).toBe("2.5.4");
    run(["pack", "--pack-destination", root]);
    const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
    run([
      "install",
      "--prefix",
      root,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(root, `cartethyia-${version}.tgz`),
    ]);
    expect(JSON.parse(readFileSync(manifestAt(), "utf8")).version).toBe(version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 1_800_000);
