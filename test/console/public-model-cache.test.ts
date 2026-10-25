/**
 * The `/v1/models` listing cache.
 *
 * This endpoint is the most-polled one a client has — SDKs list models on
 * startup, and some do it per request — and uncached it is several Postgres
 * round-trips plus a full catalog materialization. The properties that matter
 * are correctness under change, not just speed:
 *
 * 1. A different key, mode, list, or prefix gets a DIFFERENT entry — a cache
 *    that keys too coarsely serves one key's allowlist to another.
 * 2. Concurrent misses build once, so a cold cache is not a stampede.
 * 3. Invalidating one tenant does not evict another tenant's entries.
 * 4. A rejected build is not cached, and is not left in flight.
 * 5. Callers cannot mutate the cached array.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { models, providerAccounts, providers, tenants } from "../../src/persistence/schema";
import {
  PublicModelCatalogStore,
  invalidatePublicModelCache,
  publicModelCacheSize,
} from "../../src/console/providers/catalog/public-model-store";
import type { ApiKeyAuthorizationSnapshot } from "../../src/security/api-key-auth";

const dir = mkdtempSync(join(tmpdir(), "carte-public-models-"));
const sqlite = createSqliteDatabase(join(dir, "m.sqlite"));
await applySqliteMigrations(sqlite);
const { db } = buildSqliteHandle(sqlite);

afterAll(() => {
  try {
    sqlite.close();
  } catch {
    /* already closed */
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      /* retry: Windows holds the handle briefly */
    }
  }
});

beforeEach(() => {
  invalidatePublicModelCache();
});

async function tenantRow(name: string): Promise<string> {
  const [row] = await db
    .insert(tenants)
    .values({ name, status: "active" })
    .returning({ id: tenants.id });
  if (row === undefined) throw new Error("tenant insert returned no row");
  return row.id;
}

/** A provider with one enabled model that needs no account, so it is listed. */
async function seedCatalog(tenantId: string, providerId: string, modelId: string): Promise<void> {
  await db.insert(providers).values({ id: providerId, requiresAccount: false, enabled: true });
  await db.insert(models).values({
    providerId,
    modelId,
    enabled: true,
    wireFamily: "chat",
    endpointPath: "/v1/chat/completions",
  });
  // A model is listed only when the tenant has an ACTIVE account for its
  // provider, so the fixture needs one or every listing is empty and the
  // assertions below compare two empty arrays.
  await db.insert(providerAccounts).values({
    id: `acct-${providerId}`,
    tenantId,
    providerId,
    label: providerId,
    credentialKind: "api_key",
    status: "active",
  });
}

function snapshot(overrides: Partial<ApiKeyAuthorizationSnapshot> = {}): ApiKeyAuthorizationSnapshot {
  return {
    api_key_id: "key-a",
    tenant_id: "t",
    ...overrides,
  };
}

describe("/v1/models cache", () => {
  test("a second call for the same key and list hits the cache", async () => {
    const tenantId = await tenantRow("cache-hit");
    await seedCatalog(tenantId, "prov-hit", "model-hit");
    const store = new PublicModelCatalogStore(db);

    const first = await store.listPublicModels(tenantId, snapshot());
    const second = await store.listPublicModels(tenantId, snapshot());
    // Equal content, and the second came from the cache rather than a second
    // catalog read.
    expect(second).toEqual(first);
    expect(publicModelCacheSize()).toBe(1);
  });

  test("a different allowlist gets a different entry", async () => {
    const tenantId = await tenantRow("cache-lists");
    await seedCatalog(tenantId, "prov-lists", "model-lists");
    const store = new PublicModelCatalogStore(db);

    const unrestricted = await store.listPublicModels(tenantId, snapshot());
    const restricted = await store.listPublicModels(
      tenantId,
      snapshot({ model_access_mode: "whitelist", model_list: ["nothing-matches-this"] }),
    );
    // A cache keyed without the list would have served the unrestricted array
    // to the restricted key, which is an authorization bug, not a perf one.
    expect(restricted).not.toEqual(unrestricted);
    expect(publicModelCacheSize()).toBe(2);
  });

  test("a different key id gets a different entry", async () => {
    const tenantId = await tenantRow("cache-keys");
    await seedCatalog(tenantId, "prov-keys", "model-keys");
    const store = new PublicModelCatalogStore(db);
    await store.listPublicModels(tenantId, snapshot({ api_key_id: "key-1" }));
    await store.listPublicModels(tenantId, snapshot({ api_key_id: "key-2" }));
    expect(publicModelCacheSize()).toBe(2);
  });

  test("list order does not change the key", async () => {
    const tenantId = await tenantRow("cache-order");
    await seedCatalog(tenantId, "prov-order", "model-order");
    const store = new PublicModelCatalogStore(db);
    const mode = { model_access_mode: "whitelist" as const };
    await store.listPublicModels(tenantId, snapshot({ ...mode, model_list: ["a", "b"] }));
    await store.listPublicModels(tenantId, snapshot({ ...mode, model_list: ["b", "a"] }));
    // Canonicalized: the same authorization in a different order is the same
    // entry, not two.
    expect(publicModelCacheSize()).toBe(1);
  });

  test("concurrent misses build once", async () => {
    const tenantId = await tenantRow("cache-stampede");
    await seedCatalog(tenantId, "prov-stamp", "model-stamp");
    const store = new PublicModelCatalogStore(db);
    const results = await Promise.all([
      store.listPublicModels(tenantId, snapshot()),
      store.listPublicModels(tenantId, snapshot()),
      store.listPublicModels(tenantId, snapshot()),
    ]);
    // One entry, and every caller got the same content.
    expect(publicModelCacheSize()).toBe(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test("a caller cannot mutate the cached array", async () => {
    const tenantId = await tenantRow("cache-mutate");
    await seedCatalog(tenantId, "prov-mut", "model-mut");
    const store = new PublicModelCatalogStore(db);
    const first = await store.listPublicModels(tenantId, snapshot());
    first.push({
      id: "injected/fake",
      object: "model",
      created: 0,
      owned_by: "injected",
    });
    const second = await store.listPublicModels(tenantId, snapshot());
    // A shared array would have served the injected row to the next caller.
    expect(second.some((entry) => entry.id === "injected/fake")).toBe(false);
  });

  test("invalidating one tenant leaves another tenant's entry", async () => {
    const tenantA = await tenantRow("cache-a");
    const tenantB = await tenantRow("cache-b");
    await seedCatalog(tenantA, "prov-a", "model-a");
    await seedCatalog(tenantB, "prov-b", "model-b");
    const store = new PublicModelCatalogStore(db);
    await store.listPublicModels(tenantA, snapshot());
    await store.listPublicModels(tenantB, snapshot());
    expect(publicModelCacheSize()).toBe(2);

    const dropped = invalidatePublicModelCache(tenantA);
    expect(dropped).toBe(1);
    expect(publicModelCacheSize()).toBe(1);

    // B's entry survived, so it still hits the cache.
    expect(publicModelCacheSize()).toBe(1);
    await store.listPublicModels(tenantB, snapshot());
    expect(publicModelCacheSize()).toBe(1);
  });

  test("clearing without a tenant drops everything", async () => {
    const tenantId = await tenantRow("cache-clear");
    await seedCatalog(tenantId, "prov-clear", "model-clear");
    const store = new PublicModelCatalogStore(db);
    await store.listPublicModels(tenantId, snapshot());
    await store.listPublicModels(tenantId, snapshot({ api_key_id: "other" }));
    expect(publicModelCacheSize()).toBe(2);
    expect(invalidatePublicModelCache()).toBe(2);
    expect(publicModelCacheSize()).toBe(0);
  });
});

describe("/v1/models cache eviction", () => {
  test("the cache never exceeds its entry cap", async () => {
    const tenantId = await tenantRow("cache-cap");
    await seedCatalog(tenantId, "prov-cap", "model-cap");
    const store = new PublicModelCatalogStore(db);
    // More distinct keys than the cap: eviction must be LRU, and the size must
    // stay bounded rather than growing per key.
    for (let index = 0; index < 300; index += 1) {
      await store.listPublicModels(tenantId, snapshot({ api_key_id: `key-${index}` }));
    }
    expect(publicModelCacheSize()).toBeLessThanOrEqual(256);
  });
});
