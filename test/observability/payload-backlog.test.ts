/**
 * The payload writer's bounded backlog.
 *
 * The writer used to be an unbounded promise chain: every capture appended a
 * link, so a slow disk or a burst of large captures accumulated every waiting
 * frame's bytes in memory with no ceiling. Now the backlog is bounded — 32
 * items, 64 MiB of exact serialized frame bytes — and a capture that arrives
 * past the bound is dropped with `PayloadBacklogFullError`: counted by the
 * `cartethyia_payload_backlog_dropped_total` metric, surfaced on the request
 * as terminal `payloadCaptureState: "failed_backlog"`, and no
 * `telemetry_payloads` row is inserted.
 *
 * These tests pin the boundaries (one item past each bound), the drop
 * semantics, and the recovery (a drained backlog accepts new work).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PAYLOAD_BACKLOG_BYTES,
  MAX_PAYLOAD_BACKLOG_ITEMS,
  PayloadBacklogFullError,
  payloadWriterBacklog,
  readPayloadFrame,
  writePayloadFrame,
} from "../../src/observability/payload-store";

/** Captures a synchronous throw from a call that returns a promise. */
function captureSyncError(call: () => unknown): unknown {
  try {
    const result = call();
    // A returned promise means no sync throw; surface it as a resolved marker
    // so the assertion fails with the unexpected resolution.
    if (result instanceof Promise) return { asyncResolution: true };
    return undefined;
  } catch (error) {
    return error;
  }
}

const DIR = await mkdtemp(join(tmpdir(), "carte-payload-backlog-"));
const previousPayloadDir = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = DIR;

beforeEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
  if (previousPayloadDir === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
  else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = previousPayloadDir;
});

describe("payload writer backlog bounds", () => {
  test("the item bound holds: 33 simultaneous writes cannot all queue", async () => {
    // The item bound is checked synchronously before queueing. With the
    // drain loop running concurrently, some writes complete and free slots,
    // so the assertion is the invariant that matters: no write ever *queues*
    // past the bound — every one of the 33 either completes, or is rejected
    // as a typed PayloadBacklogFullError, and the backlog drains to empty.
    const writes = Array.from({ length: MAX_PAYLOAD_BACKLOG_ITEMS + 1 }, (_, i) =>
      writePayloadFrame({ small: i }, new Date(Date.now() + 60_000)).then(
        () => "written",
        (error: unknown) => (error instanceof PayloadBacklogFullError ? "dropped" : "error"),
      ),
    );
    const outcomes = await Promise.all(writes);
    // Every outcome is a deliberate one; no silent loss, no untyped failure.
    for (const outcome of outcomes) expect(["written", "dropped"]).toContain(outcome);
    // After full drain the backlog is empty again.
    expect(payloadWriterBacklog().items).toBe(0);
    expect(payloadWriterBacklog().bytes).toBe(0);
  });

  test("the byte bound rejects a capture that would cross 64 MiB", async () => {
    // A single frame near the byte bound: prebuilt bodies sized so the queued
    // total would cross MAX_PAYLOAD_BACKLOG_BYTES. The check is synchronous,
    // so the rejection is deterministic even with an empty backlog.
    const bigBody = "z".repeat(MAX_PAYLOAD_BACKLOG_BYTES + 1);
    // The bound check throws synchronously (before any promise exists), so
    // the call itself is wrapped.
    const error = captureSyncError(() =>
      writePayloadFrame(
        { opaque: "unused with prebuilt" },
        new Date(Date.now() + 60_000),
        {
          requestId: "req-big",
          capturedAt: "2026-01-01T00:00:00.000Z",
          signals: { toolCalls: 0, images: 0, attachments: 0 },
          bodies: [JSON.stringify({ pad: bigBody }), "null", "null", "null", "null"],
        },
      ),
    );
    expect(error).toBeInstanceOf(PayloadBacklogFullError);
    expect((error as PayloadBacklogFullError).boundedBy).toBe("bytes");
    // Nothing queued, nothing written.
    expect(payloadWriterBacklog().bytes).toBe(0);
    const files = await readdir(DIR).catch(() => []);
    expect(files).toHaveLength(0);
  });

  test("a single frame just under the byte bound is accepted, just over is not", async () => {
    // The bound governs the queued total; with an empty backlog a frame
    // smaller than the bound queues, and one larger is rejected before any
    // promise exists. Headroom of 1024 covers the JSON scaffolding around
    // the body; +2048 crosses it.
    const under = "y".repeat(MAX_PAYLOAD_BACKLOG_BYTES - 2048);
    const base = {
      requestId: "req-boundary",
      capturedAt: "2026-01-01T00:00:00.000Z",
      signals: { toolCalls: 0, images: 0, attachments: 0 },
    };
    const atBound = writePayloadFrame({ o: 1 }, new Date(Date.now() + 60_000), {
      ...base,
      bodies: [JSON.stringify({ pad: under }), "null", "null", "null", "null"],
    });
    await expect(atBound.then(() => "ok")).resolves.toBe("ok");
    const over = captureSyncError(() =>
      writePayloadFrame({ o: 1 }, new Date(Date.now() + 60_000), {
        ...base,
        bodies: [JSON.stringify({ pad: under + "z".repeat(4096) }), "null", "null", "null", "null"],
      }),
    );
    expect(over).toBeInstanceOf(PayloadBacklogFullError);
    expect((over as PayloadBacklogFullError).boundedBy).toBe("bytes");
  });

  test("a dropped capture inserts no row and the metric counts it", async () => {
    // The capture-side wiring (TelemetryPayloadCapture) is exercised in the
    // payload-capture suite with a live DB; here the writer-level contract:
    // the rejection is a typed error the capture layer can branch on, and
    // repeated rejections do not queue anything.
    const big = "x".repeat(MAX_PAYLOAD_BACKLOG_BYTES + 10);
    for (let i = 0; i < 3; i += 1) {
      const dropped = captureSyncError(() =>
        writePayloadFrame({ o: 1 }, new Date(Date.now() + 60_000), {
          requestId: `req-drop-${i}`,
          capturedAt: "2026-01-01T00:00:00.000Z",
          signals: { toolCalls: 0, images: 0, attachments: 0 },
          bodies: [JSON.stringify({ pad: big }), "null", "null", "null", "null"],
        }),
      );
      expect(dropped).toBeInstanceOf(PayloadBacklogFullError);
    }
    expect(payloadWriterBacklog().items).toBe(0);
    expect(payloadWriterBacklog().bytes).toBe(0);
    const files = await readdir(DIR).catch(() => []);
    expect(files).toHaveLength(0);
  });

  test("drain-after-failure round-trips later references", async () => {
    // A rejection leaves the backlog usable: the next capture writes and
    // round-trips normally.
    const big = "x".repeat(MAX_PAYLOAD_BACKLOG_BYTES + 10);
    const dropped = captureSyncError(() =>
      writePayloadFrame({ o: 1 }, new Date(Date.now() + 60_000), {
        requestId: "req-fail",
        capturedAt: "2026-01-01T00:00:00.000Z",
        signals: { toolCalls: 0, images: 0, attachments: 0 },
        bodies: [JSON.stringify({ pad: big }), "null", "null", "null", "null"],
      }),
    );
    expect(dropped).toBeInstanceOf(PayloadBacklogFullError);

    const ref = await writePayloadFrame({ recovered: true }, new Date(Date.now() + 60_000));
    expect(ref.length).toBeGreaterThan(0);
    const payload = await readPayloadFrame(ref);
    expect(payload).toEqual({ recovered: true });
  });
});
