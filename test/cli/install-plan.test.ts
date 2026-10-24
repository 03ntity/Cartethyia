import { expect, test } from "bun:test";
import { buildInstallPlan, parseInstallArgs } from "../../scripts/install/plan";

const base = ["--non-interactive"];
test("Local Lite is Bun-only and needs no database or Caddy", () => {
  const request = parseInstallArgs([...base, "--local", "--lite", "--root", "C:/carte-test"]);
  expect(request).toMatchObject({ target: "local", mode: "lite", port: 12800 });
  const plan = buildInstallPlan(request).join("\n");
  expect(plan).toContain("Bun only");
  expect(plan).not.toContain("PostgreSQL");
  expect(plan).not.toContain("Caddy");
  expect(plan).not.toContain("Node");
});
test("Regular Full includes Postgres, Caddy, and systemd", () => {
  const request = parseInstallArgs([...base, "--vps", "--regular", "--full", "--domain", "app.example.com"]);
  const plan = buildInstallPlan(request).join("\n");
  expect(plan).toContain("PostgreSQL");
  expect(plan).toContain("Caddy");
  expect(plan).toContain("systemd");
});
test("NAT Lite never installs Caddy and warns about external forwarding", () => {
  const request = parseInstallArgs([...base, "--vps", "--nat", "--lite", "--port", "8080", "--public-origin", "https://app.example.com:8080"]);
  const plan = buildInstallPlan(request).join("\n");
  expect(plan).not.toContain("Caddy");
  expect(plan).toContain("external verification");
});
test("Docker does not install host dependencies", () => {
  const plan = buildInstallPlan(parseInstallArgs([...base, "--docker", "--lite"])).join("\n");
  expect(plan).toContain("docker compose up --build -d");
  expect(plan).not.toContain("install missing target dependencies");
});
test("conflicting and legacy arguments fail before planning", () => {
  expect(() => parseInstallArgs([...base, "--local", "--docker", "--lite"])).toThrow("exactly one target");
  expect(() => parseInstallArgs([...base, "--local", "--lite", "--full"])).toThrow("exactly one database");
  expect(() => parseInstallArgs(["--mode", "lite"])).toThrow("Unknown argument");
  expect(() => parseInstallArgs([...base, "--local", "--lite", "--port", "70000"])).toThrow("1 to 65535");
});
test("NAT requires explicit origin and port; no-caddy needs origin", () => {
  expect(() => parseInstallArgs([...base, "--vps", "--nat", "--lite"])).toThrow("explicit --port");
  expect(() => parseInstallArgs([...base, "--vps", "--regular", "--lite", "--no-caddy"])).toThrow("requires --public-origin");
});
test("dry-run and check are mutually exclusive", () => {
  expect(() => parseInstallArgs([...base, "--local", "--lite", "--dry-run", "--check"])).toThrow("only one");
});
