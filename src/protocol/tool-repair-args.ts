import { jsonrepair } from "jsonrepair";

/**
 * Tool arguments the client can parse.
 *
 * Copilot (and other chat bridges) stream arguments that are not strict JSON:
 * a raw control character inside a string, a trailing comma, an unquoted key.
 * The client parses the assembled string with `JSON.parse` and, on failure,
 * reports the call as `Tool <name> not found` with the parser's message
 * (`Unexpected trailing characters`, `Invalid number`).
 *
 * Repairing is delegated to `jsonrepair`, which handles the whole family of
 * near-JSON shapes (truncated objects, unquoted keys, single quotes, trailing
 * commas) instead of the two cases a hand-rolled scanner covered.
 *
 * The policy around it is unchanged and is the load-bearing part: the result
 * is parsed only to validate, and anything that does not parse *to an object*
 * is discarded in favour of the original text — a half-repaired call is worse
 * than the original error. The object check matters because `jsonrepair` will
 * happily turn arbitrary prose into a quoted JSON string, which parses but is
 * not a tool-argument object.
 */
export function repairToolArguments(raw: string): string {
  if (raw.length === 0) return "{}";
  try {
    const repaired = repairToolArgumentText(raw);
    const parsed: unknown = JSON.parse(repaired);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return repaired;
  } catch {
    return raw;
  }
}

/** Repairs near-JSON text into strict JSON. Throws when the text is unrepairable. */
function repairToolArgumentText(json: string): string {
  return jsonrepair(json);
}
