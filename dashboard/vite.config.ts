import { defineConfig, type Plugin, type UserConfig, type ConfigEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { IncomingMessage } from "node:http";

function resolveBackendTarget(): string {
  const backendPort = process.env.PORT?.trim() || "12800";
  return process.env.VITE_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;
}

/**
 * One proxy entry for a gateway route.
 *
 * The `configure` hook is what keeps `bun run dev` quiet while the backend is
 * starting or hot-reloading: without it Vite prints `[vite] http proxy error:
 * <path> Error: connect ECONNREFUSED …` for every polled health/console
 * request — a flood every ~5s while the gateway is mid-restart. A refused
 * connect is answered with a graceful 502 JSON envelope instead, so the SPA
 * sees an ordinary failed fetch and the terminal stays readable. Other proxy
 * errors (5xx from the backend itself) are still logged.
 */
function backendProxyTarget(target: string) {
  return {
    target,
    changeOrigin: false,
    configure(proxyServer: { on(event: string, handler: (err: NodeJS.ErrnoException, req: IncomingMessage, res: import("node:http").ServerResponse) => void): void }) {
      proxyServer.on("error", (err, _req, res) => {
        if (err.code === "ECONNREFUSED") {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: "Gateway backend is not reachable", type: "server_error", code: "backend_unreachable" },
              }),
            );
          }
          return;
        }
        console.error("[dashboard] proxy error:", err.message);
      });
    },
  };
}

/**
 * Dev-server routing for the shared index document: `/` serves the landing app,
 * `/console/*` the admin console, and `/share/*` the public share app. The
 * production server implements the same mapping in
 * `src/console/dashboard-assets.ts`.
 */
function multiPageRouting(): Plugin {
  return {
    name: "cartethyia-multi-page-routing",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname === "/console" || pathname.startsWith("/console/")) {
          // The console API namespace is proxied to the gateway, not the SPA.
          if (!pathname.startsWith("/console/api")) req.url = "/index.html";
        }
        next();
      });
    },
  };
}

/**
 * Emits a `.gz` sibling beside every built text asset.
 *
 * Compression is paid once per deploy instead of once per request: the
 * dashboard's bundles are static and hashed, so the gzip output for a given
 * build never changes, while compressing at serve time would repeat that work
 * for every visitor of every file.
 *
 * Level 9 — the cost is build time, not request latency, and these bytes are
 * served from disk for the lifetime of the deployment. `src/console/
 * dashboard-assets.ts` serves the `.gz` when the client offered gzip and falls
 * back to the plain file when it did not, so a build without this plugin still
 * works. The same pass fingerprints the emitted assets and puts the build ID
 * in `index.html`, so a deployment's served version can be checked directly.
 */
function precompressAssets(): Plugin {
  const COMPRESSED_EXTENSIONS = [".js", ".mjs", ".css", ".html", ".json", ".svg"];
  return {
    name: "cartethyia-precompress-assets",
    apply: "build",
    async closeBundle() {
      const { gzipSync } = await import("node:zlib");
      const { readdir, readFile, writeFile } = await import("node:fs/promises");
      const { join, extname, resolve } = await import("node:path");

      // `process.cwd()`, not `import.meta.dir`: Vite transpiles this config to
      // a temp file before running it, so `import.meta.dir` is the temp
      // directory rather than `dashboard/`. The build is invoked from
      // `dashboard/`, and `build.outDir` above is relative to it.
      const root = resolve(process.cwd(), "..", "dist", "dashboard");
      const stack: string[] = [root];
      const files: Array<{ full: string; relative: string; source: Buffer }> = [];
      const written: string[] = [];
      while (stack.length > 0) {
        const dir = stack.pop();
        if (dir === undefined) continue;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (entry.name.endsWith(".gz")) continue;
          files.push({
            full,
            relative: full.slice(root.length + 1).replace(/\\/g, "/"),
            source: await readFile(full),
          });
        }
      }

      const index = files.find((file) => file.relative === "index.html");
      if (index === undefined) throw new Error("Dashboard build did not emit index.html");

      const hash = createHash("sha256");
      for (const file of files
        .filter((candidate) => candidate !== index)
        .sort((left, right) => left.relative.localeCompare(right.relative))) {
        hash.update(file.relative);
        hash.update("\0");
        hash.update(file.source);
      }

      const buildId = hash.digest("hex").slice(0, 16);
      const html = index.source.toString("utf8");
      const marker = `<meta name="cartethyia-dashboard-build" content="${buildId}" />`;
      if (!html.includes("</head>")) throw new Error("Dashboard entry document has no closing head tag");
      index.source = Buffer.from(html.replace("</head>", `  ${marker}\n</head>`));
      await writeFile(index.full, index.source);

      for (const file of files) {
        if (!COMPRESSED_EXTENSIONS.includes(extname(file.full).toLowerCase())) continue;
        await writeFile(`${file.full}.gz`, gzipSync(file.source, { level: 9 })).catch(() => undefined);
        written.push(file.relative);
      }

      // The manifest is what makes the output inspectable: a deploy can assert
      // the `.gz` siblings exist instead of trusting that the plugin ran.
      await writeFile(
        join(root, "precompressed-assets.json"),
        `${JSON.stringify({ count: written.length, assets: written.sort() }, null, 2)}\n`,
      ).catch(() => undefined);
    },
  };
}

function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
});
});
}

async function resolveServerPort(): Promise<{ port: number; strictPort: boolean }> {
  const explicit = process.env.DASHBOARD_PORT ?? process.env.VITE_PORT;
  if (explicit && explicit.trim() !== "") {
    const num = Number(explicit.trim());
    if (Number.isInteger(num) && num > 0 && num <= 65535) {
      return { port: num, strictPort: true };
}
}

  // Default 5173, fallback to 1931 if 5173 is occupied
  if (await isPortFree(5173)) {
    return { port: 5173, strictPort: false };
}

  if (await isPortFree(1931)) {
    return { port: 1931, strictPort: false };
}

  // If 1931 is also occupied, Vite will pick the next available port automatically
  return { port: 1931, strictPort: false };
}

export default defineConfig(async (_env: ConfigEnv): Promise<UserConfig> => {
  const { port, strictPort } = await resolveServerPort();
  const backendTarget = resolveBackendTarget();
  // `VITE_NO_BACKEND_PROXY=1` runs the dashboard without the gateway proxy
  // (console API / health / share calls will fail with 502 instead of being
  // forwarded) — useful for pure UI work when the backend is not running.
  const backendProxy: Record<string, ProxyOptions | string> =
    process.env.VITE_NO_BACKEND_PROXY?.trim() === "1" ? {} : {
      "/console/api": backendProxyTarget(backendTarget),
      "/v1": backendProxyTarget(backendTarget),
      "/health": backendProxyTarget(backendTarget),
      "/metrics": backendProxyTarget(backendTarget),
      "/share": {
        target: backendTarget,
        changeOrigin: false,
        configure: backendProxyTarget(backendTarget).configure,
        bypass: (req: IncomingMessage) => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          if (path.endsWith("/data") || path.endsWith("/issue") || path.endsWith("/stats") || path.endsWith("/stream") || path.endsWith("/popup-image")) return undefined;
          return "/index.html";
        },
      },
    };
  return {
  base: "/",
  appType: "spa",
  plugins: [multiPageRouting(), react(), tailwindcss(), precompressAssets()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort,
    proxy: backendProxy,
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: "index.html",
      },
    },
  },
  };
});
