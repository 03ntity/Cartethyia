/**
 * Remote-support tunnel service.
 *
 * The tunnel is launched by an external script rather than by spawning
 * `cloudflared`/`tailscale` directly, for one reason that matters: the script
 * hands the publisher to the OS session, so the tunnel is not a child of this
 * gateway. A gateway restart, a hot reload, or a Ctrl-C in the owning terminal
 * therefore cannot kill an operator's live remote-support session.
 *
 * This service never installs anything. A missing binary is reported as a
 * blocker with install guidance; downloading a third-party agent on the
 * operator's behalf is out of scope.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../config/package-paths";
import {
  REMOTE_SUPPORT_INSTALL_HINT,
  type RemoteSupportBlocker,
  type RemoteSupportStatus,
  type RemoteSupportTool,
} from "./contracts";

/** How long the launcher may take to report a URL before we stop waiting. */
const LAUNCH_TIMEOUT_MS = 40_000;

/** Cached install detection so we don't spawn `where` on every status poll. */
const installedCache = new Map<RemoteSupportTool, boolean>();

export interface RemoteSupportServiceConfig {
  /** Defaults to the gateway's configured port. */
  readonly port: number;
  /** Overridable for tests; defaults to the package root. */
  readonly scriptDir?: string;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
}

function scriptPath(config: RemoteSupportServiceConfig, name: string): string {
  const dir = config.scriptDir ?? join(PACKAGE_ROOT, "scripts");
  return join(dir, name);
}

function runScript(
  config: RemoteSupportServiceConfig,
  args: readonly string[],
): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const isWindows = process.platform === "win32";
  // Windows cannot spawn a `.cmd` directly — `spawn` rejects it with EINVAL
  // because a batch file is not an executable image. It has to be handed to
  // `cmd.exe /c`, which is also what lets the batch call `exit /b 3` and have
  // that code reach us as the child's status.
  const command = isWindows ? "cmd.exe" : "powershell";
  const fileName = isWindows ? "remote-support.cmd" : "remote-support.ps1";
  const file = scriptPath(config, fileName);
  const spawnArgs = isWindows
    ? ["/d", "/s", "/c", file, ...args]
    : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args];
  const child = spawn(command, spawnArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), LAUNCH_TIMEOUT_MS);
  child.on("error", reject);
  child.on("close", (status) => {
    clearTimeout(timer);
    resolve({ status: status ?? 1, stdout: `${stdout}${stderr}`.trim() });
  });
  return promise;
}

/**
 * `where`/`which` lookup, mirroring what the script does itself so the route
 * can answer `not_installed` with a clear message instead of a generic failure.
 */
function toolAvailable(tool: RemoteSupportTool): Promise<boolean> {
  const cached = installedCache.get(tool);
  if (cached !== undefined) return Promise.resolve(cached);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const command = process.platform === "win32" ? "where" : "which";
  const child = spawn(command, [tool], { stdio: "ignore", windowsHide: true });
  child.on("error", () => {
    installedCache.set(tool, false);
    resolve(false);
  });
  child.on("close", (status) => {
    const ok = status === 0;
    installedCache.set(tool, ok);
    resolve(ok);
  });
  return promise;
}

export interface RemoteSupportService {
  status(): Promise<RemoteSupportStatus>;
  start(tool: RemoteSupportTool, port?: number): Promise<RemoteSupportStatus>;
  stop(tool?: RemoteSupportTool): Promise<RemoteSupportStatus>;
}

export function createRemoteSupportService(config: RemoteSupportServiceConfig): RemoteSupportService {
  const port = config.port;

  /**
   * Install state for both publishers, cached per process.
   *
   * Every status carries it so the card can show "not installed" without the
   * browser probing on its own — but the probe is `where`/`which`, which is a
   * process spawn, so it is memoised here rather than run on each poll.
   */
  async function detectInstalled(): Promise<Readonly<Record<RemoteSupportTool, boolean>>> {
    return {
      cloudflared: await toolAvailable("cloudflared"),
      tailscale: await toolAvailable("tailscale"),
    } as const;
  }

  async function readStatus(blocker: RemoteSupportBlocker | null = null, message: string | null = null): Promise<RemoteSupportStatus> {
    const result = await runScript(config, ["status"]);
    const text = result.stdout;
    const active: RemoteSupportTool | null = text.includes("cloudflared running")
      ? "cloudflared"
      : text.includes("tailscale running")
        ? "tailscale"
        : null;
    let url: string | null = null;
    if (active !== null) {
      const urlResult = await runScript(config, ["url"]);
      const candidate = urlResult.stdout.trim().split(/\s+/).find((line) => line.startsWith("https://"));
      url = candidate ?? null;
    }
    const installed = await detectInstalled();
    return { active, url, blocker, message, port, installed };
  }

  return {
    async status() {
      return await readStatus();
    },

    async start(tool, requestedPort) {
      if (process.platform !== "win32") {
        return {
          active: null,
          url: null,
          blocker: "unsupported_platform",
          message: "Remote support is currently scripted for Windows hosts only.",
          port,
          installed: { cloudflared: false, tailscale: false },
        };
      }
      const launcher = scriptPath(config, "remote-support.cmd");
      if (!existsSync(launcher)) {
        return {
          active: null,
          url: null,
          blocker: "launch_failed",
          message: `Launcher not found: ${launcher}`,
          port,
          installed: await detectInstalled(),
        };
      }
      if (!(await toolAvailable(tool))) {
        return {
          active: null,
          url: null,
          blocker: "not_installed",
          message: REMOTE_SUPPORT_INSTALL_HINT[tool],
          port,
          installed: await detectInstalled(),
        };
      }
      const target = requestedPort ?? port;
      const result = await runScript(config, ["start", tool, String(target)]);
      if (result.status !== 0 && !result.stdout.includes("started")) {
        return {
          active: null,
          url: null,
          blocker: "launch_failed",
          message: result.stdout || `Failed to start ${tool}.`,
          port,
          installed: await detectInstalled(),
        };
      }
      return await readStatus();
    },

    async stop(tool) {
      await runScript(config, tool === undefined ? ["stop"] : ["stop", tool]);
      return await readStatus();
    },
  };
}
