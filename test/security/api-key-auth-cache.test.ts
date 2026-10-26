import { describe, expect, test } from "bun:test";
import { createApiKeyAuthorizationCache } from "../../src/security/api-key-auth-cache";

describe("API key L1 authorization cache", () => {
  test("positive hits expire, negative hits expire, and invalidation is indexed by key id", () => {
    const cache = createApiKeyAuthorizationCache<{ readonly id: string }>();
    const first = { id: "key-1" };

    cache.rememberPositive("hash-1", "key-1", first, 100);
    cache.rememberPositive("hash-2", "key-1", { id: "key-1" }, 100);
    expect(cache.lookup("hash-1", 3_099)).toEqual({ kind: "positive", value: first });
    expect(cache.lookup("hash-1", 3_100)).toEqual({ kind: "miss" });

    cache.rememberNegative("unknown", 100);
    expect(cache.lookup("unknown", 1_599)).toEqual({ kind: "negative" });
    expect(cache.lookup("unknown", 1_600)).toEqual({ kind: "miss" });

    cache.rememberPositive("hash-1", "key-1", first, 2_000);
    cache.rememberPositive("hash-2", "key-1", { id: "key-1" }, 2_000);
    cache.rememberPositive("hash-3", "key-2", { id: "key-2" }, 2_000);
    cache.rememberNegative("unknown", 2_000);
    cache.invalidate("key-1");
    expect(cache.lookup("hash-1", 2_001)).toEqual({ kind: "miss" });
    expect(cache.lookup("hash-2", 2_001)).toEqual({ kind: "miss" });
    expect(cache.lookup("hash-3", 2_001)).toEqual({ kind: "positive", value: { id: "key-2" } });
    expect(cache.lookup("unknown", 2_001)).toEqual({ kind: "miss" });
  });

  test("store-failure cooldown blocks only through its exact deadline", () => {
    const cache = createApiKeyAuthorizationCache<string>();
    cache.markStoreUnavailable(100);
    expect(cache.isStoreUnavailable(1_099)).toBe(true);
    expect(cache.isStoreUnavailable(1_100)).toBe(false);
  });
});
