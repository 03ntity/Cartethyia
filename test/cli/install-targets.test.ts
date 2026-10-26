import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installDocker } from "../../scripts/install/docker";
import type { HostExecutor, HostResult } from "../../scripts/install/host";
import { parseInstallArgs } from "../../scripts/install/plan";
import { installVps } from "../../scripts/install/vps";
import { mkdir } from "node:fs/promises";
import type { HealthDependencies } from "../../scripts/cli/health";
import { statSync } from "node:fs";

async function sandbox(): Promise<string> { return mkdtemp(join(tmpdir(), "carte-docker-test-")); }

/**
 * Rewrites a host-absolute path into the sandbox.
 *
 * The VPS installer writes unit files and Caddy config to real system paths
 * (`/etc/systemd/system/cartethyia.service`, `/etc/caddy/Caddyfile`). A test
 * that let those through hit `EACCES` on any non-root runner — CI runs as an
 * unprivileged user, so three tests failed for a permission the code under
 * test does not depend on.
 *
 * Paths already inside the sandbox must pass through untouched: the installer
 * probes `<root>/.git` to decide whether it is looking at a checkout, and
 * rewriting that made the probe miss and every VPS test fail with "is not a
 * Cartethyia checkout". Only system paths are redirected. The assertions are
 * on which commands ran, not on what reached disk, so nothing they check is
 * weakened.
 */
function contained(root: string, path: string): string {
  // A Windows path never starts with "/", and a sandbox path already sits
  // under `root`; both are left alone.
  if (!path.startsWith("/") || (root !== "" && path.startsWith(root))) return path;
  return join(root, "rootfs", path.replace(/^\/+/, ""));
}

function host(calls: string[][], root = ""): HostExecutor {
  return {
    platform: "linux",
    async exists(path) { try { statSync(root ? contained(root, path) : path); return true; } catch { return false; } },
    async writeAtomic(path, content) { await Bun.write(root ? contained(root, path) : path, content); },
    async run(args): Promise<HostResult> {
      calls.push([...args]);
      if (args[0] === "false" || (args[0] === "bun" && args.includes("build") && process.env.CARTE_TEST_BUILD_FAIL === "1")) throw new Error("command failed");
      if (args[0] === "getent") return { code: 0, stdout: "203.0.113.10 app.example.com", stderr: "" };
      if (args[0] === "python3") return { code: 0, stdout: "203.0.113.10\n", stderr: "" };
      if (args[0] === "dpkg") return { code: 0, stdout: "amd64\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}
const healthy: HealthDependencies = {
  dockerCompose: async () => true,
  postgres: async () => undefined,
  redis: async () => undefined,
  tcp: async () => ({ success: true }),
  ready: async () => null,
  writable: async () => true,
  exists: async () => true,
};
test("Docker Lite configures in-memory Redis and Compose without host package installation", async () => {
  const root = await sandbox();
  const calls: string[][] = [];
  try {
    for (const file of ["Dockerfile", "docker-compose.yml", "docker-entrypoint.sh", "package.json"]) await writeFile(join(root, file), "test");
    await installDocker(parseInstallArgs(["--non-interactive", "--docker", "--lite", "--root", root, "--no-start"]), host(calls), {
      dockerCompose: async () => true,
      postgres: async () => undefined,
      redis: async () => undefined,
      tcp: async () => ({ success: true }),
      ready: async () => null,
      writable: async () => true,
      exists: async () => true,
    });
    const env = await Bun.file(join(root, ".env")).text();
    expect(env).toContain("CARTETHYIA_DB_MODE=lite");
    expect(env).toContain("CARTETHYIA_REDIS_URL=");
    expect(calls.some((args) => ["apt-get", "brew", "npm"].includes(args[0]!))).toBe(false);
    expect(calls.some((args) => args.includes("caddy"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Docker Full refuses to provision a silent PostgreSQL service", async () => {
  const root = await sandbox();
  try {
    for (const file of ["Dockerfile", "docker-compose.yml", "docker-entrypoint.sh", "package.json"]) await writeFile(join(root, file), "test");
    await expect(installDocker(parseInstallArgs(["--non-interactive", "--docker", "--full", "--root", root, "--no-start"]), host([]))).rejects.toThrow("external DATABASE_URL");
    expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NAT Lite builds and enables systemd without PostgreSQL or Caddy", async () => {
  const root = await sandbox();
  const calls: string[][] = [];
  try {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "data"), { recursive: true });
    const request = parseInstallArgs(["--non-interactive", "--vps", "--nat", "--lite", "--port", "8080", "--public-origin", "https://app.example.com:8080", "--root", root, "--no-start"]);
    await installVps(request, host(calls, root), healthy);
    expect(calls.some((args) => args.includes("postgresql"))).toBe(false);
    expect(calls.some((args) => args.includes("caddy"))).toBe(false);
    expect(calls.some((args) => args[0] === "systemctl" && args.includes("enable"))).toBe(true);
    expect(calls.some((args) => args[0] === "systemctl" && args.includes("restart"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Regular VPS verifies DNS and installs Caddy before enabling the app", async () => {
  const root = await sandbox();
  const calls: string[][] = [];
  try {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "data"), { recursive: true });
    const request = parseInstallArgs(["--non-interactive", "--vps", "--regular", "--lite", "--domain", "app.example.com", "--root", root, "--no-start"]);
    await installVps(request, host(calls, root), healthy);
    expect(calls.some((args) => args[0] === "getent")).toBe(true);
    expect(calls.some((args) => args.includes("caddy"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Full VPS provisions PostgreSQL without npm and preserves the generated URL", async () => {
  const root = await sandbox();
  const calls: string[][] = [];
  try {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "data"), { recursive: true });
    const request = parseInstallArgs(["--non-interactive", "--vps", "--nat", "--full", "--port", "8080", "--public-origin", "https://app.example.com:8080", "--root", root, "--no-start"]);
    await installVps(request, host(calls, root), healthy);
    const env = await Bun.file(join(root, ".env")).text();
    expect(env).toContain("DATABASE_URL=postgres://cartethyia:");
    expect(calls.some((args) => args.includes("createdb"))).toBe(true);
    expect(calls.some((args) => args[0] === "npm" || args[0] === "node")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
