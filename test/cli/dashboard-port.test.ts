import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";

const sockets = new Set<Socket>();
let blocker5173: Server | null = null;
let blocker1931: Server | null = null;

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  if (blocker5173) {
    await new Promise<void>((r) => blocker5173!.close(() => r()));
    blocker5173 = null;
  }
  if (blocker1931) {
    await new Promise<void>((r) => blocker1931!.close(() => r()));
    blocker1931 = null;
  }
  delete process.env.DASHBOARD_PORT;
  delete process.env.VITE_PORT;
  delete process.env.VITE_BACKEND_URL;
  delete process.env.PORT;
});

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
  });
}

describe("dashboard port and backend resolution in vite.config.ts", () => {
  const viteConfigPath = resolve(import.meta.dir, "..", "..", "dashboard", "vite.config.ts");

  test("honors explicit DASHBOARD_PORT override", async () => {
    process.env.DASHBOARD_PORT = "1931";
    const configFn = (await import(viteConfigPath)).default;
    const config = typeof configFn === "function" ? await configFn() : configFn;
    expect(config.server?.port).toBe(1931);
    expect(config.server?.strictPort).toBe(true);
  });

  test("falls back from 5173 to 1931 when 5173 is occupied", async () => {
    delete process.env.DASHBOARD_PORT;
    delete process.env.VITE_PORT;
    try {
      blocker5173 = await occupy(5173);
    } catch {
      // 5173 already occupied on host, which also proves the condition
    }

    const configFn = (await import(viteConfigPath)).default;
    const config = typeof configFn === "function" ? await configFn() : configFn;
    expect(config.server?.port).toBe(1931);
    expect(config.server?.strictPort).toBe(false);
  });

  test("proxies to custom PORT when VITE_BACKEND_URL is unset", async () => {
    process.env.PORT = "8081";
    delete process.env.VITE_BACKEND_URL;
    const configFn = (await import(viteConfigPath)).default;
    const config = typeof configFn === "function" ? await configFn() : configFn;
    const proxy = config.server?.proxy;
    expect(proxy?.["/console/api"].target).toBe("http://127.0.0.1:8081");
    expect(proxy?.["/v1"].target).toBe("http://127.0.0.1:8081");
  });
});
