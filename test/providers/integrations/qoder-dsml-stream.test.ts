import { expect, test } from "bun:test";
import { qoderBodyToCanonicalEvents } from "../../../src/providers/integrations/qoder/qoder";

/**
 * End-to-end tests through the real streaming translator.
 *
 * The parser tests prove the recovery rules; these prove the translator is
 * wired to them, because a parser nothing calls recovers nothing. Each case
 * feeds raw Qoder SSE frames and asserts on the canonical events that come
 * out, which is the boundary the caller actually sees.
 */

// Tag forms are assembled from escapes, never written as literal markup: the
// full-width bar is easy to lose in an editor, and a silently mangled copy
// would test nothing while still looking green.
const P = "\uFF5C";
const T = (n: string) => "<" + P + "DSML" + P + n + ">";
const C = (n: string) => "</" + P + "DSML" + P + n + ">";

function frame(delta: Record<string, unknown>, finishReason?: string): string {
  const chunk = {
    choices: [{ delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  };
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

function body(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect(chunks: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of qoderBodyToCanonicalEvents(body(chunks), new AbortController().signal, "m")) {
    out.push(e as unknown as Record<string, unknown>);
  }
  return out;
}

const part = (e: Record<string, unknown>) => (e["content"] ?? {}) as Record<string, unknown>;

const textOf = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "content_delta").map((e) => (part(e)["text"] as string) ?? "").join("");

const thinkingOf = (ev: readonly Record<string, unknown>[]) =>
  ev.filter((e) => e["type"] === "content_delta").map((e) => (part(e)["summary"] as string) ?? "").join("");

const callsOf = (ev: readonly Record<string, unknown>[]) => ev.filter((e) => e["type"] === "tool_call_delta");

const READ =
  T("tool_calls") +
  T('invoke name="Read"') +
  T('parameter name="file_path" string="true"') +
  "a.ts" +
  C("parameter") +
  C("invoke") +
  C("tool_calls");

test("a DSML call split across chunks is recovered once, not per chunk", async () => {
  // Sliced mid-tag on purpose: the second chunk ends inside a tag, which is
  // the case a naive per-chunk regex gets wrong.
  const ev = await collect([
    frame({ content: "Reading it now." }),
    frame({ content: "\n" + READ.slice(0, 12) }),
    frame({ content: READ.slice(12, 30) }),
    frame({ content: READ.slice(30) }),
    frame({}, "stop"),
  ]);
  const calls = callsOf(ev);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.["name"]).toBe("Read");
  expect(JSON.parse((calls[0]?.["arguments_delta"] as string) ?? "{}")).toEqual({ file_path: "a.ts" });
  expect(textOf(ev).trim()).toBe("Reading it now.");
  expect(textOf(ev)).not.toContain("DSML");
});

test("a call written into the thinking channel is recovered", async () => {
  const ev = await collect([
    frame({ reasoning_content: "Let me verify." }),
    frame({ reasoning_content: "\n" + READ }),
    frame({}, "stop"),
  ]);
  expect(callsOf(ev)).toHaveLength(1);
  expect(callsOf(ev)[0]?.["name"]).toBe("Read");
  expect(thinkingOf(ev)).toContain("Let me verify.");
  expect(thinkingOf(ev)).not.toContain("DSML");
});

test("a turn whose thinking carried the call reports tool_use, not stop", async () => {
  const ev = await collect([frame({ reasoning_content: READ }), frame({}, "stop")]);
  const terminal = ev.find((e) => e["type"] === "terminal");
  expect(terminal?.["stop_reason"]).toBe("tool_use");
});

test("bare closing tags in thinking are stripped with no call present", async () => {
  // Seen in the wild as prose followed by these two, carrying no marker at all.
  const ev = await collect([
    frame({ reasoning_content: "Let me verify.\n</parameter>\n</invoke>" }),
    frame({}, "stop"),
  ]);
  expect(callsOf(ev)).toHaveLength(0);
  expect(thinkingOf(ev).trimEnd()).toBe("Let me verify.");
});

test("prose that only mentions DSML is left intact", async () => {
  // No invoke block means nothing is a call; cutting here would lose the
  // model's actual answer.
  const ev = await collect([
    frame({ content: "The marker is called DSML and it is documented." }),
    frame({}, "stop"),
  ]);
  expect(callsOf(ev)).toHaveLength(0);
  expect(textOf(ev)).toBe("The marker is called DSML and it is documented.");
});

test("a structured tool_calls field still passes through untouched", async () => {
  // The normal path must not regress now that the markup path exists.
  const ev = await collect([
    frame({ content: "calling" }),
    frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"p":"1"}' } }] }),
    frame({}, "tool_calls"),
  ]);
  expect(callsOf(ev)).toHaveLength(1);
  expect(callsOf(ev)[0]?.["call_id"]).toBe("call_1");
  expect(textOf(ev)).toBe("calling");
});

test("unparseable markup is emitted as prose rather than dropped", async () => {
  // An invoke with no closing tag: nothing can be recovered, but losing the
  // text silently would be worse than showing it.
  const ev = await collect([frame({ content: "hmm " + T('invoke name="Read"') }), frame({}, "stop")]);
  expect(callsOf(ev)).toHaveLength(0);
  expect(textOf(ev).length).toBeGreaterThan(0);
});
