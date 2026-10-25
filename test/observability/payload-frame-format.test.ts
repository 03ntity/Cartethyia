/**
 * On-disk payload frame format.
 *
 * Frames are stored as newline-terminated base64 lines of gzipped JSON
 * (jsonl-file). The only valid storage type is jsonl-file; the old binary
 * header shape (jsonb-file) has been fully retired.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = await mkdtemp(join(tmpdir(), "carte-payload-format-"));
const previousPayloadDir = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = DIR;

const store = await import("../../src/observability/payload-store");

beforeEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
});

afterAll(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
  await rm(DIR, { recursive: true, force: true });
  if (previousPayloadDir === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
  else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = previousPayloadDir;
});

describe("new frames", () => {
  test("a written frame is a printable text line", async () => {
    const ref = await store.writePayloadFrame({ a: 1 }, new Date(Date.now() + 60_000));
    const raw = await readFile(join(DIR, ref.file));
    // The whole point: no binary header, so the file reads as text.
    expect(raw[0]).not.toBe(0);
    expect(raw[raw.byteLength - 1]).toBe(0x0a);
    expect(/^[\x20-\x7e\n]+$/.test(raw.toString("utf8"))).toBe(true);
  });

  test("a written frame uses the .jsonl extension", async () => {
    const ref = await store.writePayloadFrame({ a: 1 }, new Date(Date.now() + 60_000));
    expect(ref.file.endsWith(".jsonl")).toBe(true);
  });

  test("a frame round-trips through write and read", async () => {
    const ref = await store.writePayloadFrame(
      { hello: "world", n: 42 },
      new Date(Date.now() + 60_000),
    );
    expect(await store.readPayloadFrame(ref)).toEqual({ hello: "world", n: 42 });
  });

  test("several frames in one file are each readable", async () => {
    // Frames append, so a file holding more than one must keep every offset
    // resolvable — the line length is what makes that work without a header.
    const first = await store.writePayloadFrame({ i: 1 }, new Date(Date.now() + 60_000));
    const second = await store.writePayloadFrame({ i: 2 }, new Date(Date.now() + 60_000));
    expect(second.file).toBe(first.file);
    expect(second.offset).toBeGreaterThan(first.offset);
    expect(await store.readPayloadFrame(first)).toEqual({ i: 1 });
    expect(await store.readPayloadFrame(second)).toEqual({ i: 2 });
  });
});



/**
 * Async compression + single-copy frames.
 *
 * Compression moved off the event loop to one worker per process (max 2 jobs
 * in flight) with a sync fallback when the worker is unavailable, and the
 * frame is assembled exactly once (the prebuilt parts go straight to the
 * compressor). These tests pin the observable contract: many concurrent
 * writes all round-trip, the frame bytes on disk are unchanged in shape, and
 * the reference fields describe the bytes actually stored.
 */
describe("async compression and frame assembly", () => {
  test("many concurrent writes all round-trip through the worker", async () => {
    const refs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.writePayloadFrame({ index: i, pad: "z".repeat(64 * 1024) }, new Date(Date.now() + 60_000)),
      ),
    );
    expect(refs).toHaveLength(12);
    for (const [i, ref] of refs.entries()) {
      const payload = await store.readPayloadFrame(ref);
      expect(payload).toEqual({ index: i, pad: "z".repeat(64 * 1024) });
    }
  });

  test("the reference describes the exact stored line bytes", async () => {
    const ref = await store.writePayloadFrame({ a: 1 }, new Date(Date.now() + 60_000));
    const raw = await readFile(join(DIR, ref.file));
    const line = raw.subarray(ref.offset, ref.offset + ref.length);
    // The line is the newline-terminated base64 of gzip: printable and
    // newline-terminated, and its length matches the reference exactly.
    expect(line[line.length - 1]).toBe(0x0a);
    expect(/^[\x20-\x7e\n]+$/.test(line.toString("utf8"))).toBe(true);
  });

  test("prebuilt-part frames keep every body under its own key", async () => {
    const ref = await store.writePayloadFrame(
      { opaque: "not used when prebuilt is provided" },
      new Date(Date.now() + 60_000),
      {
        requestId: "req-1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        signals: { toolCalls: 1, images: 0, attachments: 2 },
        bodies: [
          JSON.stringify({ request: true }),
          JSON.stringify({ providerRequest: true }),
          JSON.stringify({ providerResponse: true }),
          JSON.stringify({ clientResponse: true }),
          "null",
        ],
      },
    );
    const payload = (await store.readPayloadFrame(ref)) as Record<string, unknown>;
    expect(payload["request_body"]).toEqual({ request: true });
    expect(payload["provider_request_body"]).toEqual({ providerRequest: true });
    expect(payload["provider_response_body"]).toEqual({ providerResponse: true });
    expect(payload["client_response_body"]).toEqual({ clientResponse: true });
    expect(payload["response_body"]).toBeNull();
    expect(payload["signals"]).toEqual({ toolCalls: 1, images: 0, attachments: 2 });
  });
});
