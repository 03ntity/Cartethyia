import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import Redis from "ioredis";
import { hasPlaceholderSecrets, readEnvFile } from "./env";
import { parseServiceUrl, probeTcpService } from "./services";
import { resolveDataDir, resolveDbMode } from "../../src/persistence/db-mode";
import { bunVersionAtLeast, readRequiredBunVersion } from "./version";

export type CheckPhase = "preflight" | "configuration" | "runtime";
export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export interface CheckResult {
  id: string;
  phase: CheckPhase;
  status: CheckStatus;
  required: boolean;
  summary: string;
  remediation?: string;
}
export interface HealthContext {
  target: "local" | "vps" | "docker";
  env: Record<string, string>;
  envPath: string;
  port: number;
  phases: readonly CheckPhase[];
}
export interface HealthDependencies {
  dockerCompose: () => Promise<boolean>;
  postgres: (url: string) => Promise<void>;
  redis: (url: string) => Promise<void>;
  tcp: typeof probeTcpService;
  ready: (port: number) => Promise<string | null>;
  writable: (path: string) => Promise<boolean>;
  exists: (path: string) => Promise<boolean>;
}
const defaultDependencies: HealthDependencies = {
  async dockerCompose() {
    try {
      return Bun.spawnSync(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  },
  async postgres(url) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => undefined);
    }
  },
  async redis(url) {
    const client = new Redis(url, { lazyConnect: true, connectTimeout: 3_000, maxRetriesPerRequest: 0 });
    try {
      await client.connect();
      const result = await client.ping();
      if (result !== "PONG") throw new Error(`Unexpected Redis response: ${result}`);
    } finally {
      client.disconnect();
    }
  },
  tcp: probeTcpService,
  async ready(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(3_000) });
      return response.ok ? null : `HTTP ${response.status}`;
    } catch (error) {
      return error instanceof Error ? error.message : "connection failed";
    }
  },
  async writable(path) {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  async exists(path) {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};
function result(id: string, phase: CheckPhase, status: CheckStatus, summary: string, required = true, remediation?: string): CheckResult {
  return { id, phase, status, required, summary, ...(remediation ? { remediation } : {}) };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function runHealthChecks(
  context: HealthContext,
  dependencies: HealthDependencies = defaultDependencies,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const phases = new Set(context.phases);
  const env = { ...(await readEnvFile(context.envPath)), ...context.env };
  if (phases.has("preflight")) {
    const minimum = await readRequiredBunVersion();
    const bunOkay = bunVersionAtLeast(Bun.version, minimum);
    results.push(result("runtime-bun", "preflight", bunOkay ? "pass" : "fail", bunOkay ? `Bun ${Bun.version} satisfies ${minimum}+` : `Bun ${Bun.version} is older than required ${minimum}`, true, bunOkay ? undefined : "Install the required Bun version"));
    if (context.target === "docker") {
      const available = await dependencies.dockerCompose();
      results.push(result("docker-compose", "preflight", available ? "pass" : "fail", available ? "Docker Compose is available" : "Docker Compose is unavailable", true, "Install Docker Engine with the Compose plugin"));
    }
  }
  if (phases.has("configuration")) {
    if (!(await dependencies.exists(context.envPath))) {
      results.push(result("env-file", "configuration", "fail", `.env not found at ${context.envPath}`, true, "Run setup or the installer"));
    } else {
      results.push(result("env-file", "configuration", "pass", `.env exists at ${context.envPath}`));
    }
    let mode: "lite" | "full" | null = null;
    try {
      mode = resolveDbMode(env);
      results.push(result("db-mode", "configuration", "pass", `Database mode: ${mode}`));
    } catch (error) {
      results.push(result("db-mode", "configuration", "fail", errorMessage(error), true, "Set CARTETHYIA_DB_MODE=lite or full"));
    }
    const key = env.CARTETHYIA_ENCRYPTION_KEY?.trim() ?? "";
    results.push(!key
      ? result("encryption-key", "configuration", "fail", "CARTETHYIA_ENCRYPTION_KEY is missing")
      : hasPlaceholderSecrets(key)
        ? result("encryption-key", "configuration", "fail", "CARTETHYIA_ENCRYPTION_KEY is still a placeholder")
        : result("encryption-key", "configuration", "pass", "Encryption key is configured"));
    if (mode === "lite") {
      const data = resolveDataDir(env);
      const paths = [data, env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || join(data, "telemetry-payloads"), env.CARTETHYIA_INSTALL_ID_DIR?.trim() || join(data, ".cartethyia")];
      for (const path of paths) {
        if (context.target === "docker" && path.startsWith("/app/")) {
          results.push(result(`container-path-${path}`, "configuration", "pass", `Container state path is declared: ${path}; runtime checks verify its writability`));
          continue;
        }
        const writable = await dependencies.writable(resolve(path));
        results.push(result(`writable-${path}`, "configuration", writable ? "pass" : "fail", `${writable ? "Writable" : "Not writable"}: ${path}`));
      }
    }
    if (mode === "full") {
      const url = env.DATABASE_URL?.trim() ?? "";
      if (!url) results.push(result("postgres", "configuration", "fail", "DATABASE_URL is required in Full mode"));
      else if (!parseServiceUrl(url)) results.push(result("postgres", "configuration", "fail", "DATABASE_URL must include a host and port"));
      else if (context.target === "docker") results.push(result("postgres", "configuration", "pass", "External DATABASE_URL is configured; container readiness verifies connectivity"));
      else {
        try {
          await dependencies.postgres(url);
          results.push(result("postgres", "configuration", "pass", "PostgreSQL authenticated SELECT 1 succeeded"));
        } catch (error) {
          const parsed = parseServiceUrl(url)!;
          const tcp = await dependencies.tcp(parsed.host, parsed.port, 3_000);
          results.push(result("postgres", "configuration", tcp.success ? "warn" : "fail", tcp.success ? "PostgreSQL port is reachable, but authenticated query failed" : "PostgreSQL is unreachable or authentication failed", true, "Verify DATABASE_URL credentials and database availability"));
        }
      }
    }
    const redis = env.REDIS_URL?.trim() ?? "";
    if (!redis) results.push(result("redis", "configuration", "pass", "Redis is not configured; in-memory coordination applies"));
    else if (context.target === "docker") results.push(result("redis", "configuration", "pass", "Container Redis coordination is configured; container readiness verifies connectivity"));
    else {
      try {
        await dependencies.redis(redis);
        results.push(result("redis", "configuration", "pass", "Redis PING succeeded"));
      } catch (error) {
        results.push(result("redis", "configuration", "fail", "Configured Redis is unavailable or authentication failed", true, "Verify REDIS_URL and Redis availability"));
      }
    }
  }
  if (phases.has("runtime")) {
    if (!Number.isInteger(context.port) || context.port < 1 || context.port > 65535) {
      results.push(result("app-ready", "runtime", "fail", `Invalid application port: ${context.port}`));
    } else {
      const failure = await dependencies.ready(context.port);
      results.push(result("app-ready", "runtime", failure ? "fail" : "pass", failure ? `Application is not ready: ${failure}` : `Application is ready on port ${context.port}`));
    }
  }
  return results;
}
export function hasRequiredFailure(results: readonly CheckResult[]): boolean {
  return results.some((item) => item.required && item.status === "fail");
}
export function skippedRuntimeCheck(): CheckResult {
  return result("app-ready", "runtime", "skip", "Runtime readiness was not requested", false);
}
