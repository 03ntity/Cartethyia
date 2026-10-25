/**
 * Payload frames are gzipped on write and named `jsonl-file`.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnv } from "../helpers/sandbox";
import { gunzipSync } from "node:zlib";
import {
  applySqliteMigrations,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import {
  payloadDirectory,
  prunePayloadFrames,
  readPayloadFrame,
  writePayloadFrame,
  type PayloadFileReference,
} from "../../src/observability/payload-store";

function payloadDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
  restorePayloadDir();
  restorePayloadDir = sandboxEnv("CARTETHYIA_TELEMETRY_PAYLOAD_DIR", dir);
  payloadDirs.push(dir);
  return dir;
}

let restorePayloadDir: () => void = () => undefined;
const payloadDirs: string[] = [];
afterAll(() => {
  restorePayloadDir();
  for (const dir of payloadDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * The compressed bytes of one frame, out of its stored line.
 *
 * A line is base64 of the gzipped frame plus a newline, so the body is decoded
 * rather than sliced past a binary length header.
 */
async function storedBody(reference: PayloadFileReference): Promise<Buffer> {
  const data = await readFile(join(payloadDirectory(), reference.file));
  const line = data
    .subarray(reference.offset, reference.offset + reference.length)
    .toString("utf8")
    .trim();
  return Buffer.from(line, "base64");
}

test("a written frame is gzipped, smaller than its JSON, and reads back whole", async () => {
  payloadDir();
  const repeated = "system prompt repeated on every request. ".repeat(200);
  const payload = { request_id: "request-1", request_body: { prompt: repeated } };

  const reference = await writePayloadFrame(payload, new Date("2026-01-01T00:15:00.000Z"));

  expect(reference.storage).toBe("jsonl-file");
  const stored = await storedBody(reference);
  expect(stored.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  // The decompressed body is the frame, which wraps the payload, so this
  // bounds the frame rather than the payload alone.
  const decompressed = gunzipSync(stored);
  expect(stored.byteLength).toBeLessThan(decompressed.byteLength / 5);
  expect(await readPayloadFrame(reference)).toEqual(payload);
});

test("a file of only expired compressed frames is reclaimed", async () => {
  payloadDir();
  const reference = await writePayloadFrame(
    { request_id: "gone" },
    new Date("2026-01-01T00:15:00.000Z"),
  );
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(1);
  expect(await stat(join(payloadDirectory(), reference.file)).then(() => true).catch(() => false)).toBe(false);
});

test("a compressed frame still inside its window keeps the file", async () => {
  payloadDir();
  await writePayloadFrame({ request_id: "kept" }, new Date("2026-06-01T00:15:00.000Z"));
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(0);
});

test("the baseline accepts jsonl-file payload frame rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-migrate-"));
  const file = join(dir, "cartethyia.sqlite");
  const sqlite = createSqliteDatabase(file);
  await applySqliteMigrations(sqlite);

  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  const insert = (storage: string): void => {
    sqlite.exec(
      "INSERT INTO telemetry_payloads (id, tenant_id, captured_at, expires_at, storage, file, offset, length, checksum, version) " +
        `VALUES ('id-${storage}', 't1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', '${storage}', 'f.jsonb', 0, 4, 'abcd', 1)`,
    );
  };
  insert("jsonl-file");
  expect(() => insert("parquet")).toThrow();

  const count = sqlite.prepare("SELECT count(*) AS c FROM telemetry_payloads").get() as { c: number };
  expect(count.c).toBe(1);
  sqlite.close();
  // Bun's SQLite close can release its Windows handle just after returning.
  // The database is temporary; removal must not hide the migration assertion.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
});
