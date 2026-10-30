/**
 * Qoder native-identity console routes, end to end over a real SQLite
 * database. The routes are mounted on a minimal Elysia app wired with the
 * real console error handler and a switchable access resolver, so these pin
 * the wire contract: statuses, body shape, authorization, and slot
 * uniqueness.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers, tenants, type NativeIdentityRecord } from "../../src/persistence/schema";
import {
  registerNativeIdentityRoutes,
  type NativeIdentityAllocator,
} from "../../src/console/quota/native-identity";
import { consoleErrorHandler } from "../../src/console/shared/errors";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

const RECORD: NativeIdentityRecord = {
  machineToken: "imp-token",
  machineType: "x86_64_linux",
  machineCode: "imp-code",
};

function tenantOwner(tenantId: string) {
  return { tenantId, scopes: ["dashboard:read", "dashboard:write"] } as never;
}

const GLOBAL_ADMIN = { tenantId: null, scopes: ["platform:admin"] } as never;

async function makeApp(allocator?: NativeIdentityAllocator) {
  const dir = mkdtempSync(join(tmpdir(), "carte-nativeid-routes-"));
  const sqlite = createSqliteDatabase(join(dir, "t.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  await db.insert(providers).values({ id: "qoder" });

  // A mutable access decision so one app can serve tenant and admin calls.
  let access: unknown = undefined;
  const elysia = new Elysia();
  elysia.error(consoleErrorHandler("Native identity operation failed"));
  registerNativeIdentityRoutes(
    elysia,
    { db, accessResolver: () => access as never },
    allocator,
  );

  const tenant = async () => {
    const [row] = await db.insert(tenants).values({ name: "t", status: "active" }).returning({ id: tenants.id });
    return row!.id as string;
  };
  const account = async (tenantId: string | null, label: string) => {
    const [row] = await db
      .insert(providerAccounts)
      .values({
        providerId: "qoder",
        tenantId,
        label,
        credentialKind: "api_key",
        credentialFingerprint: randomUUID(),
      })
      .returning({ id: providerAccounts.id });
    return row!.id as string;
  };

  return {
    elysia,
    db,
    tenant,
    account,
    setAccess: (decision: unknown) => {
      access = decision;
    },
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      removeDir(dir);
    },
  };
}

test("GET returns null for an unbound account and the record once bound", async () => {
  const app = await makeApp();
  try {
    const tenantId = await app.tenant();
    app.setAccess(tenantOwner(tenantId));
    const accountId = await app.account(tenantId, "a");

    const get1 = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${accountId}/native-identity`));
    expect(get1.status).toBe(200);
    expect(await get1.json()).toEqual({ identity: null });

    const put = await app.elysia.handle(
      new Request(`http://localhost/provider-accounts/${accountId}/native-identity`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RECORD),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ identity: RECORD });

    const get2 = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${accountId}/native-identity`));
    expect(await get2.json()).toEqual({ identity: RECORD });
  } finally {
    app.cleanup();
  }
});

test("PUT rejects a malformed or occupied record", async () => {
  const app = await makeApp();
  try {
    const tenantId = await app.tenant();
    app.setAccess(tenantOwner(tenantId));
    const a = await app.account(tenantId, "a");
    const b = await app.account(tenantId, "b");

    const put = (accountId: string, body: unknown) =>
      app.elysia.handle(
        new Request(`http://localhost/provider-accounts/${accountId}/native-identity`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    // Missing machineType/machineCode → 422 (Elysia body schema rejection).
    const badShape = await put(a, { machineToken: "tok-only" });
    expect(badShape.status).toBe(422);

    // Empty machineToken → 400.
    const badToken = await put(a, { ...RECORD, machineToken: "" });
    expect(badToken.status).toBe(400);

    // Occupied token → 409 (requires the first bind to succeed first).
    const first = await put(a, RECORD);
    expect(first.status).toBe(200);
    const occupied = await put(b, RECORD);
    expect(occupied.status).toBe(409);
  } finally {
    app.cleanup();
  }
});

test("regenerate allocates a new device (avoiding the current one)", async () => {
  const allocator: NativeIdentityAllocator = async ({ providerId, avoidToken }) => {
    expect(providerId).toBe("qoder");
    expect(avoidToken).toBe(RECORD.machineToken);
    return { machineToken: "new-token", machineType: "x86_64_linux", machineCode: "new-code" };
  };
  const app = await makeApp(allocator);
  try {
    const tenantId = await app.tenant();
    app.setAccess(tenantOwner(tenantId));
    const accountId = await app.account(tenantId, "a");

    await app.elysia.handle(
      new Request(`http://localhost/provider-accounts/${accountId}/native-identity`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RECORD),
      }),
    );
    const regen = await app.elysia.handle(
      new Request(`http://localhost/provider-accounts/${accountId}/native-identity/regenerate`, { method: "POST" }),
    );
    expect(regen.status).toBe(200);
    const body = (await regen.json()) as { identity: NativeIdentityRecord };
    expect(body.identity.machineToken).toBe("new-token");
  } finally {
    app.cleanup();
  }
});

test("shared accounts require platform admin; tenant accounts require the owning tenant", async () => {
  const app = await makeApp();
  try {
    const tenantId = await app.tenant();
    const shared = await app.account(null, "shared");
    const owned = await app.account(tenantId, "owned");

    // A tenant-scoped user cannot read a shared account's identity.
    app.setAccess(tenantOwner(tenantId));
    const denied = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${shared}/native-identity`));
    expect(denied.status).toBe(403);

    // Platform admin can.
    app.setAccess(GLOBAL_ADMIN);
    const adminOk = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${shared}/native-identity`));
    expect(adminOk.status).toBe(200);

    // A different tenant cannot read an owned account (reported as not-found,
    // matching the account routes' convention for out-of-scope rows).
    const otherTenant = await app.tenant();
    app.setAccess(tenantOwner(otherTenant));
    const deniedOther = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${owned}/native-identity`));
    expect(deniedOther.status).toBe(404);

    // The owning tenant can.
    app.setAccess(tenantOwner(tenantId));
    const ownerOk = await app.elysia.handle(new Request(`http://localhost/provider-accounts/${owned}/native-identity`));
    expect(ownerOk.status).toBe(200);
  } finally {
    app.cleanup();
  }
});
