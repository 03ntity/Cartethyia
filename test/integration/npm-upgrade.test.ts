/** Opt-in consumer rehearsal: requires npm registry access and a real build. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an npm upgrade from 2.5.4 succeeds from the packed tarball", () => {
  const root = mkdtempSync(join(tmpdir(), "cartethyia-npm-upgrade-test-"));
  const project = join(import.meta.dir, "..", "..");
  const run = (args: string[]) => {
    const result = spawnSync("npm", args, {
      cwd: project,
      encoding: "utf8",
      timeout: 180_000,
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  try {
    run(["install", "--prefix", root, "--ignore-scripts", "cartethyia@2.5.4"]);
    const manifestAt = () => join(root, "node_modules", "cartethyia", "package.json");
    expect(JSON.parse(readFileSync(manifestAt(), "utf8")).version).toBe("2.5.4");
    run(["pack", "--pack-destination", root]);
    const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version;
    run(["install", "--prefix", root, "--ignore-scripts", join(root, `cartethyia-${version}.tgz`)]);
    expect(JSON.parse(readFileSync(manifestAt(), "utf8")).version).toBe(version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
