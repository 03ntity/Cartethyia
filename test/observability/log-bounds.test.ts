/**
 * Logger bounds.
 *
 * A log call is on the request path, and an unbounded one is a request-path
 * allocation: `log.debug` with a large object used to deep-copy and stringify
 * it even when the level was filtered out, and `log.error` still does. A log
 * line that allocates megabytes to describe a failure makes the failure worse
 * — on a 2 GiB box it is the allocation that tips a shedding process over.
 *
 * The property under test is not "logging works" but "logging is bounded in
 * every dimension, and costs nothing when filtered".
 */
import { describe, expect, test } from "bun:test";
import {
  LOG_MAX_ARRAY_ITEMS,
  LOG_MAX_DEPTH,
  LOG_MAX_KEYS,
  LOG_MAX_NODES,
  LOG_MAX_STRING_CODE_UNITS,
  LOG_TRUNCATED_MARKER,
  sanitizeLogValue,
  truncateLogString,
} from "../../src/observability/log-sanitize";
import {
  CONSOLE_LOG_CAPACITY,
  CONSOLE_LOG_MAX_MESSAGE_CODE_UNITS,
  clearConsoleLogs,
  pushStructuredConsoleLog,
  getConsoleLogSnapshot,
} from "../../src/observability/log-ring";

describe("truncateLogString", () => {
  test("leaves a short string alone", () => {
    expect(truncateLogString("hello", 100)).toBe("hello");
  });

  test("marks a cut string with a stable marker", () => {
    const result = truncateLogString("x".repeat(500), 100);
    expect(result).toHaveLength(100 + LOG_TRUNCATED_MARKER.length);
    expect(result.endsWith(LOG_TRUNCATED_MARKER)).toBe(true);
  });

  test("never splits a surrogate pair", () => {
    // "😀" is a high+low surrogate pair. Cutting between them leaves a lone
    // half, which renders as U+FFFD — a line that looks like corrupt data
    // rather than a cut one.
    const emoji = "😀".repeat(50);
    const result = truncateLogString(emoji, 3);
    expect(result).not.toContain("�");
    expect(result.startsWith("😀")).toBe(true);
  });
});

describe("sanitizeLogValue", () => {
  test("passes primitives through", () => {
    expect(sanitizeLogValue(1)).toBe(1);
    expect(sanitizeLogValue(null)).toBe(null);
    expect(sanitizeLogValue(true)).toBe(true);
  });

  test("caps string length", () => {
    const result = sanitizeLogValue({ big: "y".repeat(50_000) }) as { big: string };
    expect(result.big.length).toBe(LOG_MAX_STRING_CODE_UNITS + LOG_TRUNCATED_MARKER.length);
  });

  test("caps array length and reports how many were dropped", () => {
    const result = sanitizeLogValue(Array.from({ length: 200 }, (_, i) => i)) as unknown[];
    // The kept items plus one marker carrying the dropped count: "200 items,
    // first 32 shown" reads very differently from "32 items".
    expect(result).toHaveLength(LOG_MAX_ARRAY_ITEMS + 1);
    expect(String(result[result.length - 1])).toContain("more");
  });

  test("caps key count", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 500; index += 1) wide[`k${index}`] = index;
    const result = sanitizeLogValue(wide) as Record<string, unknown>;
    expect(Object.keys(result).length).toBe(LOG_MAX_KEYS + 1);
    expect(result[LOG_TRUNCATED_MARKER]).toBe(500 - LOG_MAX_KEYS);
  });

  test("caps depth", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    let node = sanitizeLogValue(deep) as Record<string, unknown>;
    let depth = 0;
    while (typeof node === "object" && node !== null && !Array.isArray(node)) {
      depth += 1;
      node = node.nested as Record<string, unknown>;
    }
    expect(depth).toBeLessThanOrEqual(LOG_MAX_DEPTH + 1);
  });

  test("the node budget stops a wide-and-shallow graph", () => {
    // Every per-container cap is satisfied — 3 levels deep, 10 keys each — but
    // the graph is far larger than the budget. Only a whole-copy counter stops
    // this, which is why one exists.
    // Objects, not primitives: a primitive returns before the budget is
    // consulted, so a graph of a thousand numbers is cheap and correctly
    // untouched. The budget bounds CONTAINERS.
    const leaf = (): Record<string, unknown> => ({ p: 1, q: 2, r: 3 });
    const value: Record<string, unknown> = {};
    for (let a = 0; a < 40; a += 1) {
      const mid: Record<string, unknown> = {};
      for (let b = 0; b < 40; b += 1) mid[`b${b}`] = leaf();
      value[`a${a}`] = mid;
    }
    const result = sanitizeLogValue(value) as Record<string, unknown>;
    let containers = 0;
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      containers += 1;
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    };
    walk(result);
    // 1 + 40 + 1600 containers in, hard ceiling out.
    expect(containers).toBeLessThanOrEqual(LOG_MAX_NODES);
    expect(containers).toBeGreaterThan(0);
  });

  test("survives a circular reference", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    const result = sanitizeLogValue(value) as Record<string, unknown>;
    expect(result.self).toBe("[circular]");
  });

  test("collapses an Error to name and message", () => {
    const result = sanitizeLogValue(new Error("boom")) as { name: string; message: string };
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
    // No stack: a stack is far too long for a tail line, and the message
    // already carries the cause.
    expect("stack" in result).toBe(false);
  });
});

describe("console log ring", () => {
  test("bounds structured details through the same sanitizer", () => {
    clearConsoleLogs();
    pushStructuredConsoleLog("error", "upstream failed", {
      event: "request_error",
      details: { body: "z".repeat(100_000), nested: { deep: Array.from({ length: 100 }, (_, i) => i) } },
    });
    const lines = getConsoleLogSnapshot();
    const last = lines[lines.length - 1];
    const body = last?.details?.["body"];
    expect(typeof body).toBe("string");
    expect((body as string).length).toBe(LOG_MAX_STRING_CODE_UNITS + LOG_TRUNCATED_MARKER.length);
  });

  test("exports the capacity and message bound as constants", () => {
    // The console states the tail's depth, so the numbers must be readable
    // rather than buried in the module.
    expect(CONSOLE_LOG_CAPACITY).toBe(500);
    expect(CONSOLE_LOG_MAX_MESSAGE_CODE_UNITS).toBe(2_000);
  });

  test("never exceeds capacity", () => {
    clearConsoleLogs();
    for (let index = 0; index < CONSOLE_LOG_CAPACITY + 50; index += 1) {
      pushStructuredConsoleLog("info", `line ${index}`, { event: "request_start" });
    }
    expect(getConsoleLogSnapshot().length).toBe(CONSOLE_LOG_CAPACITY);
    // Oldest evicted, newest kept: a ring that kept the oldest would show a
    // stale tail while the failure being debugged has already scrolled off.
    const lines = getConsoleLogSnapshot();
    expect(lines[lines.length - 1]?.msg).toContain(`line ${CONSOLE_LOG_CAPACITY + 49}`);
  });
});
