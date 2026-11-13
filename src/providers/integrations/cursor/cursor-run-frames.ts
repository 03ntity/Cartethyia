// One Run's shared frame queue plus the per-Run stream bookkeeping types.
// A single read loop decodes `AgentServerMessage` frames for the Run's whole
// lifetime; every request that serves the Run subscribes to the same queue, so
// a request that ends between a tool call and its answer cannot cancel the
// reading of the next one's turn.
import { GatewayError } from "../../../protocol/gateway-error";
import type { Http2BidiEndReason } from "../../../network/bidi";
import { CURSOR_PROVIDER_ID } from "./cursor-shared";
import { createRunCompletion, type CursorCheckpointState } from "./cursor-hardening";

/** The donor's per-Run stream state, kept across a Run's request legs. */
export interface CursorRunFrameState {
  readonly completion: ReturnType<typeof createRunCompletion>;
  readonly checkpoint: CursorCheckpointState;
  /** Frame kinds since the last checkpoint, for the "went quiet" error. */
  kindsSinceCheckpoint: string[];
  /** Heartbeats since the last semantic frame; a quiet Run must not hang. */
  quietBeats: number;
  /** `tool_call_completed` frames the edge reported for this step. */
  serverToolCount: number;
  /** The transport this Run was opened on. */
  transport: "http2" | "http1";
  /** Attempt number, for the structured terminal error. */
  attempt: number;
}

/** One decoded server frame, ready for pump consumption. */
export type RunFrame = Record<string, unknown>;

/**
 * The reader's end-of-stream marker: every enumeration over the frame queue
 * resolves `done` here, so a pump nested across requests finalizes on the
 * same signal the raw reader produced.
 */
export interface RunStreamEnd {
  readonly __streamEnd: Http2BidiEndReason;
  readonly failure: GatewayError | undefined;
}

export function isRunStreamEnd(item: unknown): item is RunStreamEnd {
  return typeof item === "object" && item !== null && "__streamEnd" in item;
}

export type RunFrameItem = RunFrame | RunStreamEnd;

export function isHeartbeatFrame(item: unknown): boolean {
  if (item === null || typeof item !== "object" || isRunStreamEnd(item)) return false;
  const update = (item as RunFrame)["interaction_update"];
  if (update === null || typeof update !== "object") return false;
  return "heartbeat" in (update as Record<string, unknown>);
}

/**
 * One Run's shared frame queue.
 *
 * A single read loop decodes `AgentServerMessage` frames for the Run's whole
 * lifetime, independent of any single request. A pump subscribes for the leg
 * it serves; when that request ends, frames keep queueing (the reader and the
 * client-heartbeat cadence both stay alive), and the Run's next leg drains
 * them. Without this, a request that ends between the tool call and its
 * answer disposed the body reader and the heartbeat timer, leaving the Cursor
 * edge fed by nothing and the turn waiting on a result nobody could deliver.
 *
 * Exported for unit tests of the queue bound; production code reaches it only
 * through `#startReader`.
 */
export class RunFrameStream {
  private items: RunFrameItem[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<RunFrameItem>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private subscribers = 0;

  /** Bounds the gap between legs: heartbeats are droppable, semantics are not. */
  private static readonly MAX_IDLE_ITEMS = 2_048;

  push(message: RunFrame): void {
    if (this.closed) return;
    if (this.subscribers === 0 && this.items.length >= RunFrameStream.MAX_IDLE_ITEMS) {
      // An idle Run only accumulates keepalives; drop them first so a bounded
      // queue survives a long tool-result gap without losing real frames.
      while (this.items.length >= RunFrameStream.MAX_IDLE_ITEMS && isHeartbeatFrame(this.items[0])) {
        this.items.shift();
      }
      if (this.items.length >= RunFrameStream.MAX_IDLE_ITEMS) {
        // The gap carried more semantic frames than the queue can hold.
        // Dropping real frames silently would corrupt the turn, so the stream
        // ends in an error instead and the pump surfaces it: the bound above
        // is real in both directions.
        this.end(
          { kind: "remote-error", error: new Error("Cursor Run frame queue overflowed") },
          new GatewayError(
            "platform_unavailable",
            502,
            "Cursor Run produced more frames than the gateway can buffer between tool legs (request {requestId}). The upstream came back empty-handed — retry 🌙",
            { providerId: CURSOR_PROVIDER_ID },
            "upstream",
          ),
        );
        return;
      }
    }
    this.items.push(message);
    this.#drain();
  }

  end(reason: Http2BidiEndReason, failure: GatewayError | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.items.push({ __streamEnd: reason, failure });
    this.#drain();
  }

  subscribe(): AsyncIterableIterator<RunFrameItem> {
    this.subscribers += 1;
    const self = this;
    const next = async (): Promise<IteratorResult<RunFrameItem>> => {
      const front = self.items.shift();
      if (front !== undefined) return { done: false, value: front };
      if (self.closed) {
        self.#release();
        return { done: true, value: undefined };
      }
      return await new Promise<IteratorResult<RunFrameItem>>((resolve, reject) => {
        self.waiters.push({ resolve, reject });
      });
    };
    const releaseOnReturn = (): Promise<IteratorResult<RunFrameItem>> => {
      self.#release();
      self.#flushWaiters({ done: true, value: undefined });
      return Promise.resolve({ done: true, value: undefined });
    };
    const iterator: AsyncIterableIterator<RunFrameItem> = {
      next,
      return: releaseOnReturn,
      [Symbol.asyncIterator](): AsyncIterableIterator<RunFrameItem> {
        return iterator;
      },
    };
    return iterator;
  }

  #release(): void {
    this.subscribers = Math.max(0, this.subscribers - 1);
  }

  /** Resolves parked consumers with queued items, in order. */
  #drain(): void {
    while (this.waiters.length > 0 && this.items.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ done: false, value: this.items.shift() as RunFrameItem });
    }
    if (this.closed && this.items.length === 0) {
      this.#flushWaiters({ done: true, value: undefined });
    }
  }

  #flushWaiters(result: IteratorResult<RunFrameItem>): void {
    for (const waiter of this.waiters) waiter.resolve(result);
    this.waiters = [];
  }
}

