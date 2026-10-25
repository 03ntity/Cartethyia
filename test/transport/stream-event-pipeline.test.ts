import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";

const EVENT_COUNT = 1_200;
const EVENT_TEXT_LENGTH = 1_024;
const USAGE = {
  input_tokens: 3,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  uncached_input_tokens: 3,
  output_tokens: 2,
  reasoning_tokens: 0,
  estimated_cost: 0,
} as const;

function contentEvent(sequenceNumber: number): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "text", text: `event-${sequenceNumber}-${"x".repeat(EVENT_TEXT_LENGTH)}` },
  };
}

describe("stream event telemetry transcript", () => {
  test("bounds diagnostic memory but preserves complete client output and terminal accounting", async () => {
    const pipeline = new StreamEventPipeline("chat", { created: 1, include_usage: false }, false);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sequenceNumber = 0; sequenceNumber < EVENT_COUNT; sequenceNumber += 1) {
          pipeline.enqueueEvent(contentEvent(sequenceNumber), controller);
        }
        pipeline.enqueueEvent(
          {
            type: "terminal",
            sequence_number: EVENT_COUNT,
            state: "complete",
            stop_reason: "stop",
            usage: USAGE,
          },
          controller,
        );
        pipeline.finishEncoders(controller);
        controller.close();
      },
    });
    const clientBody = await new Response(stream).text();
    const transcript = pipeline.telemetryEventTranscript;

    expect(pipeline.eventCount).toBe(EVENT_COUNT + 1);
    expect(clientBody).toContain("event-0-");
    expect(clientBody).toContain(`event-${EVENT_COUNT - 1}-`);
    expect(clientBody).toContain("[DONE]");
    expect(pipeline.terminal?.state).toBe("complete");
    expect(pipeline.usage).toEqual(USAGE);
    expect(Array.isArray(transcript)).toBe(false);
    if ("_truncated" in transcript) {
      expect(transcript._truncated).toBe(true);
      expect(transcript._omitted_events).toBeGreaterThan(0);
      expect(transcript.events[0]?.sequence_number).toBe(0);
      expect(transcript.events[transcript.events.length - 1]?.sequence_number).toBe(EVENT_COUNT - 1);
      expect(transcript.terminal?.state).toBe("complete");
      expect(transcript.terminal?.usage).toEqual(USAGE);
      expect(transcript.usage).toEqual(USAGE);
      expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThan(520 * 1024);
    }
  });
});
/**
 * Capture-mode gating: `none`/`metadata` tenants do not pay for diagnostics
 * they can never see.
 *
 * The transcript and the client-response copy exist to feed the terminal
 * capture's drawer panels, which only exist in `full` mode. Under gated modes
 * the pipeline must still record everything the completion path needs —
 * terminal event, usage, first-byte/content timing, reported model, event
 * count, and the client-visible flag the Responses prelude retry depends on.
 */
describe("stream event pipeline capture-mode gating", () => {
  const GATED_MODES = ["none", "metadata"] as const;

  for (const mode of GATED_MODES) {
    test(`mode ${mode}: no transcript, no client-response text, terminal/usage/timing intact`, async () => {
      const pipeline = new StreamEventPipeline(
        "chat",
        { created: 1, include_usage: false },
        false,
        { captureMode: mode },
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sequenceNumber = 0; sequenceNumber < 10; sequenceNumber += 1) {
            pipeline.enqueueEvent(contentEvent(sequenceNumber), controller);
          }
          pipeline.enqueueEvent(
            {
              type: "terminal",
              sequence_number: 10,
              state: "complete",
              stop_reason: "stop",
              usage: USAGE,
            },
            controller,
          );
          pipeline.finishEncoders(controller);
          controller.close();
        },
      });
      const clientBody = await new Response(stream).text();

      // The wire stream is unaffected: full client output still delivered.
      expect(clientBody).toContain("event-0-");
      expect(clientBody).toContain("event-9-");
      expect(clientBody).toContain("[DONE]");

      // Gated diagnostics: empty transcript and no client-response copy.
      const transcript = pipeline.telemetryEventTranscript;
      // Gated modes return the plain array form (nothing was ever recorded).
      expect(Array.isArray(transcript)).toBe(true);
      if (Array.isArray(transcript)) expect(transcript).toHaveLength(0);
      expect(pipeline.clientResponseText).toBe("");

      // Completion-path fields preserved.
      expect(pipeline.eventCount).toBe(11);
      expect(pipeline.terminal?.state).toBe("complete");
      expect(pipeline.usage).toEqual(USAGE);
      expect(pipeline.firstByteAt).not.toBeUndefined();
      expect(pipeline.firstContentDeltaAtMs).not.toBeUndefined();
      expect(pipeline.lastEventAtMs).not.toBeUndefined();
    });
  }

  test("mode full keeps the bounded transcript and client-response copy", async () => {
    const pipeline = new StreamEventPipeline(
      "chat",
      { created: 1, include_usage: false },
      false,
      { captureMode: "full" },
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pipeline.enqueueEvent(contentEvent(0), controller);
        pipeline.enqueueEvent(
          {
            type: "terminal",
            sequence_number: 1,
            state: "complete",
            stop_reason: "stop",
            usage: USAGE,
          },
          controller,
        );
        pipeline.finishEncoders(controller);
        controller.close();
      },
    });
    await new Response(stream).text();

    const transcript = pipeline.telemetryEventTranscript;
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript).toHaveLength(2);
    expect(pipeline.clientResponseText).toContain("event-0-");
    expect(pipeline.clientResponseText).toContain("[DONE]");
  });

  test("mode metadata still flips the client-visible flag for the prelude retry", async () => {
    // The Responses prelude retry keys on hasClientVisibleEvent; gating the
    // transcript must not gate the flag, or every responses stream would look
    // like a content-less prelude and retry once.
    const pipeline = new StreamEventPipeline(
      "chat",
      { created: 1, include_usage: false },
      true,
      { captureMode: "metadata" },
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pipeline.enqueueEvent(contentEvent(0), controller);
        pipeline.finishEncoders(controller);
        controller.close();
      },
    });
    await new Response(stream).text();
    expect(pipeline.hasClientVisibleEvent).toBe(true);
  });
});
