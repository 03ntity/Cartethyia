import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "../cli/env";
import { ensureDrainToken, attachGateway, stopAttachedGateway } from "../cli/instance";
import { startGateway } from "../cli/gateway";
import { runHealthChecks, hasRequiredFailure, skippedRuntimeCheck, type HealthDependencies } from "../health";
import { writeEnvAtomic, assertModeChangeAllowed, ensureEncryptionKey, prepareStateDirectories } from "./config";
import { hostExecutor, type HostExecutor } from "./host";
import { installDependencies, prepareSource, provisionPostgres, provisionRedis } from "./runtime";
import type { InstallRequest } from "./plan";

export async function installLocal(request: InstallRequest, host: HostExecutor = hostExecutor, health?: HealthDependencies): Promise<void> {
  const envPath = join(request.root, ".env");
  const existing = await readEnvFile(envPath);
  assertModeChangeAllowed(existing, request.mode);
  await prepareSource(request, host);
  await installDependencies(request, host);
  const db = await provisionPostgres(request, existing.DATABASE_URL ?? "", host);
  await provisionRedis(request, host);
  const key = await ensureEncryptionKey(envPath);
  const updates: Record<string, string> = {
    CARTETHYIA_DB_MODE: request.mode,
    PORT: String(request.port),
    DASHBOARD_DIST: join(request.root, "dist", "dashboard"),
    CARTETHYIA_PACKAGE_ROOT: request.root,
    CARTETHYIA_PUBLIC_ORIGIN: request.publicOrigin ?? existing.CARTETHYIA_PUBLIC_ORIGIN ?? `http://localhost:${request.port}`,
    CARTETHYIA_DATA_DIR: join(request.root, "data"),
    CARTETHYIA_TELEMETRY_PAYLOAD_DIR: join(request.root, "data", "telemetry-payloads"),
    CARTETHYIA_INSTALL_ID_DIR: join(request.root, "data", ".cartethyia"),
    CARTETHYIA_ENCRYPTION_KEY: key,
  };
  if (db.url) updates.DATABASE_URL = db.url;
  if (request.provisionRedis) updates.REDIS_URL = "redis://127.0.0.1:6379";
  await writeEnvAtomic(envPath, updates);
  const launcher = await readFile(fileURLToPath(new URL("local-launcher.sh", import.meta.url)), "utf8");
  await host.writeAtomic(join(request.root, "carte"), launcher, 0o755);
  await host.run(["bun", "install", "--linker", "isolated", "--frozen-lockfile"], { cwd: request.root, timeoutMs: 600_000 });
  await host.run(["bun", "run", "build"], { cwd: request.root, timeoutMs: 900_000 });
  const env = await readEnvFile(envPath);
  await prepareStateDirectories(env);
  const configResults = await runHealthChecks({ target: "local", env, envPath, port: request.port, phases: ["configuration"] }, health);
  if (hasRequiredFailure(configResults)) throw new Error("Post-install configuration checks failed");
  if (!request.noStart) {
    process.env.CARTETHYIA_CONFIG_DIR = request.root;
    process.env.CARTETHYIA_PACKAGE_ROOT = request.root;
    process.env.CARTETHYIA_GATEWAY_BINARY = join(request.root, "dist", process.platform === "win32" ? "cartethyia.exe" : "cartethyia");
    Object.assign(process.env, env);
    const token = ensureDrainToken();
    const running = await attachGateway(request.port, token);
    if (running) await stopAttachedGateway(running, token);
    const child = await startGateway(request.port, token, { detached: true });
    child.unref();
    const results = await runHealthChecks({ target: "local", env, envPath, port: request.port, phases: ["runtime"] }, health);
    for (const item of results) console.log(`${item.status.toUpperCase()} ${item.summary}`);
    if (hasRequiredFailure(results)) throw new Error("Local gateway did not become ready; inspect gateway.log in the installation root");
  } else console.log(`${skippedRuntimeCheck().status.toUpperCase()} ${skippedRuntimeCheck().summary}`);
  console.log(`\nCartethyia ${request.mode} installed at ${request.root}`);
  console.log(`Console: ${updates.CARTETHYIA_PUBLIC_ORIGIN}/console`);
  console.log(`Manage: ${join(request.root, "carte")} menu`);
  console.log(`Doctor: ${join(request.root, "carte")} doctor`);
  console.log(`Stop: ${join(request.root, "carte")} stop`);
}
