import { resolvePackagePath } from "../../src/config/package-paths";

export async function readRequiredBunVersion(): Promise<string> {
  const metadata: unknown = await Bun.file(resolvePackagePath("package.json")).json();
  if (metadata === null || typeof metadata !== "object" || !("engines" in metadata) ||
    metadata.engines === null || typeof metadata.engines !== "object" ||
    !("bun" in metadata.engines) || typeof metadata.engines.bun !== "string") {
    throw new Error("Cartethyia's required Bun version is unavailable in package.json");
  }
  const minimum = metadata.engines.bun.trim().replace(/^>=\s*/, "");
  if (!/^\d+(?:\.\d+){0,2}$/.test(minimum)) throw new Error(`Unsupported Bun engine requirement: ${metadata.engines.bun}`);
  return minimum;
}

export function bunVersionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export async function assertBunVersion(): Promise<void> {
  const minimum = await readRequiredBunVersion();
  if (bunVersionAtLeast(Bun.version, minimum)) return;
  throw new Error(`Bun ${minimum} or newer is required (found ${Bun.version}). Install it from https://bun.sh and run this command again.`);
}

/** Reads the version from the installed package manifest. */
export async function readInstalledVersion(): Promise<string> {
  const metadata: unknown = await Bun.file(resolvePackagePath("package.json")).json();
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("Cartethyia package version is unavailable");
  }
  return metadata.version;
}

/** Asks the npm registry for the newest published version, or null on failure. */
export async function readLatestPublishedVersion(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/cartethyia/latest", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const metadata: unknown = await response.json();
    if (
      metadata !== null &&
      typeof metadata === "object" &&
      "version" in metadata &&
      typeof metadata.version === "string"
    ) {
      return metadata.version;
    }
    return null;
  } catch {
    return null;
  }
}
