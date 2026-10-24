import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { PACKAGE_ROOT } from "../../src/config/package-paths";
import { hostExecutor, type HostExecutor } from "./host";
import type { InstallRequest } from "./plan";

export async function prepareSource(request: InstallRequest, host: HostExecutor = hostExecutor): Promise<void> {
  if (request.target === "docker") return;
  const git = join(request.root, ".git");
  if (await host.exists(git)) {
    if (resolve(request.root) === resolve(PACKAGE_ROOT)) return;
    const dirty = await host.run(["git", "status", "--porcelain"], { cwd: request.root });
    if (dirty.stdout.trim()) throw new Error(`Installation checkout is dirty: ${request.root}. Commit/stash changes or use another --root; refusing to reset it.`);
    await host.run(["git", "fetch", "--depth", "1", "origin", process.env.CARTETHYIA_BRANCH || "dev"], { cwd: request.root, timeoutMs: 120_000 });
    await host.run(["git", "merge", "--ff-only", "FETCH_HEAD"], { cwd: request.root, timeoutMs: 120_000 });
    return;
  }
  throw new Error(`${request.root} is not a Cartethyia checkout. Run scripts/install.sh for fresh bootstrap or clone the repository before using install.ts directly.`);
}
export async function installDependencies(request: InstallRequest, host: HostExecutor = hostExecutor): Promise<void> {
  if (request.skipDeps || request.target === "docker") return;
  if (host.platform === "linux") {
    await host.run(["apt-get", "update"], { timeoutMs: 300_000 });
    const packages = ["git", "curl", "unzip", "ca-certificates", "openssl"];
    if (request.mode === "full") packages.push("postgresql", "postgresql-contrib");
    if (request.provisionRedis) packages.push("redis-server");
    await host.run(["apt-get", "install", "-y", ...packages], { timeoutMs: 600_000 });
  } else if (host.platform === "darwin") {
    if (request.target === "vps") throw new Error("VPS target supports Linux/systemd only");
    const packages = ["git", "curl", "unzip", "openssl"];
    if (request.mode === "full") packages.push("postgresql@16");
    if (request.provisionRedis) packages.push("redis");
    await host.run(["brew", "install", ...packages], { timeoutMs: 600_000 });
  } else throw new Error(`Unsupported platform ${host.platform}; use Debian/Ubuntu Linux or macOS Homebrew`);
}
export async function provisionPostgres(request: InstallRequest, existingUrl: string, host: HostExecutor = hostExecutor): Promise<{ url: string; password?: string }> {
  if (request.mode !== "full") return { url: "" };
  if (existingUrl.trim()) return { url: existingUrl.trim() };
  if (host.platform === "darwin") {
    await host.run(["brew", "services", "start", "postgresql@16"], { timeoutMs: 120_000 });
  } else {
    await host.run(["systemctl", "enable", "--now", "postgresql"]);
  }
  const password = randomBytes(24).toString("base64url");
  const roleArgs = ["-v", "ON_ERROR_STOP=1", "--set", `carte_password=${password}`, "-c", "CREATE ROLE cartethyia LOGIN PASSWORD :'carte_password'"];
  const role = await host.run(["psql", "-tAc", "SELECT 1 FROM pg_roles WHERE rolname='cartethyia'"], { timeoutMs: 30_000 }).catch(() => null);
  if (host.platform === "linux") {
    const existing = await host.run(["runuser", "-u", "postgres", "--", "psql", "-tAc", "SELECT 1 FROM pg_roles WHERE rolname='cartethyia'"]);
    if (existing.stdout.trim() === "1") throw new Error("PostgreSQL role cartethyia already exists but no DATABASE_URL is configured. Supply its existing DATABASE_URL; refusing to reset its password.");
    await host.run(["runuser", "-u", "postgres", "--", "psql", ...roleArgs], { redact: [password] });
    await host.run(["runuser", "-u", "postgres", "--", "createdb", "-O", "cartethyia", "cartethyia"]);
  } else {
    if (role?.stdout.trim() === "1") throw new Error("PostgreSQL role cartethyia already exists but no DATABASE_URL is configured. Supply its existing DATABASE_URL; refusing to reset its password.");
    await host.run(["psql", ...roleArgs], { redact: [password] });
    await host.run(["createdb", "-O", "cartethyia", "cartethyia"]);
  }
  return { url: `postgres://cartethyia:${encodeURIComponent(password)}@127.0.0.1:5432/cartethyia`, password };
}
export async function provisionRedis(request: InstallRequest, host: HostExecutor = hostExecutor): Promise<void> {
  if (!request.provisionRedis || request.target === "docker") return;
  await host.run(host.platform === "darwin" ? ["brew", "services", "start", "redis"] : ["systemctl", "enable", "--now", "redis-server"]);
}
