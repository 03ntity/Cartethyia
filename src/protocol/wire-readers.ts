/**
 * Shared wire guards and hash helpers: the generic record/field readers every
 * protocol codec parses untyped wire JSON with, plus the small string-hash
 * utilities tool ids and file names are derived from.
 */

export type ClaudeWireObject = Record<string, unknown>;

/**
 * Object (non-array) narrowing for untyped wire JSON.
 *
 * The single record guard for the codebase. It lives in the lowest layer that
 * needs it: `transport/surface` already imports from `protocol`, so having
 * protocol import a guard from surface would create a cycle across layers.
 */
export function isRecord(value: unknown): value is ClaudeWireObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const stringValue = (value: unknown): value is string =>
  typeof value === "string";
export const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Wire guards: generic record/field readers used by protocol codecs. */
export function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

/**
 * Reads an SSE frame's `output_index` as an integer slot.
 *
 * The Responses/Codex wires address output items by a fractional-capable
 * JSON number. Callers key maps and route deltas on this value, so a
 * non-integer index must be truncated rather than rejected: a fractional
 * index still identifies the same slot. Non-finite values (`NaN`,
 * `Infinity`) are discarded so they never become a map key, and a missing or
 * non-numeric field yields `undefined` rather than `0` so an absent index
 * cannot collide with a real slot zero.
 */
export function readOutputIndex(record: Record<string, unknown>): number | undefined {
  const candidate = record["output_index"];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.trunc(candidate)
    : undefined;
}

export function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

/**
 * Shared 32-bit string hash (`hash * 31` accumulation, unsigned).
 */
export function hash32(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function hashToBase36(input: string): string {
  return hash32(input).toString(36);
}
