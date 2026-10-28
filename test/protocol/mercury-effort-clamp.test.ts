import { describe, expect, test } from "bun:test";
import { clampReasoningEffort, resolveSupportedReasoningEfforts } from "../../src/protocol/translation/thinking";

/**
 * Mercury (Inception Labs) rejects every reasoning effort outside
 * `{instant, low, medium, high}` with a 400 that names the field:
 *
 *   Value error, reasoning_effort must be one of: 'instant', 'low',
 *   'medium', 'high'
 *
 * Recorded live from request `40b60777` (ZCode → `/v1/messages` → inception
 * chat wire), where a `(max)` model suffix survived the clamp because the
 * default extended ladder includes `max`.
 */
describe("Mercury reasoning effort clamping", () => {
  test("mercury chat resolves to the {instant, low, medium, high} ladder", () => {
    const supported = resolveSupportedReasoningEfforts("mercury-3", "chat");
    expect(supported).toEqual(["instant", "low", "medium", "high"]);
    // Provider-prefixed ids resolve the same way.
    expect(resolveSupportedReasoningEfforts("inception/mercury-3", "chat")).toEqual(supported);
  });

  test("a (max) request clamps down to high, never reaching the upstream", () => {
    const supported = resolveSupportedReasoningEfforts("mercury-3", "chat");
    expect(clampReasoningEffort("max", supported)).toBe("high");
    expect(clampReasoningEffort("xhigh", supported)).toBe("high");
  });

  test("levels inside the mercury ladder pass through untouched", () => {
    const supported = resolveSupportedReasoningEfforts("mercury-3", "chat");
    expect(clampReasoningEffort("high", supported)).toBe("high");
    expect(clampReasoningEffort("medium", supported)).toBe("medium");
    expect(clampReasoningEffort("low", supported)).toBe("low");
  });

  test("non-mercury models keep the extended ladder", () => {
    const supported = resolveSupportedReasoningEfforts("deepseek-v4.1-flash", "chat");
    expect(supported).toContain("max");
    expect(clampReasoningEffort("max", supported)).toBe("max");
  });
});
