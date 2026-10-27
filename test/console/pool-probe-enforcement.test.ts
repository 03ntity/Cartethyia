/**
 * A probe verdict must change what dispatch does, not just what the badge says.
 *
 * The probe used to store its answer and leave the pool in rotation, gated
 * behind an explicit `block: true` the dashboard never sent. The result was the
 * report that started this: every pool tested, some showing `OpenCode blocked`,
 * and dispatch still choosing a blocked one — because the verdict was a colour,
 * not a decision.
 *
 * The probe now enforces: `blocked` retires the egress for that provider, and
 * any other verdict clears a previous block so a replaced proxy returns to
 * rotation without a separate button.
 */
import { describe, expect, test } from "bun:test";
import { createNetworkPoolOperations } from "../../src/console/routing/pools/operations";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import type {
  NetworkPoolStore,
  PoolProviderProbeResult,
} from "../../src/console/routing/pools/contracts";

const POOL = "pool-1";
const PROVIDER = "opencode";
const ACCESS = {
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
} as never;

/** Only the two members this path touches; everything else is unreachable here. */
function storeReturning(status: PoolProviderProbeResult["status"]): NetworkPoolStore {
  return {
    providerProbe: async () => ({
      poolId: POOL,
      providerId: PROVIDER,
      status,
    }),
  } as unknown as NetworkPoolStore;
}

function operations(selector: NetworkPoolSelector, status: PoolProviderProbeResult["status"]) {
  return createNetworkPoolOperations({
    store: storeReturning(status),
    accessResolver: () => ACCESS,
    poolSelector: selector,
  });
}

describe("a probe enforces its own verdict", () => {
  test("blocked retires the egress for that provider", async () => {
    const selector = new NetworkPoolSelector();
    expect((await selector.isProviderCooldown(POOL, PROVIDER)).inCooldown).toBe(false);

    const result = await operations(selector, "blocked").providerProbe(ACCESS, POOL, PROVIDER);

    expect(result.blockedPool).toBe(true);
    const after = await selector.isProviderCooldown(POOL, PROVIDER);
    expect(after.inCooldown).toBe(true);
    expect(after.blocked).toBe(true);
  });

  test("the retired pool is skipped by admission", async () => {
    const selector = new NetworkPoolSelector();
    await operations(selector, "blocked").providerProbe(ACCESS, POOL, PROVIDER);

    // This is the whole point: the next dispatch must not pick it.
    const slot = await selector.tryAcquireAvailablePool([POOL], PROVIDER, { [POOL]: 10 });
    expect(slot).toBeUndefined();
    const failure = await selector.getSelectionFailure([POOL], PROVIDER, { [POOL]: 10 });
    expect(failure.reason).toBe("blocked");
  });

  test("a later allowed verdict clears the block", async () => {
    const selector = new NetworkPoolSelector();
    await operations(selector, "blocked").providerProbe(ACCESS, POOL, PROVIDER);
    expect((await selector.isProviderCooldown(POOL, PROVIDER)).inCooldown).toBe(true);

    // The operator replaced the proxy; the probe now serves. No separate
    // "unblock" step should be needed.
    const result = await operations(selector, "allowed").providerProbe(ACCESS, POOL, PROVIDER);
    expect(result.blockedPool).toBe(false);
    expect((await selector.isProviderCooldown(POOL, PROVIDER)).inCooldown).toBe(false);

    const slot = await selector.tryAcquireAvailablePool([POOL], PROVIDER, { [POOL]: 10 });
    expect(slot?.poolId).toBe(POOL);
    slot?.release();
  });

  test("a throttled verdict clears a stale block", async () => {
    // The address works; only the rate is spent. A *retired* address is the
    // wrong claim once the upstream is answering again, so the block goes.
    const selector = new NetworkPoolSelector();
    await operations(selector, "blocked").providerProbe(ACCESS, POOL, PROVIDER);
    await operations(selector, "throttled").providerProbe(ACCESS, POOL, PROVIDER);
    expect((await selector.isProviderCooldown(POOL, PROVIDER)).inCooldown).toBe(false);
  });

  test("a throttled verdict does not clear a cooldown the dispatch flagged", async () => {
    // The regression: clearing on `throttled` put a spent egress straight back
    // into rotation, so the pool kept taking hits while the console showed it
    // as already cooling. A 429 says the allowance is spent — the same fact the
    // cooldown records — so the flag must survive the probe.
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown(POOL, PROVIDER, 15 * 60 * 1000, "Provider opencode rate limit");

    await operations(selector, "throttled").providerProbe(ACCESS, POOL, PROVIDER);

    const after = await selector.isProviderCooldown(POOL, PROVIDER);
    expect(after.inCooldown).toBe(true);
    expect(after.blocked).toBe(false);
    // And the pool stays out of rotation for the provider that spent it.
    expect(await selector.tryAcquireAvailablePool([POOL], PROVIDER, { [POOL]: 10 })).toBeUndefined();
  });

  test("an unreachable probe leaves a cooldown alone", async () => {
    // A probe that never reached the upstream learned nothing about the
    // address, so it must not release it either way.
    const selector = new NetworkPoolSelector();
    await selector.flagProviderCooldown(POOL, PROVIDER, 15 * 60 * 1000, "Provider opencode rate limit");
    await operations(selector, "unreachable").providerProbe(ACCESS, POOL, PROVIDER);
    expect((await selector.isProviderCooldown(POOL, PROVIDER)).inCooldown).toBe(true);
  });
});

describe("an egress is only retired for a provider whose limits follow it", () => {
  test("a probe block on a credential-keyed provider is refused", async () => {
    // `anthropic` counts requests by credential, not by address, so a refusal
    // is the account's problem. Retiring the pool would take a healthy address
    // away from every sibling account on it.
    const selector = new NetworkPoolSelector();
    const result = await operations(selector, "blocked").providerProbe(ACCESS, POOL, "anthropic");

    expect(result.blockedPool).toBe(false);
    expect((await selector.isProviderCooldown(POOL, "anthropic")).inCooldown).toBe(false);
    expect(await selector.tryAcquireAvailablePool([POOL], "anthropic", { [POOL]: 10 })).toBeDefined();
  });
});
