import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";

/**
 * Streaming tool calls must keep their arguments.
 *
 * The upstream streams one call in the OpenAI shape: the first chunk carries
 * `id` + `name` + empty `arguments`, every continuation carries only `index`
 * + the next `arguments` fragment. The translator previously synthesized a
 * fresh `call_<index>` id for each continuation chunk, so those nameless
 * fragments arrived at the encoders under an identity nobody had established
 * and were all dropped — the client saw a call whose arguments were always
 * empty (`{}`), exactly what the qoder/deepseek omp reports showed.
 *
 * Reproduced live (captured frame `acfd7b10`, 60 `tool_call_delta`s from the
 * upstream, `arguments:""` alone at the client); the fix pins the first id per
 * wire index, like the generic chat parser already does.
 */

function frame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data:${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

async function collect(chunks: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(stream, new AbortController().signal, "m")) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const calls = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "tool_call_delta");

const CALL_START: Record<string, unknown> = {
  tool_calls: [
    { function: { arguments: "", name: "echo" }, id: "call_00_full", index: 0, type: "function" },
  ],
};
const continuation = (fragment: string, wireIndex = 0) => ({
  tool_calls: [{ function: { arguments: fragment }, index: wireIndex, type: "function" }],
});

test("index-less continuation fragments rejoin the last seen call id", async () => {
  // Some bridges omit `index` on continuation chunks entirely. The fragment
  // must still land on the call the first chunk established — the generic
  // chat parser does this via `lastSeenToolId`.
  const ev = await collect([
    frame(CALL_START),
    frame({ tool_calls: [{ function: { arguments: '{"text":"a' }, type: "function" }] }),
    frame({ tool_calls: [{ function: { arguments: 'b"}' }, type: "function" }] }),
  ]);
  const deltas = calls(ev);
  for (const d of deltas) expect(d["call_id"]).toBe("call_00_full");
  expect(JSON.parse(deltas.map((d) => String(d["arguments_delta"])).join(""))).toEqual({
    text: "ab",
  });
});

test("a named fragment with a different name does not merge into the last call", async () => {
  // The name is the discriminator: a fragment that names a different tool is
  // a parallel call, not a continuation.
  const ev = await collect([
    frame(CALL_START),
    frame({ tool_calls: [{ function: { arguments: '{"text":"a"}' }, type: "function" }] }),
    frame({
      tool_calls: [
        {
          function: { arguments: '{"path":"b"}' },
          index: 1,
          type: "function",
          id: "call_01_write",
        },
      ],
    }),
  ]);
  const byId = new Map<string, string>();
  for (const d of calls(ev)) {
    const id = String(d["call_id"]);
    byId.set(id, (byId.get(id) ?? "") + String(d["arguments_delta"]));
  }
  expect(byId.get("call_00_full")).toBe('{"text":"a"}');
  expect(byId.get("call_01_write")).toBe('{"path":"b"}');
});

test("the plain-text INTL leak marker is recovered when not DSML", async () => {
  // `[assistant 请求调用工具] [{"name":…,"arguments":…}]` flows as ordinary
  // text (no DSML tags), so it was never buffered/recovered. It must still
  // become a real tool call with full arguments.
  const marker =
    "Siap, gas ya~ 🌸\n[assistant 请求调用工具]\n" +
    JSON.stringify([{ name: "echo", arguments: '{"text":"halo"}' }]);
  const ev = await collect([frame({ content: marker }), frame({}, "stop")]);
  const deltas = calls(ev);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.["name"]).toBe("echo");
  expect(JSON.parse(String(deltas[0]?.["arguments_delta"]))).toEqual({ text: "halo" });
});

test("the INTL leak marker never leaks as visible text", async () => {
  // Regression for the visible leak: the marker + JSON array flowed through as
  // a content_delta *before* the end-of-stream recovery, so the client saw
  // "assistant 请求调用工具" plus the raw JSON as message text while the tool
  // also ran. The held-back marker must never become a content_delta.
  const marker =
    "Siap, gas ya~ 🌸\n[assistant 请求调用工具]\n" +
    JSON.stringify([{ name: "echo", arguments: '{"text":"halo"}' }]);
  const ev = await collect([frame({ content: marker }), frame({}, "stop")]);
  const textDeltas = ev.filter(
    (e) =>
      e["type"] === "content_delta" &&
      String(((e["content"] as { text?: unknown } | undefined)?.text ?? "")).length > 0,
  );
  expect(textDeltas).toHaveLength(1);
  const visible = String(
    (textDeltas[0]?.["content"] as { text?: unknown } | undefined)?.text ?? "",
  );
  expect(visible).not.toContain("请求调用工具");
  expect(visible).not.toContain('"name"');
  expect(visible).toBe("Siap, gas ya~ 🌸\n");
  expect(calls(ev)).toHaveLength(1);
});

test("the leak marker split across frames is withheld then recovered", async () => {
  // The upstream may cut the marker mid-sentence: `[assistant 请求调用工`
  // arrives first, the rest in the next frame. Neither fragment may be shown
  // to the client; the assembled block becomes a tool call.
  const header = "[assistant 请求调用工";
  const tail = "具]\n" + JSON.stringify([{ name: "echo", arguments: '{"text":"hai"}' }]);
  const ev = await collect([frame({ content: header }), frame({ content: tail }), frame({}, "stop")]);
  const textDeltas = ev.filter((e) => e["type"] === "content_delta");
  expect(textDeltas).toHaveLength(0);
  const deltas = calls(ev);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.["name"]).toBe("echo");
  expect(JSON.parse(String(deltas[0]?.["arguments_delta"]))).toEqual({ text: "hai" });
});

test("a marker followed by ordinary prose is released as text, not a call", async () => {
  // The model writes about the marker without echoing a valid array: the held
  // block must be released as prose (fail-open), and no tool call emitted.
  const text = "[assistant 请求调用工具] hanya penanda, bukan panggilan beneran";
  const ev = await collect([frame({ content: text }), frame({}, "stop")]);
  const textDeltas = ev.filter((e) => e["type"] === "content_delta");
  expect(textDeltas.length).toBeGreaterThan(0);
  const joined = textDeltas
    .map((e) => String(((e["content"] as { text?: unknown } | undefined)?.text ?? "")))
    .join("");
  expect(joined).toContain("请求调用工具");
  expect(calls(ev)).toHaveLength(0);
});

test("index-identified continuation fragments rejoin the pinned call id", async () => {
  const ev = await collect([
    frame(CALL_START),
    frame(continuation('{"text"')),
    frame(continuation(': "hello')),
    frame(continuation('-qoder"}')),
    frame({}, "stop"),
  ]);
  const deltas = calls(ev);
  // The tail hold means the JSON fragments may arrive spread or joined; every
  // delta must reference the real call id, not a per-chunk `call_0` synthetic.
  for (const delta of deltas) expect(delta["call_id"]).toBe("call_00_full");
  const joined = deltas
    .map((delta) => (delta["arguments_delta"] as string) ?? "")
    .join("");
  expect(JSON.parse(joined)).toEqual({ text: "hello-qoder" });
});

test("two parallel calls keep separate identities across index 0 and 1", async () => {
  const secondStart: Record<string, unknown> = {
    tool_calls: [
      { function: { arguments: "", name: "write" }, id: "call_01_full", index: 1, type: "function" },
    ],
  };
  const ev = await collect([
    frame(CALL_START),
    frame(continuation('{"text":"a"}')),
    frame(secondStart),
    frame(continuation('{"path":"b"}', 1)),
  ]);
  const byFragment = calls(ev).map((delta) => [
    delta["call_id"],
    delta["arguments_delta"],
    delta["index"],
  ]);
  const echoFragments = byFragment.filter(([id]) => id === "call_00_full");
  const writeFragments = byFragment.filter(([id]) => id === "call_01_full");
  expect(JSON.parse(echoFragments.map(([, args]) => String(args)).join(""))).toEqual({
    text: "a",
  });
  expect(JSON.parse(writeFragments.map(([, args]) => String(args)).join(""))).toEqual({
    path: "b",
  });
});

test("a chunk carrying both id and arguments pins AND emits in one pass", async () => {
  // Some frames carry the name and a first real fragment together.
  const ev = await collect([
    frame({ tool_calls: [{ function: { arguments: '{"a":', name: "echo" }, id: "call_00_x", index: 0, type: "function" }] }),
    frame(continuation('1}')),
  ]);
  expect(JSON.parse(calls(ev).map((d) => String(d["arguments_delta"])).join(""))).toEqual({ a: 1 });
});

test("an empty-argument call is forwarded verbatim, not dropped", async () => {
  // Qoder's DeepSeek occasionally emits a native call with empty arguments and
  // never continues it. The translator must still forward it unchanged: the
  // harness's own feedback loop ("missing key") is what makes the model retry
  // with arguments. Silently dropping it here would hide the failure and leave
  // the model without the feedback it needs.
  const ev = await collect([
    frame({
      tool_calls: [
        { function: { arguments: "", name: "echo" }, id: "call_empty", index: 0, type: "function" },
      ],
    }),
    frame({}, "tool_calls"),
  ]);
  const deltas = calls(ev);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.["call_id"]).toBe("call_empty");
  expect(deltas[0]?.["name"]).toBe("echo");
  expect(deltas[0]?.["arguments_delta"]).toBe("");
});

test("an unrecoverable leak echo fails the turn instead of leaking", async () => {
  // A marker + array whose inner arguments are broken JSON (escaped outer,
  // unescaped inner quotes) cannot be salvaged. It must fail the turn — never
  // surface the protocol text as visible content.
  const badEcho =
    "[assistant 请求调用工具]\n" +
    '[' +
    '{"name":"write","arguments":"{"path":"D:/tmp/data.json","content":"{\n  "name": "jinhsi",\n  "nested": { "ok": "yes" }\n}\n"}"}' +
    ']';
  await expect(collect([frame({ content: badEcho }), frame({}, "stop")])).rejects.toThrow(
    /unparseable tool-call echo/,
  );
});

test("a parallel leak echo (unescaped, many calls) is recovered and hidden", async () => {
  // The user-facing regression: a parallel batch of tools leaks as
  // `[assistant 请求调用工具]` + JSON when the model echoes calls with their
  // inner quotes unescaped. The old single-call salvage dropped the whole
  // block, so the marker reached the client as visible text and nothing ran.
  const marker =
    "Siap, gas ya~ 🌸\n[assistant 请求调用工具]\n" +
    '[{"name":"echo","arguments":"{"text":"a"}"},' +
    '{"name":"write","arguments":"{"path":"b","content":"hi"}"}]';
  const ev = await collect([frame({ content: marker }), frame({}, "stop")]);
  const textDeltas = ev.filter(
    (e) =>
      e["type"] === "content_delta" &&
      String(((e["content"] as { text?: unknown } | undefined)?.text ?? "")).length > 0,
  );
  expect(textDeltas).toHaveLength(1);
  const visible = String(
    (textDeltas[0]?.["content"] as { text?: unknown } | undefined)?.text ?? "",
  );
  expect(visible).not.toContain("请求调用工具");
  expect(visible).toBe("Siap, gas ya~ 🌸\n");
  const deltas = calls(ev);
  expect(deltas).toHaveLength(2);
  const byName = new Map(deltas.map((d) => [String(d["name"]), String(d["arguments_delta"])]));
  expect(JSON.parse(byName.get("echo") ?? "{}")).toEqual({ text: "a" });
  expect(JSON.parse(byName.get("write") ?? "{}")).toEqual({ path: "b", content: "hi" });
});

test("the leak marker inside reasoning is recovered, not shown as thinking", async () => {
  // DeepSeek reasoning models plan their calls inside `reasoning_content`. The
  // marker there must become a tool call, not leak into the visible thinking.
  const marker =
    "rencana:\n[assistant 请求调用工具]\n" +
    JSON.stringify([{ name: "echo", arguments: '{"text":"plan"}' }]);
  const ev = await collect([frame({ reasoning_content: marker }), frame({}, "stop")]);
  const reasoningDeltas = ev.filter(
    (e) =>
      e["type"] === "content_delta" &&
      ((e["content"] as { kind?: unknown } | undefined)?.kind) === "reasoning",
  );
  const joined = reasoningDeltas
    .map((e) => String(((e["content"] as { summary?: unknown } | undefined)?.summary ?? "")))
    .join("");
  expect(joined).not.toContain("请求调用工具");
  const deltas = calls(ev);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.["name"]).toBe("echo");
  expect(JSON.parse(String(deltas[0]?.["arguments_delta"]))).toEqual({ text: "plan" });
});
