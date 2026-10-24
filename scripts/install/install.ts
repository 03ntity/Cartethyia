// dynamic-import-ok: installer plan runner. Every `await import("../cli/*")`
// lazy-loads a gateway-side module (port probe, instance attach, env reader,
// health runner) only when the installer actually needs it; a static import
// would drag the gateway surface into every `cartethyia install --help` or
// dry-run.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { INSTALL_HELP, buildInstallPlan, parseInstallArgs, type InstallRequest, type VpsTopology } from "./plan";
import { acquireInstallLock, hostExecutor, sudoExecutor, type HostExecutor } from "./host";
import { installLocal } from "./local";
import { installVps } from "./vps";
import { installDocker } from "./docker";

export interface InstallPreflightDependencies {
  readonly probePort: (port: number) => Promise<{ readonly status: "free" | "blocked"; readonly code?: string }>;
  readonly ownedGateway: (port: number, root: string) => Promise<boolean>;
}

const defaultPreflight: InstallPreflightDependencies = {
  async probePort(port) {
    const { probeListenPort } = await import("../cli/port");
    return await probeListenPort(port);
  },
  async ownedGateway(port, root) {
    const previous = process.env.CARTETHYIA_CONFIG_DIR;
    try {
      process.env.CARTETHYIA_CONFIG_DIR = root;
      const { attachGateway, ensureDrainToken } = await import("../cli/instance");
      return (await attachGateway(port, ensureDrainToken())) !== null;
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
      else process.env.CARTETHYIA_CONFIG_DIR = previous;
    }
  },
};

async function detectTopology(host: HostExecutor): Promise<VpsTopology | null> {
  try {
    const local = await host.run(["sh", "-c", "ip -4 addr show scope global | awk '/inet /{print $2}' | cut -d/ -f1 | head -1"], { timeoutMs: 10_000 });
    const localIp = local.stdout.trim();
    const egress = await host.run(["python3", "-c", "import urllib.request; print(urllib.request.urlopen('https://api.ipify.org', timeout=8).read().decode())"], { timeoutMs: 12_000 });
    const publicIp = egress.stdout.trim();
    if (!localIp || !publicIp) return null;
    if (localIp === publicIp) return "regular";
    if (/^(10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(localIp)) return "nat";
    return null;
  } catch {
    return null;
  }
}
async function confirmPlan(request: InstallRequest): Promise<void> {
  console.log(buildInstallPlan(request).map((step, index) => `${index + 1}. ${step}`).join("\n"));
  if (request.nonInteractive || !process.stdin.isTTY) return;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("Continue with these system changes? [y/N]: ");
    if (answer.trim().toLowerCase() !== "y") throw new Error("Installation cancelled; no changes were requested");
  } finally {
    rl.close();
  }
}
export async function install(
  request: InstallRequest,
  host: HostExecutor = hostExecutor,
  preflight: InstallPreflightDependencies = defaultPreflight,
): Promise<void> {
  if (request.dryRun) {
    console.log(buildInstallPlan(request).map((step, index) => `${index + 1}. ${step}`).join("\n"));
    return;
  }
  if (request.target === "vps" && !request.topology) {
    const detected = await detectTopology(host);
    if (detected) request.topology = detected;
    else if (!request.nonInteractive && process.stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await rl.question("Could not detect VPS topology. Enter regular or nat: ")).trim();
        if (answer !== "regular" && answer !== "nat") throw new Error("VPS topology must be regular or nat");
        request.topology = answer;
      } finally { rl.close(); }
    } else throw new Error("Could not determine VPS topology; specify --regular or --nat");
    if (request.topology === "regular" && !request.domain && !request.noCaddy) throw new Error("Regular VPS requires --domain");
    if (request.topology === "nat" && !request.publicOrigin) throw new Error("NAT VPS requires --public-origin and an explicit forwarded --port");
  }
  if (request.check) {
    const { readEnvFile } = await import("../cli/env");
    const { runHealthChecks } = await import("../cli/health");
    const { join } = await import("node:path");
    const env = await readEnvFile(join(request.root, ".env"));
    const results = await runHealthChecks({ target: request.target, env, envPath: join(request.root, ".env"), port: request.port, phases: ["preflight", "configuration"] });
    if (!(await host.exists(join(request.root, ".env")))) {
      for (const item of results) {
        if (item.phase === "configuration" && item.id !== "redis") {
          item.status = "warn";
          item.summary = `Not configured yet: ${item.summary}`;
        }
      }
    }
    console.log(JSON.stringify(results, null, 2));
    if (results.some((item) => item.phase === "preflight" && item.required && item.status === "fail")) process.exitCode = 1;
    return;
  }
  if (request.target !== "docker") {
    const port = await preflight.probePort(request.port);
    if (port.status === "blocked") {
      const owned = port.code === "EADDRINUSE" && await preflight.ownedGateway(request.port, request.root);
      if (!owned) {
        const { blockedPortMessage, listenPortErrorMessage } = await import("../cli/port");
        throw new Error(port.code === "EADDRINUSE"
          ? `Installation cannot use the requested custom port. ${blockedPortMessage(request.port)}`
          : listenPortErrorMessage(request.port, port));
      }
    }
  }
  if (request.target === "vps") {
    if (host.platform !== "linux") throw new Error("VPS installation requires Linux with apt and systemd");
    const privilege = await host.run(["sh", "-c", "id -u"]);
    if (privilege.stdout.trim() !== "0") {
      const sudo = await host.run(["sudo", "-n", "true"]).catch(() => null);
      if (sudo === null) throw new Error("VPS installation requires root or non-interactive sudo; rerun with sufficient privileges");
      host = sudoExecutor(host);
    }
    await host.run(["systemctl", "--version"]);
    await host.run(["apt-get", "--version"]);
    if (request.topology === "regular" && !request.noCaddy) {
      const dns = await host.run(["getent", "hosts", request.domain!], { timeoutMs: 30_000 });
      if (!dns.stdout.trim()) throw new Error(`${request.domain} does not resolve; point DNS at this VPS before installation`);
      const egress = await host.run(["python3", "-c", "import urllib.request; print(urllib.request.urlopen('https://api.ipify.org', timeout=8).read().decode())"], { timeoutMs: 12_000 });
      if (!dns.stdout.split(/\s+/).includes(egress.stdout.trim())) throw new Error(`${request.domain} does not resolve to this VPS public address ${egress.stdout.trim()}`);
    }
  } else if (request.target === "local" && host.platform !== "linux" && host.platform !== "darwin") {
    throw new Error("Local installer supports Linux and macOS only");
  }
  if (request.target === "local" && host.platform === "linux" && !request.skipDeps) {
    const privilege = await host.run(["sh", "-c", "id -u"]);
    if (privilege.stdout.trim() !== "0") {
      const sudo = await host.run(["sudo", "-n", "true"]).catch(() => null);
      if (sudo === null) throw new Error("Local dependency installation requires root or non-interactive sudo; use --skip-deps with dependencies already installed");
      host = sudoExecutor(host);
    }
    await host.run(["apt-get", "--version"]);
  } else if (request.target === "local" && host.platform === "darwin") await host.run(["brew", "--version"]);
  await confirmPlan(request);
  const release = await acquireInstallLock(request.root);
  try {
    if (request.target === "local") await installLocal(request, host);
    else if (request.target === "vps") await installVps(request, host);
    else await installDocker(request, host);
  } finally {
    await release();
  }
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) console.log(INSTALL_HELP);
    else await install(parseInstallArgs(args));
  } catch (error) {
    console.error(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
