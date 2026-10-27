import { expect, test } from "bun:test";
import { dsmlTailHold, parseDsmlToolCalls } from "../../../src/providers/integrations/qoder/qoder";

/**
 * The markup DeepSeek-family models write into the text stream instead of the
 * structured `tool_calls` field. Verbatim in shape from the reporting: the
 * model's tool call arrives as tags, and unparsed it reaches the caller as
 * visible prose with the tool never running.
 */
const DSML = [
  "Let me read that file.",
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="Read">',
  '<｜DSML｜parameter name="file_path" string="true">src/app.ts</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜tool_calls>",
].join("\n");

test("a DSML tool call in the text stream is recovered as a real call", () => {
  const { calls, clean } = parseDsmlToolCalls(DSML);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("Read");
  expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ file_path: "src/app.ts" });
  // The prose survives; the markup does not.
  expect(clean).toBe("Let me read that file.");
});

test("several invocations in one block are all recovered", () => {
  const two = [
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="Read"><｜DSML｜parameter name="p" string="true">a</｜DSML｜parameter></｜DSML｜invoke>',
    '<｜DSML｜invoke name="Grep"><｜DSML｜parameter name="q" string="true">b</｜DSML｜parameter></｜DSML｜invoke>',
    "</｜DSML｜tool_calls>",
  ].join("");
  const { calls } = parseDsmlToolCalls(two);
  expect(calls.map((c) => c.name)).toEqual(["Read", "Grep"]);
  expect(calls[0]?.id).not.toBe(calls[1]?.id);
});

test("invoke with no calls wrapper is still recovered", () => {
  // issue #51: upstream sometimes omits the wrapper or truncates its close.
  const bare =
    "Checking now.\n" +
    '<｜DSML｜invoke name="Bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>';
  const { calls, clean } = parseDsmlToolCalls(bare);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("Bash");
  expect(clean).toBe("Checking now.");
});

test("ordinary prose is untouched", () => {
  const prose = "Here is the file you asked about.\nNo tools needed.";
  const { calls, clean } = parseDsmlToolCalls(prose);
  expect(calls).toHaveLength(0);
  expect(clean).toBe(prose);
});

test("no calls and no invoke means nothing is recovered or cut", () => {
  // Mentioning the tag name alone is not a call: cutting prose on it would
  // lose real content.
  const { calls, clean } = parseDsmlToolCalls("text mentioning DSML with no tags");
  expect(calls).toHaveLength(0);
  expect(clean).toBe("text mentioning DSML with no tags");
});

test("a half-open DSML tag at a frame edge is held, not emitted", () => {
  // The tag may straddle two chunks, so the partial must wait for the rest.
  expect(dsmlTailHold("prose <｜DSML")).toBe("<｜DSML");
  expect(dsmlTailHold("prose <")).toBe("<");
  expect(dsmlTailHold("prose </")).toBe("</");
});

test("a complete tag is not held", () => {
  // Already closed: nothing to wait for, and holding it would stall the text.
  expect(dsmlTailHold("prose <｜DSML｜tool_calls>")).toBe("");
});

test("an unrelated angle bracket is not held", () => {
  expect(dsmlTailHold("use a < b here")).toBe("");
  expect(dsmlTailHold("no bracket at all")).toBe("");
});
