import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { resolveEnvPath } from "./env";

export interface ListenPortProbe {
  readonly status: "free" | "blocked";
  readonly code?: string;
}

/**
 * Probes the actual listener boundary rather than inferring availability from
 * an HTTP response. A non-HTTP service still owns the port when /health is
 * unreachable. The probe socket closes before the real gateway starts.
 */
export async function probeListenPort(port: number): Promise<ListenPortProbe> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ status: "blocked", ...(error.code ? { code: error.code } : {}) });
    });
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve({ status: "free" }));
    });
  });
}

export function changePortInstructions(envPath = resolveEnvPath()): string {
  return `Stop the process using this port, or change PORT in ${envPath}. ` +
    "If CARTETHYIA_PUBLIC_ORIGIN contains the old port, update it too, then start Cartethyia again.";
}

export function blockedPortMessage(port: number, envPath = resolveEnvPath()): string {
  return `Cannot start Cartethyia: port ${port} is already in use by another process. ` +
    `No process was stopped. ${changePortInstructions(envPath)}`;
}

export function listenPortErrorMessage(port: number, probe: ListenPortProbe): string {
  if (probe.code === "EADDRINUSE") return blockedPortMessage(port);
  const reason = probe.code ?? "unknown listener error";
  return `Cannot start Cartethyia: the operating system refused to listen on port ${port} (${reason}). ` +
    `Check port permissions and firewall policy, or choose another port. ${changePortInstructions()}`;
}

function readNewLogTail(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    const length = Math.min(Math.max(size - offset, 0), 8_000);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, Math.max(offset, size - length));
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString("utf8")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^at\s/.test(line) && !/^\d+\s*\|/.test(line) && !/^Bun v\d/.test(line))
      .map((line) => {
        if (line.length <= 300) return line;
        const marker = /(?:Error:|ENOENT|EADDRINUSE|address already in use)/.exec(line);
        return marker ? line.slice(marker.index, marker.index + 300) : "";
      })
      .filter((line) => line.length > 0);
    return lines.slice(-8).map((line) => line.slice(0, 300)).join("\n").slice(-1_200);
  } catch {
    return "";
  }
}

export function startupFailureMessage(
  port: number,
  exitCode: number,
  logPath: string | null,
  logOffset = 0,
): string {
  const detail = logPath ? readNewLogTail(logPath, logOffset) : "";
  const log = logPath ?? "unavailable (the config directory is not writable)";
  const lines = [
    `Cartethyia exited with code ${exitCode} before becoming ready on port ${port}.`,
  ];
  if (detail) lines.push(`Gateway error: ${detail}`);
  else lines.push("No startup error detail was captured from the gateway.");
  if (/EADDRINUSE|address already in use/i.test(detail)) {
    lines.push(blockedPortMessage(port));
  } else {
    lines.push("Correct the gateway error above, then run `carte` again. Use `cartethyia doctor` to check configuration.");
  }
  lines.push(`Startup log: ${log}`);
  return lines.join("\n");
}

export function gatewayLogPath(configDir = process.env.CARTETHYIA_CONFIG_DIR): string | null {
  return configDir ? join(configDir, "gateway.log") : null;
}
