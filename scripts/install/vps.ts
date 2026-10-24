import { join } from "node:path";
import { readEnvFile } from "../cli/env";
import { runHealthChecks, hasRequiredFailure, skippedRuntimeCheck, type HealthDependencies } from "../health";
import { assertModeChangeAllowed, ensureEncryptionKey, writeEnvAtomic, prepareStateDirectories } from "./config";
import { hostExecutor, type HostExecutor } from "./host";
import { installDependencies, prepareSource, provisionPostgres, provisionRedis } from "./runtime";
import type { InstallRequest } from "./plan";

const CADDY_VERSION = "2.9.1";
function serviceUnit(request: InstallRequest, localPostgres: boolean): string {
  return `[Unit]\nDescription=Cartethyia AI gateway\nAfter=network-online.target${localPostgres ? " postgresql.service" : ""}\nWants=network-online.target${localPostgres ? "\nRequires=postgresql.service" : ""}\n\n[Service]\nType=simple\nWorkingDirectory=${request.root}\nEnvironmentFile=${request.root}/.env\nExecStart=${join(request.root, "dist", "cartethyia")}\nRestart=always\nRestartSec=3\nKillSignal=SIGTERM\nTimeoutStopSec=45\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${join(request.root, "data")} ${join(request.root, ".env")}\nProtectKernelTunables=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nLockPersonality=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}
async function installCaddy(request: InstallRequest, host: HostExecutor): Promise<void> {
  if (request.topology !== "regular" || request.noCaddy) return;
  const archResult = await host.run(["dpkg", "--print-architecture"]);
  const arch = { amd64: "x86_64", arm64: "arm64" }[archResult.stdout.trim()];
  if (!arch) throw new Error(`Caddy release architecture is unsupported: ${archResult.stdout.trim()}`);
  const archive = `caddy_${CADDY_VERSION}_linux_${arch}.tar.gz`;
  const base = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`;
  await host.run(["curl", "-fsSL", "-o", `/tmp/${archive}`, `${base}/${archive}`], { timeoutMs: 120_000 });
  await host.run(["curl", "-fsSL", "-o", "/tmp/caddy-checksums.txt", `${base}/caddy_${CADDY_VERSION}_checksums.txt`], { timeoutMs: 120_000 });
  await host.run(["sh", "-c", `grep '  ${archive}$' /tmp/caddy-checksums.txt | (cd /tmp && sha256sum -c -)`], { timeoutMs: 30_000 });
  await host.run(["tar", "-xzf", `/tmp/${archive}`, "-C", "/tmp", "caddy"]);
  await host.run(["install", "-m", "0755", "/tmp/caddy", "/usr/bin/caddy"]);
  await host.run(["sh", "-c", "id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy"]);
  await host.run(["mkdir", "-p", "/etc/caddy", "/var/log/caddy", "/var/lib/caddy"]);
  await host.run(["chown", "-R", "caddy:caddy", "/var/lib/caddy", "/var/log/caddy"]);
  const existing = await host.run(["sh", "-c", "test ! -f /etc/caddy/Caddyfile || grep -q '# Cartethyia managed' /etc/caddy/Caddyfile"]).catch(() => null);
  if (existing === null) throw new Error("Existing /etc/caddy/Caddyfile is not Cartethyia-managed; refusing to overwrite it");
  const config = `# Cartethyia managed\n${request.domain} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${request.port} {\n\t\tflush_interval -1\n\t}\n}\n`;
  await host.writeAtomic("/etc/caddy/Caddyfile", config, 0o644);
  const unit = `[Unit]\nDescription=Caddy reverse proxy for Cartethyia\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nUser=caddy\nGroup=caddy\nExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile\nExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile\nRestart=always\nRestartSec=3\nTimeoutStopSec=15\nLimitNOFILE=1048576\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n\n[Install]\nWantedBy=multi-user.target\n`;
  await host.writeAtomic("/etc/systemd/system/caddy.service", unit, 0o644);
  await host.run(["systemctl", "daemon-reload"]);
  await host.run(["systemctl", "enable", "--now", "caddy"]);
}
export async function installVps(request: InstallRequest, host: HostExecutor = hostExecutor, health?: HealthDependencies): Promise<void> {
  if (host.platform !== "linux") throw new Error("VPS install requires Linux with apt and systemd");
  const envPath = join(request.root, ".env");
  const existing = await readEnvFile(envPath);
  assertModeChangeAllowed(existing, request.mode);
  await prepareSource(request, host);
  await installDependencies(request, host);
  const db = await provisionPostgres(request, existing.DATABASE_URL ?? "", host);
  await provisionRedis(request, host);
  if (request.topology === "regular" && !request.noCaddy) {
    const dns = await host.run(["getent", "hosts", request.domain!], { timeoutMs: 30_000 });
    if (!dns.stdout.trim()) throw new Error(`${request.domain} does not resolve; point DNS at this VPS before installing Caddy`);
  }
  await installCaddy(request, host);
  const key = await ensureEncryptionKey(envPath);
  const origin = request.publicOrigin ?? `https://${request.domain}`;
  const updates: Record<string, string> = {
    CARTETHYIA_DB_MODE: request.mode,
    PORT: String(request.port),
    DASHBOARD_DIST: join(request.root, "dist", "dashboard"),
    CARTETHYIA_PACKAGE_ROOT: request.root,
    CARTETHYIA_PUBLIC_ORIGIN: origin,
    CARTETHYIA_DATA_DIR: join(request.root, "data"),
    CARTETHYIA_TELEMETRY_PAYLOAD_DIR: join(request.root, "data", "telemetry-payloads"),
    CARTETHYIA_INSTALL_ID_DIR: join(request.root, "data", ".cartethyia"),
    CARTETHYIA_ENCRYPTION_KEY: key,
    TRUSTED_PROXY_CIDRS: existing.TRUSTED_PROXY_CIDRS ?? "127.0.0.1/32,::1/128",
  };
  if (db.url) updates.DATABASE_URL = db.url;
  if (request.provisionRedis) updates.REDIS_URL = "redis://127.0.0.1:6379";
  await writeEnvAtomic(envPath, updates);
  await prepareStateDirectories(updates);
  await host.run(["bun", "install", "--linker", "isolated", "--frozen-lockfile"], { cwd: request.root, timeoutMs: 600_000 });
  await host.run(["bun", "run", "build"], { cwd: request.root, timeoutMs: 900_000 });
  await host.writeAtomic("/etc/systemd/system/cartethyia.service", serviceUnit(request, Boolean(db.password)), 0o644);
  await host.run(["systemctl", "daemon-reload"]);
  await host.run(["systemctl", "enable", "cartethyia"]);
  if (!request.noStart) await host.run(["systemctl", "restart", "cartethyia"]);
  const env = await readEnvFile(envPath);
  let results = await runHealthChecks({ target: "vps", env, envPath, port: request.port, phases: request.noStart ? ["configuration"] : ["configuration", "runtime"] }, health);
  if (!request.noStart) {
    const deadline = Date.now() + 60_000;
    while (hasRequiredFailure(results) && Date.now() < deadline) {
      await Bun.sleep(1_000);
      results = await runHealthChecks({ target: "vps", env, envPath, port: request.port, phases: ["configuration", "runtime"] }, health);
    }
  }
  if (request.noStart) results.push(skippedRuntimeCheck());
  for (const item of results) console.log(`${item.status.toUpperCase()} ${item.summary}`);
  if (hasRequiredFailure(results)) throw new Error("VPS health checks failed; inspect: systemctl status cartethyia && journalctl -u cartethyia");
  if (request.topology === "nat") console.warn("NAT provider port forwarding/TLS cannot be proven from inside the VM; verify the public origin from outside.");
  console.log(`Cartethyia ${request.mode} installed at ${origin}/console`);
}
