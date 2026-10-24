/**
 * The two admin actions the menu and the tray both offer.
 *
 * Both go through the running gateway rather than the database file: the
 * gateway holds the connection and the schema is dialect-dependent, so reading
 * or writing the tables from this process would need a second implementation
 * of both.
 */

import { ENV_PATH, readEnvFile } from "./env";

/**
 * Asks the gateway to write a gzipped config backup into the download
 * directory. Returns the written path and counts, or null when it failed.
 */
export async function exportBackup(
  port: number,
  token: string,
): Promise<{ path: string; bytes: number; counts: Record<string, number> } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/export-backup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the backup (HTTP ${response.status}). ${detail}`.trim());
      return null;
    }
    return (await response.json()) as {
      path: string;
      bytes: number;
      counts: Record<string, number>;
    };
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return null;
  }
}

/**
 * Posts the console-account reset to the running gateway.
 *
 * Returns 0 on success and 1 on any failure so the caller can print one line
 * either way.
 */
export async function resetConsoleAccount(port: number, token: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/reset-console-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-drain-token": token },
      body: JSON.stringify({ confirm: "RESET" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`The gateway refused the reset (HTTP ${response.status}). ${detail}`.trim());
      return 1;
    }
    return 0;
  } catch {
    console.error("Could not reach the gateway. Is it still running?");
    return 1;
  }
}


/**
 * Operator escape hatch: clears the console login lockout bucket.
 *
 * The lockout is keyed by `<username>:<clientIp>` and lasts an hour, and there
 * is no console surface to clear it — a locked-out operator has no way back in
 * short of editing the database by hand. This is the documented reset.
 *
 * Usage:
 *   cartethyia admin reset-lockout <username> <clientIp>
 *   cartethyia admin reset-lockout --all
 */
export async function resetLockout(args: readonly string[]): Promise<void> {
  const all = args.includes("--all");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (!all && positional.length < 2) {
    console.error("Usage: cartethyia admin reset-lockout <username> <clientIp>");
    console.error("       cartethyia admin reset-lockout --all");
    process.exit(1);
  }

  const env = await readEnvFile(ENV_PATH);
  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is not set; cannot reach the lockout table.");
    process.exit(1);
  }
  process.env.DATABASE_URL = databaseUrl;

  const { getDb, closeDb } = await import("../../src/persistence/boot");
  const { consoleLockouts } = await import("../../src/persistence/schema");
  const { eq, or } = await import("drizzle-orm");

  const db = getDb();
  try {
    if (all) {
      const cleared = await db.delete(consoleLockouts).returning({ ip: consoleLockouts.ip });
      console.log(`✓ Cleared ${cleared.length} lockout row(s).`);
      return;
    }
    const username = positional[0]!.trim().toLowerCase();
    const clientIp = positional[1]!;
    // The bucket key is `<identifier>:<ip>`; match either exact spelling so
    // an operator does not have to guess how the identifier was normalized.
    const cleared = await db
      .delete(consoleLockouts)
      .where(or(eq(consoleLockouts.ip, `${username}:${clientIp}`), eq(consoleLockouts.ip, clientIp)))
      .returning({ ip: consoleLockouts.ip });
    if (cleared.length === 0) {
      console.log(`• No lockout row for ${username}:${clientIp} (already clear).`);
    } else {
      console.log(`✓ Cleared lockout for ${cleared.map((row) => row.ip).join(", ")}.`);
    }
  } finally {
    await closeDb();
  }
}
