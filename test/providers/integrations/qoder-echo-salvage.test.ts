import { expect, test } from "bun:test";
import { parseLeakedToolCalls } from "../../../src/providers/integrations/qoder/qoder";

/**
 * The model echoes a call with its inner quotes unescaped. Seen in the wild as
 * `[{"name":"bash","arguments":"{"command":"cd ..."}"}]` — not valid JSON at
 * either level, so strict parsing rejects the whole thing and the call is lost.
 */

const MARKER = "[assistant 请求调用工具]";

test("an echo with unescaped inner quotes is salvaged", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{"command":"ls -la"}"}]`;
  const { calls } = parseLeakedToolCalls(text, new Set(["bash"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("bash");
  expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ command: "ls -la" });
});

test("the salvaged call keeps every argument", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{"command":"cd x","timeout":300}"}]`;
  const { calls } = parseLeakedToolCalls(text, new Set(["bash"]));
  expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ command: "cd x", timeout: 300 });
});

test("a properly escaped echo still parses", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}]`;
  const { calls } = parseLeakedToolCalls(text, new Set(["bash"]));
  expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({ command: "ls" });
});

test("salvage does not accept a name the caller never declared", () => {
  const text = `${MARKER}\n[{"name":"nope","arguments":"{"a":"b"}"}]`;
  expect(parseLeakedToolCalls(text, new Set(["bash"])).calls).toHaveLength(0);
});

test("salvage does not accept arguments that stay broken", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{{{ broken"}]`;
  expect(parseLeakedToolCalls(text, new Set(["bash"])).calls).toHaveLength(0);
});
