import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateCartethyiaEncryptionKey, hasPlaceholderSecrets, readEnvFile } from "../cli/env";

const ENV_KEY = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

/** Updates only managed assignments while preserving comments and custom entries. */
export function mergeEnvText(original: string, updates: Readonly<Record<string, string>>): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.length === 0 ? [] : original.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = ENV_KEY.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    if (seen.has(key)) throw new Error(`Duplicate managed environment key: ${key}`);
    seen.add(key);
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    return `${indent}${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (/\r|\n/.test(value)) throw new Error(`Environment value for ${key} contains a newline`);
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  return `${output.join(newline)}${newline}`;
}

/** Writes a complete env update without exposing a partial file to readers. */
export async function writeEnvAtomic(
  path: string,
  updates: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const original = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const merged = mergeEnvText(original, updates);
  const temporary = join(dirname(path), `.env.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, merged, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Prevents an installer rerun from silently selecting another database. */
export function assertModeChangeAllowed(
  existing: Readonly<Record<string, string>>,
  requested: "lite" | "full",
): void {
  const current = existing.CARTETHYIA_DB_MODE?.trim();
  if (!current || current === requested) return;
  if (current !== "lite" && current !== "full") throw new Error("Existing CARTETHYIA_DB_MODE is invalid");
  throw new Error(
    `This installation uses ${current} mode; refusing to switch to ${requested}. ` +
      "Export a JSON backup, install the other mode with a new database, then import the backup.",
  );
}

/** Creates a key only for a missing/placeholder value; existing secrets survive reruns. */
export async function ensureEncryptionKey(envPath: string): Promise<string> {
  const env = await readEnvFile(envPath);
  const existing = env.CARTETHYIA_ENCRYPTION_KEY?.trim() ?? "";
  return existing && !hasPlaceholderSecrets(existing) ? existing : generateCartethyiaEncryptionKey();
}

export async function prepareStateDirectories(env: Readonly<Record<string, string>>): Promise<void> {
  const data = env.CARTETHYIA_DATA_DIR?.trim();
  if (!data) return;
  await mkdir(data, { recursive: true });
  await mkdir(env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || join(data, "telemetry-payloads"), { recursive: true });
  await mkdir(env.CARTETHYIA_INSTALL_ID_DIR?.trim() || join(data, ".cartethyia"), { recursive: true });
}
