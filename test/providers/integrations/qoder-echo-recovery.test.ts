import { expect, test } from "bun:test";
import { parseQoderTextToolCalls, isQoderEchoAttempt } from "../../../src/providers/integrations/qoder/qoder-text-tools";

const MARKER = "assistant 请求调用工具";

test("a bare comma-separated echo with empty arguments is recovered", () => {
  const text = `${MARKER}\n{"name":"write","arguments":""},{"name":"write","arguments":""}`;
  const { calls, clean } = parseQoderTextToolCalls(text);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.name).toBe("write");
  expect(calls[0]!.arguments).toBe("");
  expect(calls[1]!.name).toBe("write");
  expect(clean).toBe("");
});

test("a bare comma-separated echo with JSON arguments is recovered", () => {
  const text =
    `${MARKER}\n` +
    '{"name":"write","arguments":"{\\"path\\":\\"a\\"}"},' +
    '{"name":"write","arguments":"{\\"path\\":\\"b\\"}"}';
  const { calls, clean } = parseQoderTextToolCalls(text);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "a" });
  expect(JSON.parse(calls[1]!.arguments)).toEqual({ path: "b" });
  expect(clean).toBe("");
});

test("a single-object echo with a shell command is recovered", () => {
  const text =
    `${MARKER}\n` +
    '{"name":"shell","arguments":"{\\"command\\":\\"bash tests/bootstrap.sh /d/tmp/sandbox2 --run\\",\\"workdir\\":\\"D:/tmp/sandbox\\"}"}';
  const { calls, clean } = parseQoderTextToolCalls(text);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.name).toBe("shell");
  expect(JSON.parse(calls[0]!.arguments)).toEqual({
    command: "bash tests/bootstrap.sh /d/tmp/sandbox2 --run",
    workdir: "D:/tmp/sandbox",
  });
  expect(clean).toBe("");
});

test("isQoderEchoAttempt flags marker followed by JSON only", () => {
  expect(isQoderEchoAttempt(`${MARKER}\n{"name":"write","arguments":""}`)).toBe(true);
  expect(isQoderEchoAttempt(`${MARKER}\n[{"name":"write","arguments":""}]`)).toBe(true);
  expect(isQoderEchoAttempt(`${MARKER} hanya penanda`)).toBe(false);
  expect(isQoderEchoAttempt("halo biasa")).toBe(false);
});

test("isQoderEchoAttempt flags tool-style XML/angle echoes", () => {
  expect(
    isQoderEchoAttempt(`${MARKER}\n<tool_call>\n<name>edit</name>\n<arguments>{"a":"b"}</arguments>\n</tool_call>`),
  ).toBe(true);
  expect(isQoderEchoAttempt(`${MARKER}\n<execute code="x" />`)).toBe(true);
  expect(isQoderEchoAttempt(`${MARKER}\n<{"name":"edit","arguments":"{}"}>`)).toBe(true);
  expect(isQoderEchoAttempt(`${MARKER}\nprosa biasa`)).toBe(false);
});

test("the XML tool_call echo is not parsed but is recognized as an echo", () => {
  const text = `${MARKER}\n<tool_call>\n<name>edit</name>\n<arguments>{"path":"a","oldString":"x","newString":"y"}</arguments>\n</tool_call>`;
  const { calls } = parseQoderTextToolCalls(text);
  // Not recoverable as JSON (it's XML), so no calls — but it must be flagged
  // as an echo attempt so the fail-closed path rejects it rather than leaking.
  expect(calls).toHaveLength(0);
  expect(isQoderEchoAttempt(text)).toBe(true);
});
