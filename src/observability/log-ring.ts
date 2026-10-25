/**
 * Console log ring buffer + pub/sub: a bounded in-memory tail of structured
 * server log lines for the live Console Log page. The dashboard reads a
 * snapshot and then subscribes over SSE (`console/observability/logs.ts`); nothing
 * here touches the database — restarts clear the tail by design.
 */
import { sanitizeLogValue } from './log-sanitize';

export const CONSOLE_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** One console log level; derived from `CONSOLE_LOG_LEVELS`. */
export type ConsoleLogLevel = (typeof CONSOLE_LOG_LEVELS)[number];

export interface ConsoleLogLine {
  readonly ts: string;
  readonly level: ConsoleLogLevel;
  readonly msg: string;
  readonly event?: "request_start" | "request_complete" | "request_error" | "token_refresh";
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly method?: string;
  /** The model name sent by the client. */
  readonly model?: string;
  /** The model selected after CLI/tenant alias routing. */
  readonly routedModel?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}

export interface ConsoleLogMetadata {
  readonly event: NonNullable<ConsoleLogLine["event"]>;
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly method?: string;
  readonly model?: string;
  readonly routedModel?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Bounds one structured `details` object.
 *
 * Returns a fresh record rather than mutating, so a caller that keeps its own
 * reference to the object it passed does not find it rewritten.
 */
function sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeLogValue(details);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

export function pushStructuredConsoleLog(
  level: ConsoleLogLevel,
  msg: string,
  metadata: ConsoleLogMetadata,
): void {
  const { event, ...lineMetadata } = metadata;
  appendLine({ level, msg, event, ...lineMetadata });
}

export type ConsoleLogEvent =
  | { readonly type: "init"; readonly lines: readonly ConsoleLogLine[] }
  | { readonly type: "line"; readonly line: ConsoleLogLine }
  | { readonly type: "clear" };

/** Lines retained. Exported so the console can state the tail's depth. */
export const CONSOLE_LOG_CAPACITY = 500;
/** Code units kept per rendered message. Exported for the same reason. */
export const CONSOLE_LOG_MAX_MESSAGE_CODE_UNITS = 2_000;
const CAPACITY = CONSOLE_LOG_CAPACITY;
const MAX_MSG = CONSOLE_LOG_MAX_MESSAGE_CODE_UNITS;

const lines: ConsoleLogLine[] = [];
// Start index of the live window: eviction advances the pointer instead of
// splice() memmove on every overflow.
let ringStart = 0;
const listeners = new Set<(event: ConsoleLogEvent) => void>();

/** Single append path: truncate, bound the ring, then fan out to subscribers. */
function appendLine(line: Omit<ConsoleLogLine, "ts" | "msg"> & { readonly msg: string }): void {
  const stored: ConsoleLogLine = {
    ts: new Date().toISOString(),
    ...line,
    msg: line.msg.length > MAX_MSG ? `${line.msg.slice(0, MAX_MSG)}…` : line.msg,
    // `details` is caller-supplied and never routed through the logger, so it
    // is the one field that could arrive unbounded: a structured line carrying
    // a whole response body would make this 500-line ring hold a fraction of
    // one event. Bounded by the same sanitizer the logger uses, so the two
    // paths cannot disagree about what "bounded" means.
    ...(line.details === undefined ? {} : { details: sanitizeLogDetails(line.details) }),
  };
  lines.push(stored);
  if (lines.length - ringStart > CAPACITY) ringStart += 1;
  if (ringStart > 256 && ringStart > lines.length / 2) {
    lines.splice(0, ringStart);
    ringStart = 0;
  }
  for (const listener of listeners) {
    try {
      listener({ type: "line", line: stored });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

export function pushConsoleLog(level: ConsoleLogLevel, msg: string): void {
  appendLine({ level, msg });
}

export function getConsoleLogSnapshot(): ConsoleLogLine[] {
  return [...lines.slice(ringStart)];
}

export function clearConsoleLogs(): void {
  lines.length = 0;
  ringStart = 0;
  for (const listener of listeners) {
    try {
      listener({ type: "clear" });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

export function subscribeConsoleLogs(
  listener: (event: ConsoleLogEvent) => void,
): () => void {
  listeners.add(listener);
  listener({ type: "init", lines: getConsoleLogSnapshot() });
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the shared ring and drop all subscribers between tests. */
export function resetConsoleLogsForTests(): void {
  lines.length = 0;
  ringStart = 0;
  listeners.clear();
}
