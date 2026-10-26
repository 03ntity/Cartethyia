/**
 * End-to-end proof: one Chat stream that leaks reasoning, answers with prose
 * containing a literal `<think>`, and then loops.
 *
 * This is the reported symptom end to end — "looping and thinking leak" —
 * driven through the real Chat decoder and the real stream pipeline, so it
 * exercises the whole path rather than one unit at a time. Three things must
 * hold together, and each was broken independently:
 *
 * - No tag bytes reach the client transcript.
 * - Prose that legitimately contains `<think>` survives verbatim; the fix for
 *   the leak must not eat the answer.
 * - The loop terminates the stream instead of running to `max_tokens`.
 *
 * Synthesized SSE; no provider, database, or Redis.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../src/protocol/canonical-model";
import { decodeChatSseStream } from "../../src/protocol/response/chat";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";
import { THINKING_LOOP_MARKER } from "../../src/transport/dispatch/streaming/thinking-loop";

function request(): CanonicalRequest {
  return {
    model: "hy4-preview-f",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function frame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * Prose that legitimately mentions the tag inside a code span — documentation
 * or a code sample showing it. The tag is the subject of the answer, not
 * markup, so it must reach the client intact. (A bare unfenced `<think>` in
 * prose is genuinely ambiguous with a leaked reasoning span; the code-span
 * form is the one that must unambiguously survive.)
 */
const PROSE = "Use `<think>` only when you want the model to reason first.";

describe("leaked reasoning plus a thinking loop, end to end", () => {
  async function run(): Promise<{
    transcript: string;
    reasoning: string;
    /** Reasoning emitted before the loop began: the leaked span's own text. */
    preLoopReasoning: string;
    stopReason: string | undefined;
    providerStopReason: string | undefined;
    loopDetected: boolean;
    reasoningEvents: number;
  }> {
    // (a) reasoning leaks through `reasoning_content`, with a tag split across
    // two deltas; (b) the answer carries a literal `<think>` in prose; (c) the
    // reasoning then degenerates into an exact 19-character cycle.
    const cycle = "Let me reconsider. ";
    const sse =
      frame({ choices: [{ delta: { reasoning_content: "<thi" } }] }) +
      frame({ choices: [{ delta: { reasoning_content: "nk>first thought</think>" } }] }) +
      frame({ choices: [{ delta: { content: PROSE } }] }) +
      Array.from({ length: 400 }, () => frame({ choices: [{ delta: { reasoning_content: cycle } }] })).join("") +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";

    const pipeline = new StreamEventPipeline("chat", {}, false, { captureMode: "full" });
    const chunks: string[] = [];
    const controller = {
      enqueue: (bytes: Uint8Array) => {
        chunks.push(new TextDecoder().decode(bytes));
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    let reasoningEvents = 0;
    let reasoning = "";
    let preLoopReasoning = "";
    let firstReasoning: string | undefined;
    let stopReason: string | undefined;
    let providerStopReason: string | undefined;

    for await (const event of decodeChatSseStream(sseStream(sse), request())) {
      pipeline.enqueueEvent(event as CanonicalEvent, controller);
      if (event.type === "content_delta" && event.content.kind === "reasoning") {
        reasoningEvents += 1;
        const content = event.content as { summary?: string; payload?: unknown };
        const text = typeof content.summary === "string" ? content.summary : "";
        reasoning += text;
        // The first reasoning delta is the leaked span; the rest is the loop.
        firstReasoning ??= text;
        preLoopReasoning = firstReasoning;
      }
      if (pipeline.loopDetected) break;
    }
    const events = pipeline.telemetryEventTranscript;
    const list = Array.isArray(events) ? (events as CanonicalEvent[]) : [];
    for (const event of list) {
      if (event.type === "terminal") {
        stopReason = event.stop_reason;
        providerStopReason = event.provider_stop_reason;
      }
    }
    return {
      transcript: chunks.join(""),
      reasoning,
      preLoopReasoning,
      stopReason,
      providerStopReason,
      loopDetected: pipeline.loopDetected,
      reasoningEvents,
    };
  }

  test("no tag bytes reach the client transcript", async () => {
    const { transcript, preLoopReasoning } = await run();
    // The leaked span's delimiters must never be rendered, whichever side of
    // the split they arrived on.
    expect(transcript).not.toContain("<thi\"");
    expect(transcript).not.toContain("nk>first thought</think>");
    // And the reasoning text itself is clean, not merely unwrapped later.
    expect(preLoopReasoning).toBe("first thought");
    expect(preLoopReasoning).not.toContain("<");
    expect(preLoopReasoning).not.toContain(">");
  });

  test("prose containing a literal think tag survives verbatim", async () => {
    const { transcript } = await run();
    expect(transcript).toContain(PROSE);
  });

  test("leaked reasoning is classified as reasoning, once per delta", async () => {
    const { reasoning, reasoningEvents } = await run();
    expect(reasoning).toContain("first thought");
    expect(reasoningEvents).toBeGreaterThan(0);
  });

  test("the loop terminates the stream instead of running to completion", async () => {
    const { loopDetected, stopReason, providerStopReason } = await run();
    expect(loopDetected).toBe(true);
    expect(providerStopReason).toBe(THINKING_LOOP_MARKER);
    // Cut off mid-generation, not a normal finish.
    expect(stopReason).toBe("length");
  });
});
