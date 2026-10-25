/**
 * `invokeDisabled` stops every invoke for the tenant that set it.
 *
 * What needs proving is that the switch is scoped and that it is a refusal
 * rather than a routing tweak:
 *
 * - a tenant with the switch off appears in `invokeDisabledTenants`;
 * - a tenant without it does not, and one tenant switching itself off does not
 *   stop another;
 * - an absent preference means on — the switch must not trip on a tenant that
 *   has never written settings at all.
 *
 * The set is read from the cached route snapshot, which is what the `/v1/*`
 * guard consults, so asserting on the snapshot is asserting on what the guard
 * actually sees rather than on the table.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/persistence/boot";
import { consoleSettings, tenants } from "../../src/persistence/schema";
import { createDatabaseSnapshotBuilder } from "../../src/transport/routing/route-catalog";
import { dbDescribe, requireDatabase } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

requireDatabase();

dbDescribe("invokeDisabled", () => {
  let world: GatewayWorld;
  let otherTenantId: string;

  beforeAll(async () => {
    world = await createWorld();
    // A second tenant, inserted directly: `createWorld` makes one and there is
    // no helper for a second. It must be a real row because the snapshot reads
    // settings keyed by tenant id.
    const [row] = await getDb()
      .insert(tenants)
      .values({ name: "invoke-switch-other", status: "active" })
      .returning({ id: tenants.id });
    otherTenantId = row!.id;
  });

  afterAll(async () => {
    // Remove only this suite's rows. Leaving a tenant switched off would refuse
    // every `/v1/*` request for whatever runs next in this worker, which is
    // exactly how a suite starts failing depending on the order it ran in.
    await getDb()
      .delete(consoleSettings)
      .where(eq(consoleSettings.tenantId, world.tenantId))
      .catch(() => undefined);
    await getDb()
      .delete(consoleSettings)
      .where(eq(consoleSettings.tenantId, otherTenantId))
      .catch(() => undefined);
    await getDb().delete(tenants).where(eq(tenants.id, otherTenantId)).catch(() => undefined);
    await world?.cleanup();
  });

  async function writePreferences(
    tenantId: string,
    preferences: Record<string, unknown>,
  ): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  async function disabledTenants(): Promise<ReadonlySet<string>> {
    const snapshot = (await createDatabaseSnapshotBuilder(getDb())()) as unknown as {
      readonly invokeDisabledTenants?: ReadonlySet<string>;
    };
    return snapshot.invokeDisabledTenants ?? new Set<string>();
  }

  test("a tenant that switched invoke off is in the set", async () => {
    await writePreferences(world.tenantId, { invokeDisabled: true });
    expect((await disabledTenants()).has(world.tenantId)).toBe(true);
  });

  test("the switch is per tenant, not global", async () => {
    // The other tenant has no settings row at all: one tenant stopping traffic
    // must not stop everyone the gateway serves.
    await writePreferences(world.tenantId, { invokeDisabled: true });
    expect((await disabledTenants()).has(otherTenantId)).toBe(false);
  });

  test("an absent preference means invoke is on", async () => {
    // The default is off-means-on only in the sense that `invokeDisabled` is
    // absent. A tenant that never wrote settings is not switched off.
    await writePreferences(world.tenantId, {});
    expect((await disabledTenants()).has(world.tenantId)).toBe(false);
  });

  test("an explicit false keeps invoke on", async () => {
    await writePreferences(world.tenantId, { invokeDisabled: false });
    expect((await disabledTenants()).has(world.tenantId)).toBe(false);
  });

  test("two tenants can be switched off at once", async () => {
    await writePreferences(world.tenantId, { invokeDisabled: true });
    await writePreferences(otherTenantId, { invokeDisabled: true });
    const tenants = await disabledTenants();
    expect(tenants.has(world.tenantId)).toBe(true);
    expect(tenants.has(otherTenantId)).toBe(true);
  });
});
