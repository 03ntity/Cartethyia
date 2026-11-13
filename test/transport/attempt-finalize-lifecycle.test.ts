/**
 * Attempt-finalize lifecycle: the capture-await timer and outcome precedence.
 *
 * The capture-await race used to leave its 2 s timer running after the race
 * settled, so every attempt leaked a timer and a retained closure past the
 * response. The fake clock here instruments `setTimeout`/`clearTimeout`
 * directly so the assertion is on the cleanup itself, not on wall time.
 */
import { describe, expect, test } from "bun:test";
import {
  completeAttempt,
  resolvedProviderResponse,
  type AttemptCompletion,
} from "../../src/transport/dispatch/attempt-finalize";
import type { ProxyRequestState } from "../../src/transport/request/state";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

interface TimerRecord {
  delay: number;
  cleared: boolean;
}

/** Installs instrumented timers; returns the recorded schedule. */
function instrumentTimers(): {
  timers: Map<object, TimerRecord>;
  restore: () => void;
} {
  const timers = new Map<object, TimerRecord>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    void handler;
    const handle = {};
    timers.set(handle, { delay: delay ?? 0, cleared: false });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const record = timers.get(handle as object);
    if (record) record.cleared = true;
  }) as unknown as typeof globalThis.clearTimeout;
  return {
    timers,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

describe("resolvedProviderResponse timer lifecycle", () => {
  test("an early settle clears the capture-await timer", async () => {
    const { timers, restore } = instrumentTimers();
    try {
      const settled = await resolvedProviderResponse({
        request: null,
        response: Promise.resolve({ ok: true }),
      });
      expect(settled).toEqual({ ok: true });
    } finally {
      restore();
    }
    expect(timers.size).toBe(1);
    const [record] = [...timers.values()];
    expect(record!.delay).toBe(2000);
    // The race already settled; the timer must be gone, not merely harmless.
    expect(record!.cleared).toBe(true);
  });

  test("a provider that never answers times out as truncated", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let fire: (() => void) | undefined;
    globalThis.setTimeout = ((handler: () => void) => {
      fire = handler;
      return {} as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = (() => undefined) as unknown as typeof globalThis.clearTimeout;
    try {
      const pending = resolvedProviderResponse({
        request: null,
        response: new Promise<unknown>(() => undefined),
      });
      // The capture-await window elapses without any wall time passing.
      fire?.();
      expect(await pending).toEqual({ _truncated: true, _reason: "provider_capture_timeout" });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe("outcome reportedModel precedence", () => {
  function state(): ProxyRequestState {
    return { requestId: "req-1" } as unknown as ProxyRequestState;
  }

  function base(overrides: Partial<AttemptCompletion>): AttemptCompletion {
    return {
      status: "completed",
      terminal: true,
      tenantId: null,
      ingressBody: null,
      responseBody: null,
      db: undefined as unknown as CartethyiaDatabase,
      ...overrides,
    };
  }

  test("the completion's own attribution wins over the response-read one", async () => {
    const s = state();
    await completeAttempt(
      s,
      base({
        reportedModel: "completion-model",
        providerCapture: {
          request: null,
          response: Promise.resolve(null),
          reportedModel: Promise.resolve("capture-model"),
        },
      }),
    );
    expect(s.outcome?.reportedModel).toBe("completion-model");
  });

  test("the response-read model fills in when the completion names none", async () => {
    const s = state();
    await completeAttempt(
      s,
      base({
        providerCapture: {
          request: null,
          response: Promise.resolve(null),
          reportedModel: Promise.resolve("capture-model"),
        },
      }),
    );
    expect(s.outcome?.reportedModel).toBe("capture-model");
  });

  test("an unnamed model is never backfilled into the outcome", async () => {
    const s = state();
    await completeAttempt(s, base({}));
    expect(s.outcome?.reportedModel).toBeUndefined();
  });
});
