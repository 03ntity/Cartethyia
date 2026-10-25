import pino from 'pino';
import { pushConsoleLog, type ConsoleLogLevel } from './log-ring';
import { LOG_RING_MAX_CODE_UNITS, sanitizeLogValue, truncateLogString } from './log-sanitize';

/**
 * Structured logger using Pino for production-ready logging.
 * Replaces console.log/warn/error with structured, level-based logging.
 */

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Pretty-printing runs the `pino-pretty` transport in a **worker thread**, and
 * that thread outlives the log call: it is torn down when the process exits,
 * which in a test worker means it can exit mid-run and take the worker with it
 * (`error: the worker thread exited`, surfacing as unrelated failures across
 * whatever file the worker was running). It is also pure presentation - a
 * human reading a terminal - so it is enabled only for an interactive TTY.
 * Piped output, CI, and tests get the plain JSON transport, which writes on
 * the calling thread and has nothing to tear down.
 */
const wantsPrettyTransport = isDevelopment && process.stdout.isTTY === true;

const baseOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Pretty print for an interactive terminal, JSON everywhere else.
const developmentOptions = wantsPrettyTransport
  ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    }
  : {};

const logger = pino({
  ...baseOptions,
  ...developmentOptions,
});

/**
 * Circular-safe, depth-capped structural copy for the ring pre-pass.
 * `redactTelemetryValue` (the canonical redactor, applied next) recurses
 * without a cycle guard, so a circular log arg would overflow the stack
 * before redaction even runs. Errors collapse to name+message - stacks are
 * too long for a tail line and the message already carries the cause.
 *
 * Bounded in every dimension, not just depth: see the constants above. The
 * node budget is carried by a mutable counter object rather than a return
 * value, because a recursive walk that returned remaining budget would have to
 * thread it through every branch and a missed one would silently unbound a
 * subtree.
 */
/**
 * Flatten a log call into one ring line. Args keep their real values: a log
 * line whose credential was rewritten into `***REDACTED***` is
 * indistinguishable from a payload that really carried that placeholder, so
 * redacting here destroyed the evidence a failure has to be read from.
 */
function safeLogValue(value: unknown): unknown {
  try {
    return sanitizeLogValue(value);
  } catch {
    return "[unserializable args]";
  }
}

function safeLogArgs(args: readonly unknown[]): unknown[] {
  const safe = safeLogValue(args);
  return Array.isArray(safe) ? safe : [safe];
}

function formatRingMessage(msg: string, args: readonly unknown[]): string {
  if (args.length === 0) return msg;
  let rendered = "";
  try {
    rendered = JSON.stringify(args.length === 1 ? args[0] : args) ?? "";
  } catch {
    rendered = "[unserializable args]";
  }
  // Bounded on the way out too: the copy above caps each field, but a few
  // hundred capped fields still render to a line long enough that the ring —
  // a fixed 500-entry buffer — holds a meaningful fraction of one log call.
  rendered = truncateLogString(rendered, LOG_RING_MAX_CODE_UNITS);
  return rendered.length > 0 ? `${msg} ${rendered}` : msg;
}

function ring(level: ConsoleLogLevel, msg: string, safeArgs: readonly unknown[]): void {
  try {
    pushConsoleLog(level, msg.length > 0 ? formatRingMessage(msg, safeArgs) : formatRingMessage("(empty)", safeArgs));
  } catch {
    // The ring is observability-only; it must never break the log call itself.
  }
}

function logArgs(
  level: ConsoleLogLevel,
  write: (args: unknown[]) => void,
  msg: string,
  args: readonly unknown[],
): void {
  // The level is consulted first. Building the safe copy unconditionally would
  // make a `debug` call at the production `info` default still pay a
  // depth-capped deep copy plus a JSON.stringify of every argument, on every
  // request that reaches it — the surface-detection debug line fires on almost
  // every chat request. Pino's own level check happens inside `write`, which is
  // already too late to skip the work.
  if (!logger.isLevelEnabled(level)) return;
  const safeArgs = safeLogArgs(args);
  ring(level, msg, safeArgs);
  write(safeArgs);
}

function safeErrorForRing(error: Error): unknown {
  return safeLogValue(error);
}

function safeErrorForPino(error: Error): Error {
  const fields: Record<string, unknown> = {};
  try {
    Object.assign(fields, error);
  } catch {
    // Preserve the standard Error fields below if a custom enumerable getter fails.
  }
  fields.name = error.name;
  fields.message = error.message;
  if (typeof error.stack === "string") fields.stack = error.stack;
  const redacted = safeLogValue(fields);
  const safeFields =
    typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
      ? redacted as Record<string, unknown>
      : {};
  const safe = new Error(
    typeof safeFields["message"] === "string" ? safeFields["message"] : "[unserializable error]",
  );
  safe.name = typeof safeFields["name"] === "string" ? safeFields["name"] : "Error";
  if (typeof safeFields["stack"] === "string") safe.stack = safeFields["stack"];
  const extras = { ...safeFields };
  delete extras["name"];
  delete extras["message"];
  delete extras["stack"];
  Object.assign(safe, extras);
  return safe;
}

function logError(msg: string, error: Error | undefined, args: readonly unknown[]): void {
  // Same fast-path as `logArgs`, and for the same reason: `safeErrorForPino`
  // copies every own enumerable field of the error, and an error from a failed
  // upstream call carries the response body. That copy is the largest one in
  // this module and it used to run unconditionally.
  if (!logger.isLevelEnabled("error")) return;
  const safe = safeLogArgs(args);
  const ringError = error === undefined ? undefined : safeErrorForRing(error);
  const pinoError = error === undefined ? undefined : safeErrorForPino(error);
  ring("error", msg, error === undefined ? safe : [ringError, ...safe]);
  logger.error({ ...(pinoError === undefined ? {} : { error: pinoError }), args: safe }, msg);
}

export const log = {
  debug: (msg: string, ...args: unknown[]) =>
    logArgs("debug", (safe) => logger.debug({ args: safe }, msg), msg, args),
  info: (msg: string, ...args: unknown[]) =>
    logArgs("info", (safe) => logger.info({ args: safe }, msg), msg, args),
  warn: (msg: string, ...args: unknown[]) =>
    logArgs("warn", (safe) => logger.warn({ args: safe }, msg), msg, args),
  error: (msg: string, error?: Error, ...args: unknown[]) => logError(msg, error, args),
};
