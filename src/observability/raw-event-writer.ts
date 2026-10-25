import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

interface AppendHandle {
  stat(): Promise<{ readonly size: number }>;
  write(buffer: Buffer, options?: { readonly position: number }): Promise<{ readonly bytesWritten: number }>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface RawEventWriterOptions {
  readonly open?: (path: string) => Promise<AppendHandle>;
  readonly mkdir?: (directory: string) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * Serializes raw event appends without keeping an idle descriptor open.
 *
 * There is one short-lived handle per queued batch. Every handle is closed on
 * success and failure, and a failed append does not poison the following one.
 * This serializes callers inside one process; it is not a cross-process lock.
 */
export class RawTelemetryEventWriter {
  private readonly state: { tail: Promise<void> };
  private readonly openFile: (path: string) => Promise<AppendHandle>;
  private readonly makeDirectory: (directory: string) => Promise<void>;
  private readonly now: () => Date;

  constructor(directory: string, options: RawEventWriterOptions = {}) {
    this.directory = directory;
    this.state = sharedState(directory);
    this.openFile = options.open ?? (async (path) => {
      try {
        return await open(path, "r+");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return open(path, "w+");
      }
    });
    this.makeDirectory = options.mkdir ?? (async (path) => {
      await mkdir(path, { recursive: true });
    });
    this.now = options.now ?? (() => new Date());
  }

  /** Queues an already-bounded batch; the telemetry buffer owns drop policy. */
  append(rows: readonly object[]): Promise<void> {
    // Serialize before queueing so a backlog does not retain row graphs and no
    // JSON encoding work happens while a descriptor is open.
    const body = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const hour = this.now().toISOString().slice(0, 13).replaceAll(":", "-");
    const write = this.state.tail.then(() => this.write(hour, body));
    this.state.tail = write.catch(() => undefined);
    return write;
  }

  /** Waits for writes queued before this call; used before retention cleanup. */
  async idle(): Promise<void> {
    await this.state.tail;
  }

  private async write(hour: string, body: Buffer): Promise<void> {
    await this.makeDirectory(this.directory);
    const handle = await this.openFile(join(this.directory, `${hour}.jsonl`));
    try {
      const initialSize = (await handle.stat()).size;
      let offset = 0;
      try {
        while (offset < body.byteLength) {
          const { bytesWritten } = await handle.write(body.subarray(offset), { position: initialSize + offset });
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > body.byteLength - offset) {
            throw new Error("telemetry event writer made no forward progress");
          }
          offset += bytesWritten;
        }
      } catch (error) {
        // Never leave a JSON fragment for a retry to concatenate onto. If the
        // rollback itself fails, keep both failures visible to the caller.
        await handle.truncate(initialSize).catch((truncateError: unknown) => {
          throw new AggregateError([error, truncateError], "telemetry append and partial-write rollback failed");
        });
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  private readonly directory: string;
}

const states = new Map<string, { tail: Promise<void> }>();

function sharedState(directory: string): { tail: Promise<void> } {
  const existing = states.get(directory);
  if (existing) return existing;
  const created = { tail: Promise.resolve() };
  states.set(directory, created);
  return created;
}
