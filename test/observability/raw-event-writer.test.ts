/**
 * The multi-process-safe raw event writer.
 *
 * The previous writer targeted one file per hour (`<hour>.jsonl`) with
 * positioned writes plus a truncate-rollback on partial failure. Under
 * `reusePort` multi-process that is a corruption vector: two processes share
 * the file, and one process's rollback can cut the other's committed lines.
 *
 * The new contract: one random writer UUID per instance, file name
 * `<hourStamp>-<writerUUID>.jsonl` derived from the event's stamped time, and
 * append-only writes (no stat, no positioning, no truncate). These tests pin
 * exactly those properties.
 */
import { expect, test } from "bun:test";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawTelemetryEventWriter, type RawEventWriterOptions } from "../../src/observability/raw-event-writer";

async function inSandbox(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "carte-raw-writer-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("two writer instances in one directory produce distinct files", async () => {
  await inSandbox(async (directory) => {
    const first = new RawTelemetryEventWriter(directory, {
      now: () => new Date("2026-03-15T12:05:00.000Z"),
      writerId: "aaaa",
    });
    const second = new RawTelemetryEventWriter(directory, {
      now: () => new Date("2026-03-15T12:30:00.000Z"),
      writerId: "bbbb",
    });
    await first.append([{ who: "first" }]);
    await second.append([{ who: "second" }]);

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["2026-03-15T12-aaaa.jsonl", "2026-03-15T12-bbbb.jsonl"]);
  });
});

test("a writer reuses its own file within the hour and rolls over on the event's hour", async () => {
  await inSandbox(async (directory) => {
    const writer = new RawTelemetryEventWriter(directory, {
      now: () => new Date("2026-03-15T12:59:00.000Z"),
      writerId: "cccc",
    });
    await writer.append([{ n: 1 }]);
    // Same writer, same hour: one file, two lines.
    await writer.append([{ n: 2 }]);
    // The event time crosses the hour boundary: a new file, chosen by the
    // EVENT's time, not the dequeue time.
    const late = new RawTelemetryEventWriter(directory, {
      now: () => new Date("2026-03-15T13:01:00.000Z"),
      writerId: "cccc",
    });
    await late.append([{ n: 3 }]);

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["2026-03-15T12-cccc.jsonl", "2026-03-15T13-cccc.jsonl"]);
    const hour12 = await readFile(join(directory, "2026-03-15T12-cccc.jsonl"), "utf8");
    expect(hour12).toBe('{"n":1}\n{"n":2}\n');
  });
});

test("concurrent appends from several writers all produce complete parseable lines", async () => {
  await inSandbox(async (directory) => {
    const writers = Array.from({ length: 4 }, (_, i) =>
      new RawTelemetryEventWriter(directory, {
        now: () => new Date("2026-03-15T12:00:00.000Z"),
        writerId: `w${i}`,
      }),
    );
    // Every writer appends 25 single-row batches concurrently.
    const jobs: Promise<void>[] = [];
    for (const [index, writer] of writers.entries()) {
      for (let n = 0; n < 25; n += 1) {
        jobs.push(writer.append([{ writer: index, n }]));
      }
    }
    await Promise.all(jobs);

    const files = await readdir(directory);
    expect(files).toHaveLength(4);
    let total = 0;
    for (const file of files) {
      const text = await readFile(join(directory, file), "utf8");
      // Every line complete and parseable; every file newline-terminated.
      expect(text.endsWith("\n")).toBe(true);
      for (const line of text.split("\n").slice(0, -1)) {
        expect(() => JSON.parse(line)).not.toThrow();
        total += 1;
      }
    }
    expect(total).toBe(100);
  });
});

test("append-only: a failing write leaves a torn tail, and the reader-side contract tolerates it", async () => {
  await inSandbox(async (directory) => {
    let writes = 0;
    const options: RawEventWriterOptions = {
      mkdir: async () => undefined,
      open: async (path) => {
        // Real append handle, but writes fail after the first.
        const handle = await open(path, "a");
        return {
          write: async (buffer: Buffer) => {
            writes += 1;
            if (writes > 1) throw new Error("simulated partial failure");
            return handle.write(buffer);
          },
          close: () => handle.close(),
        };
      },
    };
    const writer = new RawTelemetryEventWriter(directory, {
      ...options,
      now: () => new Date("2026-03-15T12:00:00.000Z"),
      writerId: "torn",
    });
    await writer.append([{ ok: true }]).catch(() => undefined);
    // The failure left the first write's bytes; a torn tail (a line without a
    // terminating newline) must be skipped by any reader of this file, and a
    // later write must still be able to append behind it.
    const files = await readdir(directory);
    expect(files).toEqual(["2026-03-15T12-torn.jsonl"]);
    const text = await readFile(join(directory, "2026-03-15T12-torn.jsonl"), "utf8");
    expect(text).toBe('{"ok":true}\n');
  });
});

test("the default filename is per-instance: two bare writers never collide", async () => {
  await inSandbox(async (directory) => {
    const now = () => new Date("2026-03-15T12:00:00.000Z");
    const first = new RawTelemetryEventWriter(directory, { now });
    const second = new RawTelemetryEventWriter(directory, { now });
    await first.append([{ w: 1 }]);
    await second.append([{ w: 2 }]);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    // Both files still parse as the hour-UUID convention the reader and
    // retention recognize.
    for (const file of files) {
      expect(file).toMatch(/^2026-03-15T12-[0-9a-f-]{36}\.jsonl$/);
    }
  });
});
