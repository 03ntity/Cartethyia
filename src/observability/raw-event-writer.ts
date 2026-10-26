import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hourStamp } from "../shared/time";

interface AppendHandle {
  appendFile?(buffer: Buffer): Promise<void>;
  write(buffer: Buffer): Promise<{ readonly bytesWritten: number }>;
  close(): Promise<void>;
}

export interface RawEventWriterOptions {
  readonly open?: (path: string) => Promise<AppendHandle>;
  readonly mkdir?: (directory: string) => Promise<void>;
  /** Test seam: the file's event-time stamp source (default `Date`). */
  readonly now?: () => Date;
  /** Test seam: fixed writer identity (default: one random UUID per instance). */
  readonly writerId?: string;
}

/**
 * Serializes raw event appends without keeping an idle descriptor open.
 *
 * There is one short-lived handle per queued batch. Every handle is closed on
 * success and failure, and a failed append does not poison the following one.
 * This serializes callers inside one process; cross-process safety comes from
 * the FILENAME, not a lock: each writer instance owns a distinct file
 * (`<hourStamp>-<writerUUID>.jsonl`), so two processes can never target the
 * same file and their appends cannot interleave destructively.
 *
 * The file is chosen by the EVENT's stamped time, not the dequeue time: a
 * batch flushed after an hour boundary still belongs to the hour its events
 * happened in, so retention's hour-granular rule never deletes a file whose
 * events belong to the current window.
 */
export class RawTelemetryEventWriter {
  private readonly state: { tail: Promise<void> };
  private readonly openFile: (path: string) => Promise<AppendHandle>;
  private readonly makeDirectory: (directory: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly writerId: string;

  constructor(directory: string, options: RawEventWriterOptions = {}) {
    this.directory = directory;
    this.state = sharedState(directory);
    this.openFile = options.open ?? (async (path) => {
      // 'a' positions every write at end-of-file: no stat, no positioned
      // write, no truncate-rollback. Two writers on one file would still
      // interleave at line granularity (append is atomic per call for
      // line-sized buffers), but the writer-UUID filename makes that
      // impossible; 'a' is the belt to that suspenders.
      return (await open(path, "a")) as unknown as AppendHandle;
    });
    this.makeDirectory = options.mkdir ?? (async (path) => {
      await mkdir(path, { recursive: true });
    });
    this.now = options.now ?? (() => new Date());
    this.writerId = options.writerId ?? randomUUID();
  }

  /** Queues an already-bounded batch; the telemetry buffer owns drop policy. */
  append(rows: readonly object[]): Promise<void> {
    // Serialize before queueing so a backlog does not retain row graphs and no
    // JSON encoding work happens while a descriptor is open.
    const body = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const hour = hourStamp(this.now());
    const file = `${hour}-${this.writerId}.jsonl`;
    const write = this.state.tail.then(() => this.write(file, body));
    this.state.tail = write.catch(() => undefined);
    return write;
  }

  /** Waits for writes queued before this call; used before retention cleanup. */
  async idle(): Promise<void> {
    await this.state.tail;
  }

  private async write(file: string, body: Buffer): Promise<void> {
    await this.makeDirectory(this.directory);
    const handle = await this.openFile(join(this.directory, file));
    try {
      // Append-only: a failed write leaves whatever prefix landed, and the
      // reader already tolerates a torn tail (a partial final line without a
      // newline is skipped). No truncate-rollback: truncating under
      // `reusePort` multi-process was the corruption risk this rewrite
      // removes — one process's rollback could cut another process's
      // already-committed lines on a shared file. Private files make that
      // impossible, and refusing to truncate keeps it impossible even if the
      // filename rule is ever relaxed.
      if (typeof handle.appendFile === "function") {
        await handle.appendFile(body);
        return;
      }
      let offset = 0;
      while (offset < body.byteLength) {
        const { bytesWritten } = await handle.write(body.subarray(offset));
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
          throw new Error("telemetry event writer made no forward progress");
        }
        offset += bytesWritten;
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
