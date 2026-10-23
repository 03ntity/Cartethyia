/**
 * On-disk payload frame format.
 *
 * Frames are stored as newline-terminated base64 lines of gzipped JSON
 * (jsonl-file). The only valid storage type is jsonl-file; the old binary
 * header shape (jsonb-file) has been fully retired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = await mkdtemp(join(tmpdir(), "carte-payload-format-"));
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = DIR;

const store = await import("../../src/observability/payload-store");

beforeEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
});

afterEach(async () => {
  for (const name of await readdir(DIR).catch(() => [])) {
    await rm(join(DIR, name), { force: true });
  }
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


