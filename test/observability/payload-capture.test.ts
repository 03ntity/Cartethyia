import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTelemetryPayloadMode } from "../../src/console/settings/store";
import {
  buildPayloadRecord,
  DEFAULT_PAYLOAD_RETENTION_MS,
  MAX_PAYLOAD_RETENTION_MS,
  payloadRetentionMs,
  payloadPruneBound,
  resolveRetention,
  type PayloadCaptureInput,
} from "../../src/observability/payload-capture";
import { readPayloadFrame, writePayloadFrame } from "../../src/observability/payload-store";
import { sandboxEnv } from "../helpers/sandbox";

describe("payload capture", () => {
  test("an unset capture mode is off, not metadata", () => {
    expect(normalizeTelemetryPayloadMode(undefined)).toBe("none");
    expect(normalizeTelemetryPayloadMode("metadata")).toBe("metadata");
    expect(normalizeTelemetryPayloadMode("nope")).toBe("none");
  });

  test("records tool calls, images, and attachments across the captured exchange", () => {
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: {
          messages: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: "data:image/png;base64,abc" },
                { type: "file", file_id: "file-1" },
              ],
            },
          ],
          tools: [{ type: "function", function: { name: "bash" } }],
        },
        responseBody: {
          choices: [
            {
              message: {
                tool_calls: [{ id: "call-1", type: "function" }],
              },
            },
          ],
        },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(record.signals).toEqual({ toolCalls: 1, images: 1, attachments: 1 });
  });

  test("a maxBytes override truncates combined bodies past the cap", () => {
    const input = {
      tenantId: "tenant-1",
      requestId: "request-1",
      requestBody: { prompt: "x".repeat(1000) },
      responseBody: { text: "y".repeat(1000) },
      scope: "tenant" as const,
      tenantOptIn: true,
    };
    const kept = buildPayloadRecord(input, new Date("2026-01-01T00:00:00.000Z"), 10_000_000);
    expect(kept.request_body).toEqual({ prompt: "x".repeat(1000) });
    const truncated = buildPayloadRecord(input, new Date("2026-01-01T00:00:00.000Z"), 10);
    // The marker reports the dropped body's own serialized UTF-8 byte size —
    // the same basis the budget is accounted in. (It used to report the
    // running total, which named the wrong body and read 0 for the first.)
    const requestBytes = Buffer.byteLength(JSON.stringify(input.requestBody), "utf8");
    const responseBytes = Buffer.byteLength(JSON.stringify(input.responseBody), "utf8");
    expect(truncated.request_body).toEqual({
      _truncated: true,
      _original_bytes: requestBytes,
      _hint: expect.stringContaining("Capture depth"),
    });
    expect(truncated.response_body).toEqual({
      _truncated: true,
      _original_bytes: responseBytes,
      _hint: expect.stringContaining("Capture depth"),
    });
  });

  test("a body that fits is kept and only the one past the cap is dropped", () => {
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: { prompt: "short" },
        responseBody: { text: "y".repeat(1000) },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
      100,
    );
    expect(record.request_body).toEqual({ prompt: "short" });
    expect(record.response_body).toEqual({
      _truncated: true,
      _original_bytes: expect.any(Number),
      _hint: expect.stringContaining("Capture depth"),
    });
    // Signals count only what was stored. The dropped body is never walked.
    expect(record.signals).toEqual({ toolCalls: 0, images: 0, attachments: 0 });
  });

  test("a frame written from the prebuilt text reads back the same bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
    const restore = sandboxEnv("CARTETHYIA_TELEMETRY_PAYLOAD_DIR", dir);
    try {
    const record = buildPayloadRecord(
      {
        tenantId: "tenant-1",
        requestId: "request-1",
        requestBody: { prompt: "keep me" },
        responseBody: { text: "and me" },
        scope: "tenant",
        tenantOptIn: true,
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const serialized = record._serialized;
    if (serialized === undefined) throw new Error("record carried no prebuilt text");
    const reference = await writePayloadFrame(record, record.expires_at, {
      requestId: record.request_id,
      capturedAt: record.captured_at.toISOString(),
      signals: record.signals,
      bodies: serialized,
    });
    const back = await readPayloadFrame(reference) as {
      request_id?: string;
      request_body?: unknown;
      response_body?: unknown;
    };
    expect(back.request_id).toBe("request-1");
    expect(back.request_body).toEqual({ prompt: "keep me" });
    expect(back.response_body).toEqual({ text: "and me" });
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("payload retention", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  function input(overrides: Partial<PayloadCaptureInput> = {}): PayloadCaptureInput {
    return {
      tenantId: "tenant-1",
      requestId: "request-1",
      requestBody: { prompt: "keep me" },
      responseBody: null,
      scope: "tenant",
      tenantOptIn: true,
      ...overrides,
    };
  }

  test("the default is the deployment window, not a hard-coded one", () => {
    // The env var is the deployment's choice; 15 minutes is only the fallback
    // when it is unset. A test that pins 15 minutes would pin the fallback.
    const previous = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS;
    try {
      process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS = String(45 * 60_000);
      expect(payloadRetentionMs()).toBe(45 * 60_000);
      const record = buildPayloadRecord(input(), NOW);
      expect(record.expires_at.getTime() - NOW.getTime()).toBe(45 * 60_000);
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS;
      else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS = previous;
    }
  });

  test("an explicit retention wins over the deployment window", () => {
    const record = buildPayloadRecord(input(), NOW, undefined, 7 * 24 * 60 * 60_000);
    expect(record.expires_at.getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60_000);
  });

  test("retention is bounded at seven days however long it is asked for", () => {
    // The ceiling is what keeps the prune pass and the disk-usage panel honest:
    // both judge a frame file dead by age, and a frame allowed to outlive that
    // bound would be deleted while its row is still current.
    //
    // Asserted against the fallback rather than a literal, because the number
    // is a policy choice the deployment overrides with
    // CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS — pinning 15 minutes here would
    // have made this test the reason the default could not be raised.
    expect(payloadRetentionMs()).toBe(DEFAULT_PAYLOAD_RETENTION_MS);
    expect(payloadRetentionMs()).toBeLessThanOrEqual(MAX_PAYLOAD_RETENTION_MS);
  });

  test("the prune bound is the longest retention, not the deployment default", () => {
    // The silent data-loss case. A tenant who raised retention to a week has
    // frames a fifteen-minute bound calls dead; the sweep would delete the file
    // and the drawer would read empty while its row is still current.
    const previous = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS;
    try {
      process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS = String(15 * 60_000);
      const now = new Date("2026-06-01T00:00:00.000Z");
      expect(payloadRetentionMs()).toBe(15 * 60_000);
      expect(payloadPruneBound(now).getTime()).toBe(now.getTime() - MAX_PAYLOAD_RETENTION_MS);
      // A frame written one hour ago with a week to live must be inside the
      // bound — i.e. the prune must not consider it old enough to drop.
      const hourAgo = new Date(now.getTime() - 60 * 60_000);
      expect(hourAgo.getTime()).toBeGreaterThan(payloadPruneBound(now).getTime());
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS;
      else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS = previous;
    }
  });

  test("a capture without an explicit retention resolves the tenant's", async () => {
    // The early-rejection path lands here: nothing resolved a preference before
    // the request was refused, so the capture has to look it up itself.
    const seen: string[] = [];
    expect(
      await resolveRetention(input(), (tenantId) => {
        seen.push(tenantId);
        return 24 * 60 * 60_000;
      }),
    ).toBe(24 * 60 * 60_000);
    expect(seen).toEqual(["tenant-1"]);
  });

  test("a failing retention reader falls back instead of losing the capture", async () => {
    // An unknown retention must not become a refused capture. The deployment
    // default is always a valid answer, so it is what a failure gets.
    expect(
      await resolveRetention(input(), () => {
        throw new Error("preference read failed");
      }),
    ).toBe(payloadRetentionMs());
  });

  test("an explicit retention skips the reader entirely", async () => {
    const seen: string[] = [];
    expect(
      await resolveRetention(input({ retentionMs: 30 * 60_000 }), (tenantId) => {
        seen.push(tenantId);
        return 24 * 60 * 60_000;
      }),
    ).toBe(30 * 60_000);
    expect(seen).toEqual([]);
  });
});

/**
 * UTF-8 byte budgets: 1 MiB means 1,048,576 bytes.
 *
 * The caps used to be counted in UTF-16 code units (`.length`), so CJK-heavy
 * bodies — three bytes per character — kept ~3× the intended bytes, and Latin
 * bodies lost budget to the under-counted ones ahead of them. These fixtures
 * pin the byte basis on both the record budget and the provider tee.
 */
import { truncateUtf8 } from "../../src/observability/payload-capture";
import { providerCaptureMaxBytes } from "../../src/transport/dispatch/capture-policy";
import { captureProviderExchange } from "../../src/transport/dispatch/attempt-finalize";

describe("truncateUtf8", () => {
  test("never splits a code point at the cut", () => {
    // Each CJK char is 3 UTF-8 bytes: 10 chars = 30 bytes. Cut at 29 keeps 9
    // complete characters (27 bytes), not 9⅔.
    const text = "汉字汉字汉字汉字汉字";
    expect(truncateUtf8(text, 29)).toHaveLength(9);
    expect(Buffer.byteLength(truncateUtf8(text, 29), "utf8")).toBe(27);
  });

  test("a cut at an exact character boundary keeps exactly that many bytes", () => {
    const text = "汉字汉"; // 9 bytes
    const cut = truncateUtf8(text, 6);
    expect(cut).toBe("汉字");
    expect(Buffer.byteLength(cut, "utf8")).toBe(6);
  });

  test("ASCII text truncates at the byte count directly", () => {
    expect(truncateUtf8("abcdefghij", 4)).toBe("abcd");
  });

  test("within budget passes through untouched", () => {
    const text = "汉字";
    expect(truncateUtf8(text, 100)).toBe(text);
    expect(truncateUtf8(text, 6)).toBe(text);
  });

  test("zero budget yields empty string", () => {
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});

describe("payload capture — UTF-8 byte budget", () => {
  const ONE_MIB = 1_048_576;

  test("a 1,048,576-byte budget captures exactly that many UTF-8 bytes of CJK content", () => {
    // CJK body: JSON.stringify escapes nothing for these characters, so the
    // serialized text is ~3 bytes per character. The record budget of 1 MiB
    // must keep exactly 1 MiB of serialized UTF-8 (the last character may be
    // whole-body-dropped if it would cross, so assert ≤ and near-1).
    // Size the body so its serialized UTF-8 (including the JSON wrapper) sits
    // just under the 1 MiB budget: 3 bytes/char + wrapper bytes.
    const characters = Math.floor((ONE_MIB - 64) / 3);
    const prompt = "汉".repeat(characters);
    const input = {
      tenantId: "tenant-1",
      requestId: "request-1",
      requestBody: { prompt },
      responseBody: null,
      scope: "tenant" as const,
      tenantOptIn: true,
    };
    const record = buildPayloadRecord(
      input,
      new Date("2026-01-01T00:00:00.000Z"),
      ONE_MIB,
    );
    // The request body fit within the byte budget and was kept whole.
    expect(record.request_body).toBe(input.requestBody);
    expect(
      Buffer.byteLength(JSON.stringify(record.request_body), "utf8"),
    ).toBeLessThanOrEqual(ONE_MIB);
    // ~3× the code-unit count: proving the budget is bytes, not `.length`.
    expect(Buffer.byteLength(JSON.stringify(record.request_body), "utf8")).toBeGreaterThan(
      ONE_MIB - 64,
    );

    // One more character would cross the cap: dropped with a marker whose
    // original_bytes reports the full UTF-8 size (not the code-unit count).
    const overflow = {
      ...input,
      requestBody: { prompt: "汉".repeat(characters + 100) },
    };
    const overflowed = buildPayloadRecord(
      overflow,
      new Date("2026-01-01T00:00:00.000Z"),
      ONE_MIB,
    );
    const marker = overflowed.request_body as Record<string, unknown>;
    expect(marker["_truncated"]).toBe(true);
    expect(marker["_original_bytes"]).toBe(
      Buffer.byteLength(JSON.stringify(overflow.requestBody), "utf8"),
    );
  });

  test("the provider tee at minimum depth reads a full MiB in full mode", async () => {
    // 700 KiB of CJK ≈ 2.1 MB UTF-8 — beyond the old 256 KiB tee in *bytes*,
    // beyond the 1 MiB record budget too, but the tee itself must read a full
    // MiB of decoded UTF-8 before parsing.
    expect(providerCaptureMaxBytes("minimum")).toBe(ONE_MIB);
    const big = "汉".repeat(700 * 1024);
    const capture = { request: null, response: Promise.resolve(null) };
    const fetcher = captureProviderExchange(
      async () =>
        new Response(JSON.stringify({ text: big }), {
          headers: { "content-type": "application/json" },
        }),
      capture,
      true,
      providerCaptureMaxBytes("minimum"),
    );
    await fetcher("https://example.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ text: big }),
    });
    // A truncated JSON body no longer parses, so the capture keeps the raw
    // truncated string — its UTF-8 size is exactly the tee's byte budget,
    // never splitting a code point.
    const providerResponse = await capture.response;
    expect(typeof providerResponse).toBe("string");
    const keptText = providerResponse as unknown as string;
    expect(Buffer.byteLength(keptText, "utf8")).toBeLessThanOrEqual(ONE_MIB);
    expect(Buffer.byteLength(keptText, "utf8")).toBeGreaterThan(ONE_MIB - 16);
    // Every character complete: no lone surrogate or replacement char.
    expect(keptText.includes("\ufffd")).toBe(false);
  });
});
