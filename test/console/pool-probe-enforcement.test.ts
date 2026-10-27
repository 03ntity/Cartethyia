/**
 * A probe verdict must change what dispatch does, not just what the badge says.
 *
 * The probe used to store its answer and leave the pool in rotation, gated
 * behind an explicit `block: true` the dashboard never sent. The result was the
 * report that started this: every pool tested, some showing `OpenCode blocked`,
 * and dispatch still choosing a blocked one — because the verdict was a colour,
 * not a decision.
 *
 * The probe now enforces: `blocked` retires the egress for that provider;
 * `throttled` clears a stale retirement **and flags the measured 429 as a
 * cooldown**, because a fresh "this address is out of allowance" answer is
 * exactly when dispatch should skip it and the operator should see why — the
 * earlier rule (measure the 429, change nothing) left a rate-limited pool
 * invisible and re-selected on the next request; `allowed` clears a previous
 * block so a replaced proxy returns to rotation without a separate button.
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

/** Mirror calls the operations layer is expected to route through the store. */
interface MirrorCall {
  readonly method: "drop" | "dropAll" | "record";
  readonly providerId: string;
  readonly onlyBlocked?: boolean;
  readonly until?: number;
}

/** Only the probe and the mirror methods this path touches. */
function storeReturning(status: PoolProviderProbeResult["status"]): NetworkPoolStore {
  const mirror: MirrorCall[] = [];
  const store = {
    providerProbe: async () => ({
      poolId: POOL,
      providerId: PROVIDER,
      status,
    }),
    dropProviderCooldownMarker: async (
      _tenantId: string,
      _poolId: string,
      providerId: string,
      onlyBlocked: boolean,
    ) => {
      mirror.push({ method: "drop", providerId, onlyBlocked });
    },
    dropAllProviderCooldownMarkers: async (
      _tenantId: string,
      _poolId: string,
    ) => {
      mirror.push({ method: "dropAll", providerId: "*"});
    },
    recordProviderProbeCooldown: async (
      _tenantId: string,
      _poolId: string,
      providerId: string,
      marker: { until: number; reason: string },
    ) => {
      mirror.push({ method: "record", providerId, until: marker.until });
    },
  } as unknown as NetworkPoolStore;
  return Object.assign(store, { mirror });
}

function operations(selector: NetworkPoolSelector, status: PoolProviderProbeResult["status"]) {
  return createNetworkPoolOperations({
    store: storeReturning(status),
    accessResolver: () => ACCESS,
    poolSelector: selector,
  });
}

/** The mirror calls the last-built store captured. */
function mirror(store: NetworkPoolStore): readonly MirrorCall[] {
  return (store as NetworkPoolStore & { mirror: readonly MirrorCall[] }).mirror;
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

  test("a throttled verdict clears the stale block and flags a fresh cooldown", async () => {
    // A 429 is a measurement, not a colour: the address is serving, so the
    // retirement claim is wrong — but it is out of allowance right now, and
    // dispatch must skip it and the console must show why. The earlier rule
    // (measure, change nothing) is what produced "rate limited → refresh →
    // gone", with the pool back in rotation on the next request.
    const store = storeReturning("throttled");
    const selector = new NetworkPoolSelector();
    const ops = createNetworkPoolOperations({
      store,
      accessResolver: () => ACCESS,
      poolSelector: selector,
    });

    await ops.providerProbe(ACCESS, POOL, PROVIDER);
    await operations(selector, "blocked").providerProbe(ACCESS, POOL, PROVIDER);
    await ops.providerProbe(ACCESS, POOL, PROVIDER);

    const after = await selector.isProviderCooldown(POOL, PROVIDER);
    expect(after.inCooldown).toBe(true);
    expect(after.blocked).toBe(false);
    // The pool stays out of rotation while the allowance refills.
    expect(await selector.tryAcquireAvailablePool([POOL], PROVIDER, { [POOL]: 10 })).toBeUndefined();
    // And the mirror got the drop of the retired claim plus the fresh marker,
    // so a restart keeps what the operator just measured.
    const calls = mirror(store);
    expect(calls[0]).toEqual({ method: "drop", providerId: PROVIDER, onlyBlocked: true });
    expect(calls[1]?.method).toBe("record");
    expect(calls[1]?.providerId).toBe(PROVIDER);
    // The configured default window (1h), not the 15-minute guess.
    expect((calls[1]?.until ?? 0)).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
  });

  test("a throttled verdict does not release a cooldown the dispatch flagged", async () => {
    // The regression: clearing on `throttled` put a spent egress straight back
    // into rotation, so the pool kept taking hits while the console showed it
    // as already cooling. A 429 re-measures the same fact the cooldown records.
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
