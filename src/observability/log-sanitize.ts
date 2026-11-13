/**
 * Bounded structural sanitization for log payloads.
 *
 * Its own module because both directions need it: `logger.ts` bounds what it
 * hands Pino and the console ring, and `log-ring.ts` bounds structured
 * `details` pushed by callers that never go through the logger. Putting it in
 * either one would be an import cycle.
 *
 * Depth alone does not bound a log payload. A single multi-megabyte string
 * field passes any depth cap, and so does an array of ten thousand short
 * items — either is copied in full on the request path, and a log call that
 * allocates megabytes to describe an error makes the error worse. Every
 * dimension gets a cap, and every marker is the same stable `[truncated]` so a
 * bounded line is recognizable as bounded rather than looking like content.
 *
 * String values are also secret-scrubbed here (see `redaction.ts`): this copy
 * sits on the write path of both log sinks, Pino and the console ring, so
 * scrubbing it cannot be bypassed by a new caller.
 */
import { scrubSecrets } from "./redaction";

/** Nesting levels kept. */
export const LOG_MAX_DEPTH = 5;
/** Array elements kept per array. */
export const LOG_MAX_ARRAY_ITEMS = 32;
/** Object keys kept per object. */
export const LOG_MAX_KEYS = 64;
/** Code units kept per string. */
export const LOG_MAX_STRING_CODE_UNITS = 4_096;
/**
 * Total nodes visited per copy.
 *
 * The whole-copy cap, and the one that actually stops a wide graph: depth and
 * the per-container limits bound each dimension, but a million sibling keys at
 * depth 2 passes all of them.
 */
export const LOG_MAX_NODES = 256;

/** Code units kept when rendering one console-ring line. */
export const LOG_RING_MAX_CODE_UNITS = 8_192;

/** Marker appended wherever content was dropped. */
export const LOG_TRUNCATED_MARKER = "[truncated]";
const LOG_CIRCULAR_MARKER = "[circular]";

/**
 * Input ceiling for the secret scrub.
 *
 * Keeps the regex walk bounded; the slack over `LOG_MAX_STRING_CODE_UNITS`
 * lets the scrubber see a whole credential run that straddles the kept window.
 */
const LOG_SCRUB_INPUT_CODE_UNITS = 65_536;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Truncates without splitting a surrogate pair.
 *
 * Cutting between a high and low surrogate leaves a lone half, which renders
 * as U+FFFD — a log line that looks like the data was corrupt rather than
 * merely cut short.
 */
export function truncateLogString(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  const end =
    maxCodeUnits > 0 && isHighSurrogate(value.charCodeAt(maxCodeUnits - 1))
      ? maxCodeUnits - 1
      : maxCodeUnits;
  return `${value.slice(0, end)}${LOG_TRUNCATED_MARKER}`;
}

/**
 * Scrubs credential-shaped runs out of one string, then applies the kept cap.
 *
 * Scrub before the cap, not after: a secret straddling the cut would leave its
 * readable head in the kept window (a JWT's claims are only base64url). The
 * scrubber's input is pre-bounded so its regex walk never touches an unbounded
 * string - a log call must stay bounded in every dimension - and everything
 * past the cap is dropped from the output anyway.
 */
function scrubLogString(value: string): string {
  return truncateLogString(
    scrubSecrets(truncateLogString(value, LOG_SCRUB_INPUT_CODE_UNITS)),
    LOG_MAX_STRING_CODE_UNITS,
  );
}

/**
 * A circular-safe, bounded copy.
 *
 * Cycle-guarded because a circular log arg would otherwise overflow the stack
 * mid-copy. Errors collapse to name+message — a stack is far too long for a tail
 * line, and the message already carries the cause.
 *
 * The node budget is a mutable counter object rather than a returned value:
 * a recursive walk that threaded remaining budget through every branch would
 * silently unbound any subtree that forgot to pass it along.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return decycle(value, { remaining: LOG_MAX_NODES }, new WeakSet(), 0);
}

function decycle(
  value: unknown,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return scrubLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return LOG_CIRCULAR_MARKER;
  if (depth > LOG_MAX_DEPTH) return LOG_TRUNCATED_MARKER;
  if (budget.remaining <= 0) return LOG_TRUNCATED_MARKER;
  budget.remaining -= 1;
  if (value instanceof Error) {
    return {
      name: scrubLogString(value.name),
      message: scrubLogString(value.message),
    };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, LOG_MAX_ARRAY_ITEMS)
      .map((item) => decycle(item, budget, seen, depth + 1));
    // The count is the point of a log line: "200 items, first 32 shown" reads
    // very differently from "32 items".
    if (value.length > LOG_MAX_ARRAY_ITEMS) {
      kept.push(`[truncated:${value.length - LOG_MAX_ARRAY_ITEMS} more]`);
    }
    return kept;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    if (index >= LOG_MAX_KEYS) {
      out[LOG_TRUNCATED_MARKER] = entries.length - LOG_MAX_KEYS;
      break;
    }
    out[scrubLogString(key)] = decycle(entry, budget, seen, depth + 1);
  }
  return out;
}
