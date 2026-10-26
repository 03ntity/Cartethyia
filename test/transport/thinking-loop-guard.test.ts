/**
 * The thinking-loop guard at the pipeline boundary.
 *
 * The only protection this codebase had against a runaway was
 * `streamStallTimeoutMs`, which fires when the stream goes *silent*. A model
 * emitting a degenerate repeated chain-of-thought never goes silent — it
 * streams bytes until `max_tokens` — so it ran unbounded. These tests pin both
 * directions: the guard recognizes the two loop shapes it ported, and it stays
 * off the happy path, because a false trip silently truncates a real answer.
 *
 * All fixtures are synthesized; no provider, database, or Redis is involved.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";
import {
  THINKING_LOOP_MARKER,
  ThinkingLoopDetector,
} from "../../src/transport/dispatch/streaming/thinking-loop";

const controller = {
  enqueue: () => {},
} as unknown as ReadableStreamDefaultController<Uint8Array>;

function pipeline(): StreamEventPipeline {
  return new StreamEventPipeline("responses", {}, false, { captureMode: "full" });
}

function reasoningDelta(text: string, sequenceNumber: number): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "reasoning", payload: null, summary: text },
  };
}

function recorded(pipe: StreamEventPipeline): CanonicalEvent[] {
  const transcript = pipe.telemetryEventTranscript;
  return Array.isArray(transcript) ? (transcript as CanonicalEvent[]) : [];
}

/** Reasoning text one delta carries, as `reasoningTextOf` reads it. */
function reasoningOf(event: CanonicalEvent): string | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  const content = event.content as { summary?: string };
  return content.summary;
}

function terminalOf(events: readonly CanonicalEvent[]): Extract<CanonicalEvent, { type: "terminal" }> | undefined {
  for (const event of events) {
    if (event.type === "terminal") return event;
  }
  return undefined;
}

/** Feeds a text in fixed-size chunks, the way a provider streams deltas. */
function feed(detector: ThinkingLoopDetector, text: string, chunk = 64): string | undefined {
  for (let i = 0; i < text.length; i += chunk) {
    const hit = detector.push(text.slice(i, i + chunk));
    if (hit !== undefined) return hit;
  }
  return detector.flush();
}

/**
 * Varied reasoning prose with code spans — the shape real thinking has. Over
 * 3 KB, because the happy-path pin is only meaningful at a length where a
 * loop would have been recognized.
 */
const HEALTHY_REASONING = [
  "Let me work through the caching layer first. The read path checks the LRU and falls back to the database when the key misses.",
  "The `cache.get(key)` call returns undefined on a miss, which the caller then treats as a cold read and repopulates from the origin.",
  "Next, I need to consider eviction. A write-heavy workload will thrash a small cache, so the size bound matters more than the TTL here.",
  "Looking at the migration, the index on `tenant_id` covers the lookup but not the sort, so the planner may still scan and sort in memory.",
  "I should verify whether the row estimate is stale. Autovacuum last ran overnight, so the statistics may not reflect today's inserts.",
  "Another angle: the retry wrapper swallows the connection error and retries three times, which multiplies the observed latency by four.",
  "That explains the timeout reports. The fix is to bound the retry budget and surface the first failure instead of hiding it.",
  "Then there is the connection pool. Twenty connections shared across eight workers means a slow query starves every other caller.",
  "The queue depth metric confirms it: it climbs steadily through the incident window and only drains after the deploy finishes.",
  "I will check the response shape the client expects, since a missing field would fail validation downstream rather than degrade.",
  "One more check: the tool result is truncated at eight kilobytes, which hides the tail of any long file the model asked to read.",
  "Reading the schema again, the foreign key on `sessions.tenant_id` has no index of its own, so cascade deletes walk the whole table.",
  "That would show up as a lock wait during cleanup, which matches the slow query log entries clustered around the maintenance window.",
  "So the plan is: bound the retry budget, raise the pool size for the migration job only, and add the missing index.",
  "Before I commit to that, I want to rule out the simpler explanation — that the client itself retries on a 502 and triples the load.",
  "The access log settles it: one request per client id in the window, so the multiplication is entirely server side and ours to fix.",
].join("\n\n");

describe("thinking-loop detector", () => {
  test("never fires on healthy reasoning (the happy-path pin)", () => {
    // ~3 KB of varied prose with code spans. A false trip here would truncate
    // every long reasoning block, so this is the test that guards the guard.
    expect(HEALTHY_REASONING.length).toBeGreaterThan(2000);
    const detector = new ThinkingLoopDetector();
    expect(feed(detector, HEALTHY_REASONING)).toBeUndefined();
    expect(detector.detected).toBe(false);
  });

  test("fires on an exact repeated cycle and reports it idempotently", () => {
    const detector = new ThinkingLoopDetector();
    const first = feed(detector, "Let me reconsider. ".repeat(200));
    expect(first).toBeDefined();
    expect(detector.detected).toBe(true);
    // A caller that does not stop must not get a second, different reason.
    expect(detector.push("Let me reconsider. ")).toBe(first);
    expect(detector.flush()).toBe(first);
  });

  test("fires on near-duplicate paraphrased segments", () => {
    const base =
      "I need to confirm that the response handling is complete before I move on to the next step, and that the rendering path stays safe for the caller to reuse across turns without leaking any state between them, because a leak here would corrupt the following request in ways that are very hard to reproduce later in the session lifecycle.";
    // One word of cosmetic drift, so the paragraphs are near-identical by word
    // trigram but not byte-identical — the shape an exact-cycle check misses.
    const drift = base.replace("stays safe", "remains safe");
    const varied = [
      "First I will check the cache layer, because a cold read here doubles the observed latency and masks the real problem.",
      "The migration added an index on tenant_id, which covers the lookup but leaves the sort ordering to the planner.",
      "Retry budgets matter: three retries on a connection error multiply the tail latency by four and hide the first failure.",
      "Autovacuum statistics may be stale, so the row estimate the planner uses could be far from today's actual row count.",
      "The caller swallows the error, so the client sees a timeout rather than the underlying validation failure.",
      "I should also confirm the response shape the client validates against, since one missing field fails the whole check.",
      "There is a second consideration: the tool result is truncated at eight kilobytes, which hides the tail of long output.",
      "Finally, the ordering guarantee matters only within a single partition, so cross-partition reads are not comparable.",
    ];
    const detector = new ThinkingLoopDetector();
    const stream = [...varied, base, drift, base, drift].join("\n\n") + "\n\n";
    expect(feed(detector, stream, 50)).toBeDefined();
    expect(detector.detected).toBe(true);
  });

  test("does not fire on a short legitimate repetition", () => {
    // Three repeats of one phrase: under the 180-character floor the short
    // exact-cycle rule requires, and real reasoning says such things.
    const detector = new ThinkingLoopDetector();
    expect(feed(detector, "Wait, let me re-read that. ".repeat(3))).toBeUndefined();
    expect(detector.detected).toBe(false);
  });

  test("disabled config reports nothing", () => {
    const detector = new ThinkingLoopDetector({ enabled: false });
    expect(feed(detector, "Let me reconsider. ".repeat(400))).toBeUndefined();
    expect(detector.detected).toBe(false);
  });
});

describe("thinking-loop guard in the stream pipeline", () => {
  test("healthy reasoning streams through without an early terminal", () => {
    const pipe = pipeline();
    let sequence = 1;
    for (let i = 0; i < HEALTHY_REASONING.length; i += 64) {
      pipe.enqueueEvent(reasoningDelta(HEALTHY_REASONING.slice(i, i + 64), sequence++), controller);
    }
    expect(pipe.loopDetected).toBe(false);
    const events = recorded(pipe);
    expect(terminalOf(events)).toBeUndefined();
    // Every delta reached the client; nothing was swallowed.
    const emitted = events
      .filter((event) => event.type === "content_delta" && event.content.kind === "reasoning")
      .map((event) => reasoningOf(event) ?? "");
    expect(emitted.join("")).toBe(HEALTHY_REASONING);
  });

  test("an exact reasoning loop terminates the stream early", () => {
    const pipe = pipeline();
    const cycle = "Let me reconsider. ";
    let sequence = 1;
    for (let i = 0; i < 200; i++) {
      pipe.enqueueEvent(reasoningDelta(cycle, sequence++), controller);
      if (pipe.loopDetected) break;
    }
    expect(pipe.loopDetected).toBe(true);
    const terminal = terminalOf(recorded(pipe));
    expect(terminal).toBeDefined();
    // `length` is the honest canonical mapping: the stream was cut off
    // mid-generation. The marker rides in `provider_stop_reason` so the cut is
    // distinguishable from hitting the real token cap.
    expect(terminal?.stop_reason).toBe("length");
    expect(terminal?.provider_stop_reason).toBe(THINKING_LOOP_MARKER);
    expect(terminal?.state).toBe("complete");
  });

  test("the early terminal is the last event and keeps sequence numbers increasing", () => {
    const pipe = pipeline();
    let sequence = 1;
    for (let i = 0; i < 200; i++) {
      pipe.enqueueEvent(reasoningDelta("Let me reconsider. ", sequence++), controller);
      if (pipe.loopDetected) break;
    }
    const events = recorded(pipe);
    expect(events.at(-1)?.type).toBe("terminal");
    const numbers = events.map((event) => event.sequence_number);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]!).toBeGreaterThan(numbers[i - 1]!);
    }
  });

  test("a loop recovered from a think span in the answer also terminates early", () => {
    // The guard must catch a loop that arrives as tagged answer text, not only
    // one that a provider already classified as reasoning.
    const pipe = pipeline();
    const cycle = "Let me reconsider. ";
    let sequence = 1;
    // The span has to be open before the loop starts: only the reasoning side
    // of a split is fed to the guard.
    pipe.enqueueEvent(
      { type: "content_delta", sequence_number: sequence++, content: { kind: "text", text: "<think>" } },
      controller,
    );
    for (let i = 0; i < 200; i++) {
      pipe.enqueueEvent(
        { type: "content_delta", sequence_number: sequence++, content: { kind: "text", text: cycle } },
        controller,
      );
      if (pipe.loopDetected) break;
    }
    expect(pipe.loopDetected).toBe(true);
    expect(terminalOf(recorded(pipe))?.provider_stop_reason).toBe(THINKING_LOOP_MARKER);
  });

  test("fires only once: later reasoning deltas do not emit a second terminal", () => {
    const pipe = pipeline();
    let sequence = 1;
    for (let i = 0; i < 200; i++) {
      pipe.enqueueEvent(reasoningDelta("Let me reconsider. ", sequence++), controller);
      if (pipe.loopDetected) break;
    }
    const afterFirst = recorded(pipe).filter((event) => event.type === "terminal").length;
    pipe.enqueueEvent(reasoningDelta("Let me reconsider. ", sequence++), controller);
    pipe.enqueueEvent(
      { type: "terminal", sequence_number: sequence++, state: "complete" } as CanonicalEvent,
      controller,
    );
    const total = recorded(pipe).filter((event) => event.type === "terminal").length;
    // The guard emitted exactly one. A later delta and the upstream's own
    // terminal are dropped, not forwarded: the surface encoders reject any
    // event after a terminal, so emitting either would throw mid-stream.
    expect(afterFirst).toBe(1);
    expect(total).toBe(1);
  });
});
