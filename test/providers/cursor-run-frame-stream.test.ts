/**
 * RunFrameStream queue-bound tests.
 *
 * The shared per-Run queue must stay bounded while a pump is absent: idle
 * heartbeats are droppable, semantic frames are not. Overflowing the bound
 * with real frames must end the stream in an error rather than silently
 * dropping frames the next leg would need.
 */
import { describe, expect, test } from "bun:test";
import { RunFrameStream } from "../../src/providers/integrations/cursor/cursor";

const HEARTBEAT: Record<string, unknown> = { interaction_update: { heartbeat: {} } };
const SEMANTIC: Record<string, unknown> = { interaction_update: { text_delta: { text: "x" } } };

function isEnd(value: unknown): value is { __streamEnd: { kind: string }; failure: unknown } {
  return typeof value === "object" && value !== null && "__streamEnd" in value;
}

describe("RunFrameStream bound", () => {
  test("drops heartbeats first when the queue fills with no subscriber", async () => {
    const stream = new RunFrameStream();
    for (let index = 0; index < 2048; index += 1) stream.push(HEARTBEAT);
    stream.push(SEMANTIC);
    stream.end({ kind: "remote-clean-close" }, undefined);
    // Heartbeats are droppable: the semantic frame survives the bound.
    const items = stream.subscribe();
    let semantic: unknown;
    let end: unknown;
    for (;;) {
      const next = await items.next();
      if (next.done === true) break;
      if (isEnd(next.value)) {
        end = next.value;
        break;
      }
      if (semantic === undefined && next.value === SEMANTIC) semantic = next.value;
    }
    expect(semantic).toBe(SEMANTIC);
    // The only end marker is the explicit clean close — no overflow error.
    expect(end).toBeDefined();
    expect((end as { __streamEnd: { kind: string } }).__streamEnd.kind).toBe("remote-clean-close");
  });

  test("ends in remote-error when semantic frames exceed the bound", async () => {
    const stream = new RunFrameStream();
    for (let index = 0; index < 2048; index += 1) stream.push(SEMANTIC);
    stream.push(SEMANTIC);
    const items = stream.subscribe();
    let end: { __streamEnd: { kind: string }; failure: unknown } | undefined;
    for (;;) {
      const next = await items.next();
      if (next.done === true) break;
      if (isEnd(next.value)) {
        end = next.value;
        break;
      }
    }
    expect(end).toBeDefined();
    expect(end?.__streamEnd.kind).toBe("remote-error");
    expect(end?.failure).toBeDefined();
  });

  test("an active subscriber drains frames before the bound applies", async () => {
    const stream = new RunFrameStream();
    const items = stream.subscribe();
    // The consumer runs concurrently with the producer, so the queue never
    // accumulates to the idle bound.
    const consumed: unknown[] = [];
    const consumer = (async () => {
      for await (const item of items) consumed.push(item);
    })();
    for (let index = 0; index < 3000; index += 1) stream.push(SEMANTIC);
    stream.end({ kind: "remote-clean-close" }, undefined);
    await consumer;
    expect(consumed.length).toBe(3000 + 1);
    const last = consumed[consumed.length - 1];
    expect(isEnd(last)).toBe(true);
    expect((last as { __streamEnd: { kind: string } }).__streamEnd.kind).toBe("remote-clean-close");
  });
});
