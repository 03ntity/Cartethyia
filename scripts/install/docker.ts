import { join } from "node:path";
import { readEnvFile } from "../cli/env";
import { runHealthChecks, hasRequiredFailure, skippedRuntimeCheck, type HealthDependencies } from "../health";
import { assertModeChangeAllowed, ensureEncryptionKey, writeEnvAtomic } from "./config";
import { hostExecutor, type HostExecutor } from "./host";
import type { InstallRequest } from "./plan";

export async function installDocker(request: InstallRequest, host: HostExecutor = hostExecutor, health?: HealthDependencies): Promise<void> {
  const envPath = join(request.root, ".env");
  const existing = await readEnvFile(envPath);
  assertModeChangeAllowed(existing, request.mode);
  for (const file of ["Dockerfile", "docker-compose.yml", "docker-entrypoint.sh", "package.json"]) {
    if (!(await host.exists(join(request.root, file)))) throw new Error(`Docker target requires a full checkout; missing ${join(request.root, file)}`);
  }
  await host.run(["docker", "compose", "version"], { cwd: request.root });
  await host.run(["docker", "info", "--format", "{{.ServerVersion}}"], { cwd: request.root, timeoutMs: 30_000 });
  if (request.mode === "full" && !existing.DATABASE_URL?.trim()) throw new Error("Docker Full requires an external DATABASE_URL in .env; PostgreSQL is not bundled automatically");
  const updates: Record<string, string> = {
    CARTETHYIA_DB_MODE: request.mode,
    CARTETHYIA_ENCRYPTION_KEY: await ensureEncryptionKey(envPath),
    CARTETHYIA_PUBLIC_ORIGIN: request.publicOrigin ?? existing.CARTETHYIA_PUBLIC_ORIGIN ?? `http://localhost:${request.port}`,
    PORT: String(request.port),
  };
  if (request.mode === "lite") updates.CARTETHYIA_REDIS_URL = "";
  await writeEnvAtomic(envPath, updates);
  const env = await readEnvFile(envPath);
  env.CARTETHYIA_DATA_DIR = "/app/data";
  env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = "/app/data/telemetry-payloads";
  env.CARTETHYIA_INSTALL_ID_DIR = "/app/data/.cartethyia";
  if (request.mode === "lite") env.REDIS_URL = "";
  else env.REDIS_URL = env.CARTETHYIA_REDIS_URL ?? "redis://redis:6379";
  const config = await runHealthChecks({ target: "docker", env, envPath, port: request.port, phases: ["preflight", "configuration"] }, health);
  if (hasRequiredFailure(config)) throw new Error("Docker configuration checks failed");
  if (!request.noStart) {
    await host.run(["docker", "compose", "up", "--build", "-d"], { cwd: request.root, timeoutMs: 1_200_000 });
    let runtime = await runHealthChecks({ target: "docker", env, envPath, port: request.port, phases: ["runtime"] }, health);
    const deadline = Date.now() + 120_000;
    while (hasRequiredFailure(runtime) && Date.now() < deadline) {
      await Bun.sleep(1_000);
      runtime = await runHealthChecks({ target: "docker", env, envPath, port: request.port, phases: ["runtime"] }, health);
    }
    for (const item of runtime) console.log(`${item.status.toUpperCase()} ${item.summary}`);
    if (hasRequiredFailure(runtime)) throw new Error("Docker app did not become ready; inspect with: docker compose logs app");
  } else console.log(`${skippedRuntimeCheck().status.toUpperCase()} ${skippedRuntimeCheck().summary}`);
  console.log(`Cartethyia Docker ${request.mode} is configured at ${request.root}`);
  console.log(`Console: ${updates.CARTETHYIA_PUBLIC_ORIGIN}/console`);
}
