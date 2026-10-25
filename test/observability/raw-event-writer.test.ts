import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
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

function openWritable(path: string) {
  return open(path, "r+").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return open(path, "w+");
  });
}

test("partial writes complete the batch and close the descriptor once", async () => {
  await inSandbox(async (directory) => {
    const chunks: Buffer[] = [];
    let closes = 0;
    let size = 0;
    const writer = new RawTelemetryEventWriter(directory, {
      open: async () => ({
        stat: async () => ({ size }),
        write: async (buffer) => {
          const chunk = Buffer.from(buffer.subarray(0, Math.min(3, buffer.byteLength)));
          chunks.push(chunk);
          return { bytesWritten: chunk.byteLength };
        },
        truncate: async (nextSize) => { size = nextSize; },
        close: async () => { closes += 1; },
      }),
    });
    await writer.append([{ sequence: 1 }, { sequence: 2 }]);
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"sequence":1}\n{"sequence":2}\n');
    expect(closes).toBe(1);
  });
});

test("concurrent writers share one ordered queue and close every descriptor", async () => {
  await inSandbox(async (directory) => {
    let active = 0;
    let maximumActive = 0;
    let closes = 0;
    const gate = Promise.withResolvers<void>();
    const options: RawEventWriterOptions = {
      mkdir: async () => undefined,
      open: async (path) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const handle = await openWritable(path);
        return {
          stat: () => handle.stat(),
          write: async (buffer, options) => {
            await gate.promise;
            return handle.write(buffer, options);
          },
          truncate: (size) => handle.truncate(size),
          close: async () => {
            active -= 1;
            closes += 1;
            await handle.close();
          },
        };
      },
    };
    const first = new RawTelemetryEventWriter(directory, options);
    const second = new RawTelemetryEventWriter(directory, options);
    const appends: Promise<void>[] = [];
    for (let sequence = 0; sequence < 40; sequence += 1) {
      appends.push((sequence % 2 === 0 ? first : second).append([{ sequence }]));
    }
    gate.resolve();
    await Promise.all(appends);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(closes).toBe(40);
    const file = join(directory, `${new Date().toISOString().slice(0, 13).replaceAll(":", "-")}.jsonl`);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const sequences = lines.map((line): number => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || !("sequence" in parsed) || typeof parsed.sequence !== "number") {
        throw new Error("raw writer emitted an invalid sequence row");
      }
      return parsed.sequence;
    });
    expect(sequences).toEqual(Array.from({ length: 40 }, (_, sequence) => sequence));
  });
});

test("a failed write closes its descriptor and does not poison the next append", async () => {
  await inSandbox(async (directory) => {
    let opens = 0;
    let closes = 0;
    const writer = new RawTelemetryEventWriter(directory, {
      open: async () => {
        opens += 1;
        let size = 0;
        return {
          stat: async () => ({ size }),
          write: async () => {
            if (opens === 1) throw new Error("simulated disk failure");
            return { bytesWritten: 1 };
          },
          truncate: async (nextSize) => { size = nextSize; },
          close: async () => { closes += 1; },
        };
      },
    });
    await expect(writer.append([{ failed: true }])).rejects.toThrow("simulated disk failure");
    await expect(writer.append([{ recovered: true }])).resolves.toBeUndefined();
    expect(opens).toBe(2);
    expect(closes).toBe(2);
  });
});

test("a close failure rejects but the next append can still proceed", async () => {
  await inSandbox(async (directory) => {
    let closes = 0;
    const writer = new RawTelemetryEventWriter(directory, {
      open: async () => ({
        stat: async () => ({ size: 0 }),
        write: async (buffer) => ({ bytesWritten: buffer.byteLength }),
        truncate: async () => undefined,
        close: async () => {
          closes += 1;
          if (closes === 1) throw new Error("simulated close failure");
        },
      }),
    });
    await expect(writer.append([{ first: true }])).rejects.toThrow("simulated close failure");
    await expect(writer.append([{ second: true }])).resolves.toBeUndefined();
    expect(closes).toBe(2);
  });
});

test("a zero-progress write fails and closes instead of spinning forever", async () => {
  await inSandbox(async (directory) => {
    let closes = 0;
    const writer = new RawTelemetryEventWriter(directory, {
      open: async () => ({
        stat: async () => ({ size: 0 }),
        write: async () => ({ bytesWritten: 0 }),
        truncate: async () => undefined,
        close: async () => { closes += 1; },
      }),
    });
    await expect(writer.append([{ event: true }])).rejects.toThrow("no forward progress");
    expect(closes).toBe(1);
  });
});

test("a partial append is truncated before a retry can concatenate onto it", async () => {
  await inSandbox(async (directory) => {
    let fail = true;
    const now = () => new Date("2026-10-25T04:00:00.000Z");
    const writer = new RawTelemetryEventWriter(directory, {
      now,
      open: async (path) => {
        const handle = await open(path, "w+");
        return {
          stat: () => handle.stat(),
          truncate: (size) => handle.truncate(size),
          write: async (buffer) => {
            const result = await handle.write(fail ? buffer.subarray(0, 5) : buffer);
            if (fail) {
              fail = false;
              throw new Error("partial disk failure");
            }
            return result;
          },
          close: () => handle.close(),
        };
      },
    });
    await expect(writer.append([{ event: true }])).rejects.toThrow("partial disk failure");
    await writer.append([{ event: true }]);
    expect(await readFile(join(directory, "2026-10-25T04.jsonl"), "utf8")).toBe('{"event":true}\n');
  });
});

test("an append queued over the hour boundary keeps its original bucket", async () => {
  await inSandbox(async (directory) => {
    const times = [
      new Date("2026-10-25T04:59:59.999Z"),
      new Date("2026-10-25T05:00:00.000Z"),
    ];
    const gate = Promise.withResolvers<void>();
    const paths: string[] = [];
    const writer = new RawTelemetryEventWriter(directory, {
      now: () => times.shift() ?? new Date("2026-10-25T05:00:00.000Z"),
      open: async (path) => {
        paths.push(path);
        return {
          stat: async () => ({ size: 0 }),
          write: async (buffer) => {
            await gate.promise;
            return { bytesWritten: buffer.byteLength };
          },
          truncate: async () => undefined,
          close: async () => undefined,
        };
      },
    });
    const appends = [writer.append([{ first: true }]), writer.append([{ second: true }])];
    gate.resolve();
    await Promise.all(appends);
    expect(paths.map((path) => path.slice(-19))).toEqual([
      "2026-10-25T04.jsonl",
      "2026-10-25T05.jsonl",
    ]);
  });
});

test("idle waits for an active append before retention removes its file", async () => {
  await inSandbox(async (directory) => {
    const gate = Promise.withResolvers<void>();
    let closed = false;
    const writer = new RawTelemetryEventWriter(directory, {
      now: () => new Date("2026-10-25T04:00:00.000Z"),
      open: async (path) => {
        const handle = await open(path, "w+");
        return {
          stat: () => handle.stat(),
          write: async (buffer) => {
            await gate.promise;
            return handle.write(buffer);
          },
          truncate: (size) => handle.truncate(size),
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    });
    const appending = writer.append([{ event: true }]);
    let idle = false;
    const waiting = writer.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.resolve();
    await appending;
    await waiting;
    expect(closed).toBe(true);
    await unlink(join(directory, "2026-10-25T04.jsonl"));
    await expect(readFile(join(directory, "2026-10-25T04.jsonl"), "utf8")).rejects.toThrow();
  });
});
