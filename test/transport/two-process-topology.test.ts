/**
 * F1 — the two-process topology test.
 *
 * Multi-process is only correct when per-process state that used to be local is
 * actually shared. The single most dangerous piece is admission: each process
 * keeps its own in-memory counters, so an account limited to one in-flight
 * request would admit TWO on a two-process deployment — one per process. From
 * the outside that does not look like a misconfiguration; it looks like "the
 * limit didn't work".
 *
 * This test stands up two independent controller instances that share only
 * Redis (exactly what two processes share) and proves the shared limit holds to
 * exactly one admission. It does NOT spawn two OS processes: that needs a live
 * gateway, disposable Postgres and Redis, and an upstream barrier — which
 * belongs in the F2 harness, not in a CI test that must be fast and
 * deterministic.
 *
 * The topology resolver itself is covered in `test/config/resources.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { RedisAdmissionController } from "../../src/transport/routing/admission";
import { testRedisUrl } from "../helpers/database";

const topologyDescribe = testRedisUrl ? describe : describe.skip;
if (!testRedisUrl) {
  console.info("[test-redis] skipped: set CARTETHYIA_TEST_REDIS_URL to run the two-process topology suite");
}

/** Per-run namespace so concurrent files cannot collide. */
const RUN_ID = `topo-${crypto.randomUUID()}`;

/** A bounded candidate. `max_inflight: 1` is the shared limit under test. */
function candidate(accountId: string, maxInflight: number) {
  return {
    provider_id: "prov-topo",
    model_id: "model-topo",
    provider_account_id: accountId,
    max_inflight: maxInflight,
  } as never;
}

topologyDescribe("two-process topology — shared admission", () => {
  let client: Redis;
  /** Two controllers sharing only Redis: what two processes actually share. */
  let processA: RedisAdmissionController;
  let processB: RedisAdmissionController;

  beforeAll(async () => {
    client = new Redis(testRedisUrl as string, { maxRetriesPerRequest: 2 });
    await client.ping();
    processA = new RedisAdmissionController(client);
    processB = new RedisAdmissionController(client);
  });

  afterAll(async () => {
    await client.quit().catch(() => undefined);
  });

  test("a shared limit of 1 admits exactly one across both processes", async () => {
    const accountId = `${RUN_ID}-acct`;
    const c = candidate(accountId, 1);

    // Both processes attempt concurrently — the race that would produce two
    // admissions if the counter were process-local.
    const [a, b] = await Promise.all([processA.admit(c), processB.admit(c)]);

    const admitted = [a, b].filter((decision) => decision.admitted).length;
    // Exactly one success and one documented capacity rejection. Two successes
    // would mean the limit was enforced per-process, i.e. not at all.
    expect(admitted).toBe(1);
    const rejected = [a, b].find((decision) => !decision.admitted);
    expect(rejected?.reason).toBeDefined();

    // Release, then prove the slot is reusable: a leaked reservation would
    // wedge the account permanently, which is the other failure mode.
    await processA.release({ candidate: c } as never);
    const again = await processB.admit(c);
    expect(again.admitted).toBe(true);
    await processB.release({ candidate: c } as never);
  });

  test("two processes agree on the inflight snapshot", async () => {
    const accountId = `${RUN_ID}-snapshot`;
    const c = candidate(accountId, 5);
    const held = await processA.admit(c);
    expect(held.admitted).toBe(true);

    // Process B reads the count process A wrote. This is the mechanism routing
    // uses to order saturated candidates; a process-local snapshot would route
    // the whole fleet on one process's view of itself.
    const bucket = `prov-topo:model-topo:${accountId}`;
    const snapshot = await processB.readAccountInflight([c]);
    const counted = snapshot.get(bucket);
    expect(typeof counted).toBe("number");
    expect(counted ?? 0).toBeGreaterThanOrEqual(1);

    await processA.release({ candidate: c } as never);
  });

  test("a bounded candidate with max_inflight 0 is rejected without touching Redis", async () => {
    const c = candidate(`${RUN_ID}-zero`, 0);
    const decision = await processA.admit(c);
    expect(decision.admitted).toBe(false);
  });
});
