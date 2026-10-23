import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTelemetryPayloadMode } from "../../src/console/settings/store";
import {
  buildPayloadRecord,
  MAX_PAYLOAD_RETENTION_MS,
  payloadRetentionMs,
  payloadPruneBound,
  resolveRetention,
  retentionMsFor,
  type PayloadCaptureInput,
} from "../../src/observability/payload-capture";
import { readPayloadFrame, writePayloadFrame } from "../../src/observability/payload-store";

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
    expect(truncated.request_body).toEqual({
      _truncated: true,
      _original_bytes: 0,
      _hint: expect.stringContaining("Capture depth"),
    });
    expect(truncated.response_body).toEqual(truncated.request_body);
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
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
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
    // bound would be deleted while its row still addresses it.
    expect(retentionMsFor(60 * 24 * 60)).toBe(MAX_PAYLOAD_RETENTION_MS);
    expect(retentionMsFor(null)).toBe(payloadRetentionMs());
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
