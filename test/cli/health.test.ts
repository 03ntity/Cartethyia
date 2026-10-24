import { expect, test } from "bun:test";
import { hasRequiredFailure, runHealthChecks, type HealthContext } from "../../scripts/health";

function context(env: Record<string, string>, phases: HealthContext["phases"] = ["configuration", "runtime"]): HealthContext {
  return { target: "local", env, envPath: "C:/missing-cartethyia-test-env", port: 12800, phases };
}
const probes = {
  dockerCompose: async () => true,
  postgres: async () => undefined,
  redis: async () => undefined,
  tcp: async () => ({ success: true }),
  ready: async () => null,
  writable: async () => true,
  exists: async () => true,
};

test("Lite uses writable state and in-memory coordination without PostgreSQL", async () => {
  let postgresCalled = false;
  const results = await runHealthChecks(context({ CARTETHYIA_DB_MODE: "lite", CARTETHYIA_ENCRYPTION_KEY: "secret" }), {
    ...probes,
    postgres: async () => { postgresCalled = true; },
  });
  expect(postgresCalled).toBe(false);
  expect(hasRequiredFailure(results)).toBe(false);
  expect(results.some((item) => item.summary.includes("in-memory"))).toBe(true);
});

test("Full requires an authenticated DB query; TCP alone is only a warning", async () => {
  const results = await runHealthChecks(context({
    CARTETHYIA_DB_MODE: "full",
    CARTETHYIA_ENCRYPTION_KEY: "secret",
    DATABASE_URL: "postgres://user:supersecret@127.0.0.1:5432/db",
  }, ["configuration"]), { ...probes, postgres: async () => { throw new Error("password failed for user:supersecret"); } });
  const db = results.find((item) => item.id === "postgres");
  expect(db?.status).toBe("warn");
  expect(JSON.stringify(results)).not.toContain("supersecret");
});

test("configured Redis failure is required and unset Redis is healthy", async () => {
  const failed = await runHealthChecks(context({ CARTETHYIA_DB_MODE: "lite", CARTETHYIA_ENCRYPTION_KEY: "secret", REDIS_URL: "redis://localhost:6379" }, ["configuration"]), {
    ...probes,
    redis: async () => { throw new Error("down"); },
  });
  expect(hasRequiredFailure(failed)).toBe(true);
  const unset = await runHealthChecks(context({ CARTETHYIA_DB_MODE: "lite", CARTETHYIA_ENCRYPTION_KEY: "secret" }, ["configuration"]), probes);
  expect(hasRequiredFailure(unset)).toBe(false);
});

test("runtime down is distinct from missing configuration", async () => {
  const results = await runHealthChecks(context({ CARTETHYIA_DB_MODE: "lite", CARTETHYIA_ENCRYPTION_KEY: "secret" }, ["runtime"]), { ...probes, ready: async () => "connection refused" });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ id: "app-ready", phase: "runtime", status: "fail" });
});
