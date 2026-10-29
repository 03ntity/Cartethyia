import { expect, test } from "bun:test";
import { parseQoderTextToolCalls, isQoderEchoAttempt } from "../../../src/providers/integrations/qoder/qoder-text-tools";

/**
 * Pins the canonical INTL text-mode tool-call parser against the whole family
 * of shapes the upstream has produced. Every one of these leaked to the client
 * as visible text at some point; the parser is the single place that decodes
 * them, and a new upstream shape should be added here before it is shipped.
 */

const MARKER = "[assistant 请求调用工具]";

function argsOf(result: { calls: Array<{ name: string; arguments: string }> }, i: number): Record<string, unknown> {
  return JSON.parse(result.calls[i]!.arguments) as Record<string, unknown>;
}

test("a strict, well-formed array recovers every call", () => {
  const text =
    `${MARKER}\n` +
    '[{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"},' +
    '{"name":"write","arguments":"{\\"path\\":\\"b.ts\\",\\"content\\":\\"hi\\"}"}]';
  const { calls, clean } = parseQoderTextToolCalls(text, new Set(["read", "write"]));
  expect(calls).toHaveLength(2);
  expect(calls[0]!.name).toBe("read");
  expect(argsOf({ calls }, 0)).toEqual({ path: "a.ts" });
  expect(calls[1]!.name).toBe("write");
  expect(argsOf({ calls }, 1)).toEqual({ path: "b.ts", content: "hi" });
  expect(clean).toBe("");
});

test("a single object echo is recovered (not just arrays)", () => {
  const text = `assistant 请求调用工具\n{"name":"write","arguments":"{\\"path\\":\\"C:/a.txt\\",\\"content\\":\\"hi\\"}"}`;
  const { calls } = parseQoderTextToolCalls(text, new Set(["write"]));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("write");
  expect(argsOf({ calls }, 0)).toEqual({ path: "C:/a.txt", content: "hi" });
});

test("an echo with unescaped inner quotes is salvaged", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{"command":"ls -la"}"}]`;
  const { calls } = parseQoderTextToolCalls(text, new Set(["bash"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({ command: "ls -la" });
});

test("a parallel echo with unescaped inner quotes is salvaged", () => {
  const text =
    `${MARKER}\n` +
    '[{"name":"bash","arguments":"{"command":"cd x"}"},' +
    '{"name":"edit","arguments":"{"file":"a.ts","replacement":"b"}"}]';
  const { calls } = parseQoderTextToolCalls(text, new Set(["bash", "edit"]));
  expect(calls).toHaveLength(2);
  expect(argsOf({ calls }, 0)).toEqual({ command: "cd x" });
  expect(argsOf({ calls }, 1)).toEqual({ file: "a.ts", replacement: "b" });
});

test("a bare comma-separated echo (no brackets) is salvaged", () => {
  const text =
    "assistant 请求调用工具\n" +
    '{"name":"read","arguments":"{"path":"D:/a.txt"}"},' +
    '{"name":"shell","arguments":"{"command":"ls"}"}';
  const { calls } = parseQoderTextToolCalls(text, new Set(["read", "shell"]));
  expect(calls).toHaveLength(2);
  expect(argsOf({ calls }, 0)).toEqual({ path: "D:/a.txt" });
  expect(argsOf({ calls }, 1)).toEqual({ command: "ls" });
});

test("escaped quotes with literal newlines in arguments are recovered", () => {
  // The model writes multi-line content (real newlines inside the string).
  const text =
    `${MARKER}\n` +
    '{"name":"write","arguments":"{\\"path\\":\\"D:/tmp/x.md\\",\\"content\\":\\"# Env\n\nTanggal: 2026-10-29\nHost: Windows\n\\"}"}';
  const { calls } = parseQoderTextToolCalls(text, new Set(["write"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({
    path: "D:/tmp/x.md",
    content: "# Env\n\nTanggal: 2026-10-29\nHost: Windows\n",
  });
});

test("a parallel echo with literal newlines in one argument is recovered", () => {
  const text =
    `${MARKER}\n` +
    '[{"name":"read","arguments":"{\\"path\\":\\"D:/tmp/b.json\\"}"},' +
    '{"name":"write","arguments":"{\\"path\\":\\"D:/tmp/x.md\\",\\"content\\":\\"# Env\n\nTanggal: 2026-10-29\n\\"}"}]';
  const { calls } = parseQoderTextToolCalls(text, new Set(["read", "write"]));
  expect(calls).toHaveLength(2);
  expect(argsOf({ calls }, 0)).toEqual({ path: "D:/tmp/b.json" });
  expect(argsOf({ calls }, 1)).toEqual({
    path: "D:/tmp/x.md",
    content: "# Env\n\nTanggal: 2026-10-29\n",
  });
});

test("the leak echo is recovered from inside a ``` fence", () => {
  const text =
    "```json\n" +
    `${MARKER}\n` +
    '[{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}]' +
    "\n```";
  const { calls } = parseQoderTextToolCalls(text, new Set(["read"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({ path: "a.ts" });
});

test("the leak echo is recovered from the angle-bracket marker variant", () => {
  const text = '<assistant 请求调用工具>\n[{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}]';
  const { calls } = parseQoderTextToolCalls(text, new Set(["read"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({ path: "a.ts" });
});

test("the marker missing its closing bracket is still recovered", () => {
  const text = '[assistant 请求调用工具\n[{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}]';
  const { calls } = parseQoderTextToolCalls(text, new Set(["read"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({ path: "a.ts" });
});

test("trailing DSML residue after the array is tolerated", () => {
  const text =
    `${MARKER}\n` +
    '[{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}]\n</｜DSML｜parameter> </｜DSML｜invoke>';
  const { calls } = parseQoderTextToolCalls(text, new Set(["read"]));
  expect(calls).toHaveLength(1);
  expect(argsOf({ calls }, 0)).toEqual({ path: "a.ts" });
});

test("a name the caller never declared is rejected", () => {
  const text = `${MARKER}\n[{"name":"nope","arguments":"{"a":"b"}"}]`;
  expect(parseQoderTextToolCalls(text, new Set(["bash"])).calls).toHaveLength(0);
});

test("arguments that stay broken are rejected fail-open", () => {
  const text = `${MARKER}\n[{"name":"bash","arguments":"{{{ broken"}]`;
  expect(parseQoderTextToolCalls(text, new Set(["bash"])).calls).toHaveLength(0);
  const multi =
    `${MARKER}\n` +
    '[{"name":"bash","arguments":"{"command":"ls"}"},' +
    '{"name":"edit","arguments":"{{{ nope"}]';
  expect(parseQoderTextToolCalls(multi, new Set(["bash", "edit"])).calls).toHaveLength(0);
});

test("prose that merely mentions the marker is left intact", () => {
  const text = "[assistant 请求调用工具] hanya penanda, bukan panggilan beneran";
  const { calls, clean } = parseQoderTextToolCalls(text);
  expect(calls).toHaveLength(0);
  expect(clean).toBe(text);
});

test("isQoderEchoAttempt flags marker followed by JSON, not prose", () => {
  expect(
    isQoderEchoAttempt(
      "[assistant 请求调用工具]\n" +
        '[{"name":"bash","arguments":"{"command":"ls"}"}]',
    ),
  ).toBe(true);
  expect(
    isQoderEchoAttempt(
      "[assistant 请求调用工具]\n" + '{"name":"write","arguments":"{}"}',
    ),
  ).toBe(true);
  expect(isQoderEchoAttempt("[assistant 请求调用工具] hanya penanda")).toBe(false);
  expect(isQoderEchoAttempt("halo biasa tanpa marker")).toBe(false);
});
