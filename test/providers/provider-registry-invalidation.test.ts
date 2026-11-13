/**
 * Re-registration must not race lazy loads.
 *
 * The console mutates BYOK rows while probes and requests are in flight, and
 * every mutation drops the provider's cached adapter/auth/quota/discovery
 * state. A load that started under the *previous* registration must therefore
 * (a) never be handed to a caller that starts after the mutation, and (b)
 * never write its result into the caches the mutation just cleared — otherwise
 * the stale module silently replaces the new registration until the next
 * restart.
 */
import { describe, expect, test } from "bun:test";
import { ProviderRegistry, type ProviderAuthentication, type ProviderRegistration } from "../../src/providers/provider-registry";
import { parseProviderId, type ProviderAdapter } from "../../src/providers/provider-contracts";

function adapter(providerId: string): ProviderAdapter {
  return { provider_id: parseProviderId(providerId) } as unknown as ProviderAdapter;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function registration(
  providerId: string,
  load: () => Promise<ProviderAdapter>,
  loadAuthentication?: () => Promise<ProviderAuthentication>,
): ProviderRegistration {
  return {
    provider_id: parseProviderId(providerId),
    load,
    ...(loadAuthentication === undefined ? {} : { loadAuthentication }),
  };
}

describe("provider registry re-registration vs in-flight loads", () => {
  test("an upsert never hands the old in-flight load to a new registration", async () => {
    const registry = new ProviderRegistry();
    const slow = deferred<ProviderAdapter>();
    registry.register(registration("genprov-a", () => slow.promise));

    // Starts the load under the first registration; it stays pending.
    const stale = registry.resolve("genprov-a");
    const replacement = adapter("genprov-a");
    registry.upsert(registration("genprov-a", async () => replacement));

    // A caller arriving after the mutation must load the new registration,
    // not await the superseded load.
    expect(await registry.resolve("genprov-a")).toBe(replacement);

    slow.resolve(adapter("genprov-a"));
    await stale;
  });

  test("a superseded load cannot repopulate the cache it was invalidated from", async () => {
    const registry = new ProviderRegistry();
    const slow = deferred<ProviderAdapter>();
    registry.register(registration("genprov-b", () => slow.promise));
    const stale = registry.resolve("genprov-b");

    const replacement = adapter("genprov-b");
    registry.upsert(registration("genprov-b", async () => replacement));
    expect(await registry.resolve("genprov-b")).toBe(replacement);

    // The old load settles *after* the upsert. Without the generation guard it
    // writes its adapter over the new one and every later resolve serves the
    // registration the operator just replaced.
    slow.resolve(adapter("genprov-b"));
    await stale;
    expect(await registry.resolve("genprov-b")).toBe(replacement);
  });

  test("the same guard covers the lazy authentication slot", async () => {
    const registry = new ProviderRegistry();
    const slow = deferred<ProviderAuthentication>();
    registry.register(
      registration("genprov-c", async () => adapter("genprov-c"), () => slow.promise),
    );
    const stale = registry.resolveAuthentication("genprov-c");

    const replacementAuth: ProviderAuthentication = {};
    registry.upsert(
      registration("genprov-c", async () => adapter("genprov-c"), async () => replacementAuth),
    );
    expect(await registry.resolveAuthentication("genprov-c")).toBe(replacementAuth);

    slow.resolve({});
    await stale;
    expect(await registry.resolveAuthentication("genprov-c")).toBe(replacementAuth);
  });

  test("unregister also invalidates in-flight state", async () => {
    const registry = new ProviderRegistry();
    const slow = deferred<ProviderAdapter>();
    registry.register(registration("genprov-d", () => slow.promise));
    const stale = registry.resolve("genprov-d");

    registry.unregister("genprov-d");
    const replacement = adapter("genprov-d");
    registry.register(registration("genprov-d", async () => replacement));
    expect(await registry.resolve("genprov-d")).toBe(replacement);

    slow.resolve(adapter("genprov-d"));
    await stale;
    expect(await registry.resolve("genprov-d")).toBe(replacement);
  });
});
