import { describe, expect, test } from "bun:test";
import {
  asCoercedNumber,
  asNumber,
  asRecord,
  asTrimmedString,
  firstNonEmptyString,
  tryParseJson,
} from "../../src/shared/coerce";
import { sha256Hex } from "../../src/shared/hash";
import { hourStamp } from "../../src/shared/time";

describe("shared coercion primitives", () => {
  test("record and numeric coercers keep their nullish and string contracts distinct", () => {
    expect(asRecord({ value: 1 })).toEqual({ value: 1 });
    expect(asRecord([])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asNumber("42")).toBeUndefined();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asCoercedNumber(" 42 ")).toBe(42);
    expect(asCoercedNumber("  ")).toBeUndefined();
    expect(asCoercedNumber("NaN")).toBeUndefined();
  });

  test("trimmed strings and first-key selection skip empty values", () => {
    expect(asTrimmedString("  token ")).toBe("token");
    expect(asTrimmedString(" \t ")).toBeUndefined();
    expect(firstNonEmptyString({ first: " ", second: " value " }, ["first", "second"])).toBe("value");
    expect(firstNonEmptyString({ first: 42 }, ["first"])).toBeUndefined();
  });

  test("safe JSON parse fails closed and accepts JSON primitives as parsed values", () => {
    expect(tryParseJson('{"ok":true}')).toEqual({ ok: true });
    expect(tryParseJson("null")).toBeNull();
    expect(tryParseJson("not json")).toBeUndefined();
    expect(tryParseJson("")).toBeUndefined();
  });

  test("shared hashes and hour stamps preserve their wire formats", () => {
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(hourStamp(new Date("2024-02-03T16:17:18.000Z"))).toBe("2024-02-03T16");
  });
});
