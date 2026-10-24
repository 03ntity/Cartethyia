import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type InstallTarget = "local" | "vps" | "docker";
export type InstallMode = "lite" | "full";
export type VpsTopology = "regular" | "nat";
export interface InstallRequest {
  target: InstallTarget;
  mode: InstallMode;
  topology?: VpsTopology;
  domain?: string;
  port: number;
  publicOrigin?: string;
  root: string;
  check: boolean;
  dryRun: boolean;
  noStart: boolean;
  skipDeps: boolean;
  noCaddy: boolean;
  provisionRedis: boolean;
  nonInteractive: boolean;
}
export const INSTALL_HELP = `Usage: install.sh --local|--vps|--docker --lite|--full [options]
  --regular|--nat          VPS topology (auto-detect when omitted)
  --domain <fqdn>          Public domain (required for Regular VPS)
  --port <1-65535>         Gateway/external forwarded port (default 12800)
  --public-origin <url>    Public URL (required for NAT and --no-caddy)
  --root <path>            Installation root
  --check                  Read-only dependency/config checks
  --dry-run                Print the plan without mutation
  --no-start               Configure/build but do not start
  --skip-deps              Skip dependency installation, not validation
  --no-caddy               Regular VPS with an external reverse proxy
  --provision-redis        Install and configure local Redis
  --non-interactive        Never prompt; require all target inputs`;
function defaultRoot(target: InstallTarget, env: NodeJS.ProcessEnv): string {
  if (env.CARTETHYIA_ROOT?.trim()) return resolve(env.CARTETHYIA_ROOT.trim());
  if (target === "vps") return "/opt/cartethyia";
  if (target === "docker") return process.cwd();
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Cartethyia", "app")
    : join(homedir(), ".local", "share", "Cartethyia", "app");
}
export function parseInstallArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): InstallRequest {
  let target: InstallTarget | undefined;
  let mode: InstallMode | undefined;
  let topology: VpsTopology | undefined;
  let domain: string | undefined;
  let publicOrigin: string | undefined;
  let root: string | undefined;
  let port = 12800;
  let portExplicit = false;
  const flags = { check: false, dryRun: false, noStart: false, skipDeps: false, noCaddy: false, provisionRedis: false, nonInteractive: false };
  const flagNames: Record<string, keyof typeof flags> = {
    "--check": "check",
    "--dry-run": "dryRun",
    "--no-start": "noStart",
    "--skip-deps": "skipDeps",
    "--no-caddy": "noCaddy",
    "--provision-redis": "provisionRedis",
    "--non-interactive": "nonInteractive",
  };
  const targets: Record<string, InstallTarget> = { "--local": "local", "--vps": "vps", "--docker": "docker" };
  const values: Record<string, (value: string) => void> = {
    "--domain": (value) => { domain = value; },
    "--public-origin": (value) => { publicOrigin = value; },
    "--root": (value) => { root = value; },
    "--port": (value) => { port = Number(value); portExplicit = true; },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (Object.hasOwn(targets, arg)) {
      const chosen = targets[arg]!;
      if (target && target !== chosen) throw new Error("Choose exactly one target: --local, --vps, or --docker");
      target = chosen;
    } else if (arg === "--lite" || arg === "--full") {
      const chosen = arg.slice(2) as InstallMode;
      if (mode && mode !== chosen) throw new Error("Choose exactly one database mode: --lite or --full");
      mode = chosen;
    } else if (arg === "--regular" || arg === "--nat") {
      const chosen = arg.slice(2) as VpsTopology;
      if (topology && topology !== chosen) throw new Error("Choose one VPS topology: --regular or --nat");
      topology = chosen;
    } else if (Object.hasOwn(values, arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values[arg]!(value);
    } else if (arg === "--help") {
      throw new Error(INSTALL_HELP);
    } else if (Object.hasOwn(flagNames, arg)) {
      flags[flagNames[arg]!] = true;
    } else throw new Error(`Unknown argument: ${arg}\n${INSTALL_HELP}`);
  }
  const interactive = !flags.nonInteractive && process.stdin.isTTY;
  target ??= interactive ? "local" : undefined;
  mode ??= interactive ? "lite" : undefined;
  if (!target || !mode) throw new Error("Target and mode are required. Use --local|--vps|--docker with --lite|--full.");
  if (topology && target !== "vps") throw new Error("--regular/--nat require --vps");
  if (flags.noCaddy && (target !== "vps" || topology !== "regular")) throw new Error("--no-caddy requires --vps --regular");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  if (domain !== undefined && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(domain)) throw new Error("--domain must be a valid FQDN");
  if (publicOrigin !== undefined) {
    let url: URL;
    try { url = new URL(publicOrigin); } catch { throw new Error("--public-origin must be an absolute HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--public-origin must be an HTTP(S) origin without credentials, path, query, or fragment");
    publicOrigin = url.origin;
  }
  if (target === "vps" && topology === "regular" && !domain && !flags.noCaddy) throw new Error("Regular VPS requires --domain, or --no-caddy with --public-origin");
  if (target === "vps" && topology === "nat" && (!portExplicit || !publicOrigin)) throw new Error("NAT VPS requires explicit --port and --public-origin");
  if (flags.noCaddy && !publicOrigin) throw new Error("--no-caddy requires --public-origin");
  const chosenRoot = resolve(root ?? defaultRoot(target, env));
  if (/\r|\n|\0/.test(chosenRoot)) throw new Error("--root contains an invalid character");
  if (flags.check && flags.dryRun) throw new Error("Choose only one of --check and --dry-run");
  return {
    target, mode, port, root: chosenRoot, ...flags,
    ...(topology ? { topology } : {}),
    ...(domain ? { domain } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}
export function buildInstallPlan(request: InstallRequest): readonly string[] {
  const steps = ["validate platform and privileges", "run read-only preflight"];
  if (!request.skipDeps && request.target !== "docker") steps.push("install missing target dependencies with Bun only");
  if (request.target !== "docker") steps.push("acquire or fast-forward the source checkout");
  if (request.mode === "full" && request.target !== "docker") steps.push("provision or verify PostgreSQL");
  if (request.provisionRedis && request.target !== "docker") steps.push("provision and enable Redis");
  if (request.target === "vps" && request.topology === "regular" && !request.noCaddy) steps.push("install and configure Caddy with verified release checksum");
  steps.push("merge configuration atomically without rotating secrets");
  steps.push(request.target === "docker" ? "validate Docker build context and Compose configuration" : "build dashboard, AOT, and compiled gateway");
  if (request.noStart) steps.push("skip application start");
  else if (request.target === "docker") steps.push("docker compose up --build -d");
  else if (request.target === "local") steps.push("start detached compiled gateway and wait for readiness");
  else if (request.target === "vps") steps.push("enable and start Cartethyia with systemd");
  steps.push("run doctor and report URL and management commands");
  if (request.target === "vps" && request.topology === "nat") steps.push("warn that provider port forwarding needs external verification");
  return steps;
}
