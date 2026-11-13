/**
 * Z.AI envelope + app-identity helpers (`zcode/zai-envelope.ts`).
 *
 * The envelope predicate is the single owner of the `{code, success}` verdict
 * the plan-lane readers share; these tests pin the tolerance rules each call
 * site relied on before the dedup — an absent `code` is fine, `success:
 * false` and a non-ok `code` are always rejections, and `data` unwraps only
 * for records.
 */
import { describe, expect, test } from "bun:test";
import {
  ZAI_APP_VERSION,
  ZAI_PLATFORM,
  zaiAppHeaders,
  zaiDeviceMid,
  zaiEnvelopeData,
  zaiEnvelopeOk,
} from "../../src/providers/integrations/zcode/zai-envelope";

describe("zaiEnvelopeOk", () => {
  test("accepts the ok codes in every spelling", () => {
    for (const code of [0, 200, "0", "200"]) {
      expect(zaiEnvelopeOk({ code })).toBe(true);
    }
  });

  test("an absent code is tolerated — some responses carry data only", () => {
    expect(zaiEnvelopeOk({ data: {} })).toBe(true);
    expect(zaiEnvelopeOk({})).toBe(true);
  });

  test("success:false vetoes even an ok code", () => {
    expect(zaiEnvelopeOk({ code: 0, success: false })).toBe(false);
    expect(zaiEnvelopeOk({ success: false })).toBe(false);
  });

  test("a non-ok code rejects inside an HTTP 200", () => {
    expect(zaiEnvelopeOk({ code: 3001 })).toBe(false);
    expect(zaiEnvelopeOk({ code: "1113" })).toBe(false);
  });
});

describe("zaiEnvelopeData", () => {
  test("unwraps data on a successful envelope", () => {
    expect(zaiEnvelopeData({ code: 0, data: { plans: [] } })).toEqual({ plans: [] });
  });

  test("returns null for a rejected envelope", () => {
    expect(zaiEnvelopeData({ code: 3001, data: { plans: [] } })).toBeNull();
  });

  test("returns null when data is absent, null, or not a record", () => {
    expect(zaiEnvelopeData({ code: 0 })).toBeNull();
    expect(zaiEnvelopeData({ code: 0, data: null })).toBeNull();
    expect(zaiEnvelopeData({ code: 0, data: [1, 2] })).toBeNull();
    expect(zaiEnvelopeData(null)).toBeNull();
    expect(zaiEnvelopeData(undefined)).toBeNull();
  });
});

describe("zaiDeviceMid / zaiAppHeaders", () => {
  test("device mid is a stable UUID-shaped value per account", () => {
    const mid = zaiDeviceMid("account-1");
    expect(mid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(zaiDeviceMid("account-1")).toBe(mid);
    expect(zaiDeviceMid("account-2")).not.toBe(mid);
  });

  test("app headers carry the bearer, device id, and pinned app identity", () => {
    const headers = zaiAppHeaders("secret-token", "account-1");
    expect(headers["authorization"]).toBe("Bearer secret-token");
    expect(headers["x-device-mid"]).toBe(zaiDeviceMid("account-1"));
    expect(headers["x-zcode-app-version"]).toBe(ZAI_APP_VERSION);
    expect(headers["x-platform"]).toBe(ZAI_PLATFORM);
    expect(headers["x-client-language"]).toBe("en-US");
  });
});
