/**
 * A key's name must survive both things the share dialog calls "regenerate".
 *
 * They are different operations and neither may touch the label:
 *
 * 1. **Rotating the credential** (`POST /regenerate`) — a personal key gets a
 *    new secret. The patch carries only credential fields, so the label is
 *    left as-is.
 * 2. **Rotating the link** (`POST /share` with `regenerate`) — a share
 *    template's URL is replaced in place. Only `share_links` is updated.
 *
 * The console reads the name from the same list endpoint either way, so a
 * wiped label would surface as a nameless credential in the overview while
 * the key itself kept routing — the failure this pins.
 */
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import * as fullSchema from "../../src/persistence/schema";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { DrizzleShareLinkStore } from "../../src/persistence/stores/share-store";
import { createApiKeyOperations } from "../../src/console/api-keys/routes";
import { TENANT_KEY_SCOPES } from "../../src/security/access-control";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { createRunId, dbDescribe, requireDatabase, withRollback } from "../helpers/database";
import { createApiKey, createTenant } from "../helpers/fixtures";

requireDatabase();

const RUN_ID = createRunId("api-key-regenerate-label");

/** Tenant-scoped write access, as the console grants a signed-in owner. */
function owner(tenantId: string) {
  return { tenantId, scopes: ["dashboard:read", "dashboard:write"] } as never;
}

function operationsFor(db: CartethyiaDatabase, tenantId: string) {
  return createApiKeyOperations({
    store: new DrizzleApiKeyStore(db as never),
    shareStore: new DrizzleShareLinkStore(db as never),
    accessResolver: () => owner(tenantId),
    admissionService: { purgeKey: async () => undefined },
  });
}

dbDescribe("key label across regeneration", () => {
  test("survives rotating a personal key's credential", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      await createApiKey(client, {
        tenantId: tenant.tenantId,
        label: "My Share Key",
        keyMode: "personal",
        scopes: [...TENANT_KEY_SCOPES],
      });
      const db = drizzle(client as never, { schema: fullSchema });
      const operations = operationsFor(db, tenant.tenantId);

      const before = await operations.listKeys(owner(tenant.tenantId));
      const target = before.find((key) => key.label === "My Share Key");
      expect(target).toBeDefined();
      if (!target) return;

      await operations.regenerateKey(owner(tenant.tenantId), target.id, {});

      const after = await operations.listKeys(owner(tenant.tenantId));
      expect(after.find((key) => key.id === target.id)?.label).toBe("My Share Key");
    });
  });

  test("survives regenerating a share template's link", async () => {
    await withRollback(async (client) => {
      const tenant = await createTenant(client, RUN_ID);
      const db = drizzle(client as never, { schema: fullSchema });
      const operations = operationsFor(db, tenant.tenantId);
      // Created through the domain so the share-mode row shape is whatever
      // production writes, not a hand-rolled fixture.
      await operations.createKey(owner(tenant.tenantId), {
        label: "Template Key",
        keyMode: "share",
        scopes: [...TENANT_KEY_SCOPES],
      });

      const before = await operations.listKeys(owner(tenant.tenantId));
      const target = before.find((key) => key.label === "Template Key");
      expect(target).toBeDefined();
      if (!target) return;

      await operations.shareKey(owner(tenant.tenantId), target.id, {});
      await operations.shareKey(owner(tenant.tenantId), target.id, { regenerate: true });

      const after = await operations.listKeys(owner(tenant.tenantId));
      expect(after.find((key) => key.id === target.id)?.label).toBe("Template Key");
    });
  });
});
