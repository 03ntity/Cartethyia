import { expect, test } from "bun:test";
import { dsmlTailHold, parseDsmlToolCalls, stripDsmlCloseTags } from "../../../src/providers/integrations/qoder/qoder";

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

test("parameter values keep their wire order, matching the reference", () => {
  // The fuzzy dialect mirrors `json.dumps(params)` — no key sorting, unlike the
  // strict dialect's `sort_keys=True`. The block names `b` before `a`; the
  // serialized arguments must preserve that order.
  const block =
    '<｜DSML｜tool_calls>' +
    '<｜DSML｜invoke name="Grep">' +
    '<｜DSML｜parameter name="b" string="true">1</｜DSML｜parameter>' +
    '<｜DSML｜parameter name="a" string="true">2</｜DSML｜parameter>' +
    '</｜DSML｜invoke>' +
    '</｜DSML｜tool_calls>';
  const { calls } = parseDsmlToolCalls(block);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.arguments).toBe('{"b":"1","a":"2"}');
});

test("bare-invoke prose is cut at the last angle bracket before the call", () => {
  // Same rule as the reference: the cut lands on the last `<` before the first
  // invoke, so markup-looking prose earlier in the text still ends the cut.
  const text =
    "See <b>bold</b> here\n" +
    '<｜DSML｜invoke name="Bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>';
  const { calls, clean } = parseDsmlToolCalls(text);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("Bash");
  expect(clean).toBe("See <b>bold");
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

test("leftover closing tags are stripped from the tail", () => {
  // Seen in the thinking channel as `Let me verify.` followed by these two.
  // They carry no `DSML` marker at all, so a parser keyed on that marker
  // leaves them in place and the internal protocol shows to the user.
  expect(stripDsmlCloseTags("Let me verify.\n</parameter>\n</invoke>")).toBe("Let me verify.");
});

test("a DSML-marked closing tag is stripped too", () => {
  expect(stripDsmlCloseTags("done\n</｜DSML｜invoke>")).toBe("done");
  expect(stripDsmlCloseTags("done</｜DSML｜parameter>")).toBe("done");
});

test("several trailing tags come off in one call", () => {
  expect(stripDsmlCloseTags("prose</invoke></parameter></calls>")).toBe("prose");
});

test("a closing tag mid-text is left alone", () => {
  // Only the tail is residue. A tag in the middle is real content, and the
  // reference bridge anchors the same way for the same reason.
  expect(stripDsmlCloseTags("a</invoke>b")).toBe("a</invoke>b");
});

test("prose with no tags is unchanged", () => {
  expect(stripDsmlCloseTags("just thinking here")).toBe("just thinking here");
});
