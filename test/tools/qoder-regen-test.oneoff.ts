/**
 * Reproduce the console regenerate path against a real sqlite handle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
process.env.CARTETHYIA_ENCRYPTION_KEY ??= Buffer.from(randomBytes(32)).toString("base64");

import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { providerAccounts, providers } from "../../src/persistence/schema";
import { createNativeIdentityOps } from "../../src/console/quota/native-identity";

const dir = mkdtempSync(join(tmpdir(), "carte-regen-"));
const sqlite = createSqliteDatabase(join(dir, "t.sqlite"));
await applySqliteMigrations(sqlite);
const { db } = buildSqliteHandle(sqlite);
await db.insert(providers).values({ id: "qoder" });
const [row] = await db
  .insert(providerAccounts)
  .values({ providerId: "qoder", label: "test", credentialKind: "api_key", credentialFingerprint: randomUUID() })
  .returning({ id: providerAccounts.id });

const ops = createNativeIdentityOps(db);
const result = await ops.regenerate(row!.id, null);
console.log("regenerate:", result ? JSON.stringify({
  token: result.machineToken.slice(0, 24) + "…",
  source: (result as any).source ?? "(n/a in record)",
  seedLen: (result.seed ?? "").length,
}) : "NULL (mint failed)");
rmSync(dir, { recursive: true, force: true });
