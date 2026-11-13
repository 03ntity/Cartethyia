/**
 * In-band tool-call scanner tests: Qwen tool-call JSON blocks, and
 * dialect-gated scanner selection in the chat SSE decoder
 * (the production selection point, `response/chat.ts`).
 */
import { describe, expect, test } from "bun:test";
import { QwenToolCallScanner } from "../../../src/protocol/translation/dialect/qwen";
import { decodeChatSseStream } from "../../../src/protocol/response/chat";
import { DEFAULT_DIALECT_POLICIES } from "../../../src/protocol/translation/dialect/rules";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/protocol/canonical-model";

// Markup tags assembled from fragments so this file carries no literal
// closing-tag bytes.
const QWEN_OPEN = "<tool_" + "call>";
const QWEN_CLOSE = "<" + "/tool_" + "call>";
const DSML_CALLS_OPEN = "<｜DSML｜ calls>";
const DSML_CALLS_CLOSE = "<" + "/｜DSML｜ calls>";
const DSML_INVOKE_OPEN = '<｜DSML｜ invoke name="web_search">';
const DSML_INVOKE_CLOSE = "<" + "/｜DSML｜ invoke>";
const DSML_PARAM_OPEN = '<｜DSML｜ parameter name="query">';
const DSML_PARAM_CLOSE = "<" + "/｜DSML｜ parameter>";

function qwenBlock(json: string): string {
  return `${QWEN_OPEN}${json}${QWEN_CLOSE}`;
}

function dsmlBlock(): string {
  return (
    `${DSML_CALLS_OPEN}${DSML_INVOKE_OPEN}` +
    `${DSML_PARAM_OPEN}ok${DSML_PARAM_CLOSE}` +
    `${DSML_INVOKE_CLOSE}${DSML_CALLS_CLOSE}`
  );
}

describe("QwenToolCallScanner", () => {
  test("recovers a complete tool-call JSON block", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    const result = scanner.push(
      `Before ${qwenBlock('{"name":"web_search","arguments":{"query":"ok"}}')} after`,
    );
    expect(result.text).toBe("Before  after");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.name).toBe("web_search");
    expect(result.calls[0]!.arguments).toContain('"query"');
  });

  test("holds a split opener across chunks", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    const first = scanner.push("x <tool");
    expect(first.text).toBe("x ");
    const second = scanner.push(`_call>{"name":"web_search","arguments":{}}${QWEN_CLOSE}`);
    expect(second.calls).toHaveLength(1);
    expect(second.text).toBe("");
  });

  test("undeclared tool names stay text", () => {
    const scanner = new QwenToolCallScanner(new Set(["safe"]));
    const result = scanner.push(qwenBlock('{"name":"unsafe","arguments":{}}'));
    expect(result.calls).toHaveLength(0);
    expect(result.text).toContain(QWEN_OPEN);
  });

  test("unterminated block is dropped on flush, not leaked", () => {
    const scanner = new QwenToolCallScanner(new Set(["web_search"]));
    scanner.push(`${QWEN_OPEN}"name":"web_search"`);
    const result = scanner.flush();
    expect(result.calls).toHaveLength(0);
    expect(result.text).toBe("");
  });
});

// ---- Production selection path (response/chat.ts) ----

function requestWithTools(): CanonicalRequest {
  return {
    model: "some-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    tools: [{ name: "web_search", jsonSchema: { type: "object" } }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  } as unknown as CanonicalRequest;
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function frame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function contentDelta(text: string): string {
  return frame({ choices: [{ delta: { content: text } }] });
}

const FINISH = frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });

async function collect(
  body: string,
  policy: (typeof DEFAULT_DIALECT_POLICIES)[keyof typeof DEFAULT_DIALECT_POLICIES],
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of decodeChatSseStream(sseStream(body), requestWithTools(), undefined, {
    dialectPolicy: policy,
  })) {
    events.push(event);
  }
  return events;
}

function toolCalls(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return events.filter((event) => event.type === "tool_call_delta");
}

describe("chat decoder in-band scanner selection", () => {
  test("qwen dialect selects the Qwen scanner", async () => {
    const events = await collect(
      contentDelta(qwenBlock('{"name":"web_search","arguments":{"query":"ok"}}')) + FINISH,
      DEFAULT_DIALECT_POLICIES.qwen,
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool_call_delta") throw new Error("no tool call");
    expect(call.name).toBe("web_search");
  });

  test("non-qwen in-band dialect selects the DSML scanner", async () => {
    const events = await collect(
      contentDelta(dsmlBlock()) + FINISH,
      DEFAULT_DIALECT_POLICIES.deepseek,
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool_call_delta") throw new Error("no tool call");
    expect(call.name).toBe("web_search");
  });

  test("the unselected grammar is not parsed: qwen block stays text under deepseek", async () => {
    // A Qwen block is not DSML; the DSML scanner must leave it as answer text
    // (it carries no DSML opener), and no tool call may surface from it.
    const events = await collect(
      contentDelta(qwenBlock('{"name":"web_search","arguments":{}}')) + FINISH,
      DEFAULT_DIALECT_POLICIES.deepseek,
    );
    expect(toolCalls(events)).toHaveLength(0);
    const text = events
      .filter((event) => event.type === "content_delta")
      .map((event) =>
        event.type === "content_delta" && event.content.kind === "text" ? event.content.text : "",
      )
      .join("");
    expect(text).toContain("tool");
  });

  test("no tools declared: markup is plain text, no calls recovered", async () => {
    const request = {
      model: "some-model",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    } as unknown as CanonicalRequest;
    const events: CanonicalEvent[] = [];
    for await (const event of decodeChatSseStream(
      sseStream(contentDelta(qwenBlock('{"name":"web_search","arguments":{}}')) + FINISH),
      request,
      undefined,
      { dialectPolicy: DEFAULT_DIALECT_POLICIES.qwen },
    )) {
      events.push(event);
    }
    expect(toolCalls(events)).toHaveLength(0);
  });
});
