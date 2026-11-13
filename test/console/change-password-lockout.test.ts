/**
 * A wrong current password on `/auth/change-password` is the same brute-force
 * surface as a wrong login password: a stolen session must not buy unbounded
 * guesses at the password it wants to replace. Failures are recorded against
 * the login lockout key (`username:clientIp`), so the same counter and lock
 * serve both routes, and a success clears it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { consoleUsers, tenants } from "../../src/persistence/schema";
import { ConsoleCredentialService } from "../../src/console/auth/credentials";
import { ConsoleLockoutService } from "../../src/console/auth/lockout";
import { ConsoleSessionService, defaultSessionCookiePolicy } from "../../src/console/auth/session-service";
import { FirstBootSetupService } from "../../src/console/auth/setup-service";
import { createConsoleAuthRoutes } from "../../src/console/auth/session";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

test("wrong current passwords on change-password count against the login lockout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-chpw-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Default", status: "active" });
    const credentialService = new ConsoleCredentialService();
    const user = await db
      .insert(consoleUsers)
      .values({
        id: randomUUID(),
        tenantId,
        username: "admin",
        passwordHash: await credentialService.hashPassword("correct"),
        isActive: true,
        isFirstBoot: false,
        isPlatformAdmin: true,
      })
      .returning({ id: consoleUsers.id });

    const lockout = new ConsoleLockoutService(db);
    const sessionService = new ConsoleSessionService(db, defaultSessionCookiePolicy);
    const setupService = new FirstBootSetupService(db, credentialService);
    const app = createConsoleAuthRoutes(
      db,
      credentialService,
      sessionService,
      lockout,
      setupService,
      defaultSessionCookiePolicy,
      { mode: "disabled" },
      () => "203.0.113.7",
    );

    const session = await sessionService.createSession(user[0]!.id, "203.0.113.7", "test");
    const cookie = `session_token=${session.sessionToken}`;
    const changePassword = (currentPassword: string) =>
      app.handle(
        new Request("http://localhost/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ currentPassword, newPassword: "a-long-enough-password" }),
        }),
      );

    // The key is the same one the login route accounts against.
    const key = "admin:203.0.113.7";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await changePassword("wrong");
      expect(response.status).toBe(401);
    }
    expect(await lockout.failureCount(key)).toBe(4);

    // The fifth failure takes the lock and answers 429 with retry-after.
    const banned = await changePassword("wrong");
    expect(banned.status).toBe(429);
    expect(banned.headers.get("retry-after")).not.toBeNull();
    expect(await lockout.remainingLockSeconds(key)).toBeGreaterThan(0);

    // A locked key refuses even a correct current password.
    const locked = await changePassword("correct");
    expect(locked.status).toBe(429);

    // A success (after clearing the lock) resets the counter, like login does.
    await lockout.clearFailures(key);
    const ok = await changePassword("correct");
    expect(ok.status).toBe(200);
    expect(await lockout.failureCount(key)).toBe(0);
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});
