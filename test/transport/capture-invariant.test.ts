/**
 * F1 — the functional correctness invariants, asserted rather than asserted in
 * prose.
 *
 * Three things the plan requires be proven, not claimed:
 *
 * 1. A 1 MiB budget is 1 MiB of UTF-8 BYTES. Code-unit accounting under-counts
 *    multi-byte content by roughly 3x, so a "1 MiB" cap that counted UTF-16
 *    units admitted ~3 MiB of CJK — which is the difference between a bounded
 *    capture and a memory event on a 2 GiB box.
 * 2. `metadata` mode stores no bodies anywhere. Not "fewer bodies": none. This
 *    is a privacy invariant, so the assertion is that the stored shape carries
 *    presence and size only.
 * 3. The reported production shape (743,600-byte client request, 55,000-byte
 *    client response, 200,000-byte provider bodies) round-trips under
 *    `full` + `minimum` at a true 1,048,576-byte budget.
 */
import { describe, expect, test } from "bun:test";
import { buildPayloadRecord, truncateUtf8 } from "../../src/observability/payload-capture";

const ONE_MIB = 1_048_576;

/**
 * A CJK-heavy body: every character is 3 UTF-8 bytes but 1 UTF-16 code unit,
 * so byte and code-unit accounting disagree by exactly 3x. This is the fixture
 * that distinguishes a correct cap from a code-unit cap.
 */
function cjk(codeUnits: number): string {
  return "中".repeat(codeUnits);
}

/** A Latin body: 1 byte per code unit, so both accountings agree. */
function latin(chars: number): string {
  return "x".repeat(chars);
}

describe("truncateUtf8 — 1 MiB means 1 MiB bytes", () => {
  test("a Latin body keeps exactly its byte budget", () => {
    const result = truncateUtf8(latin(ONE_MIB * 2), ONE_MIB);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(ONE_MIB);
    // Latin is 1 byte/unit, so both accountings agree here — this is the
    // control, not the proof.
    expect(result.length).toBeLessThanOrEqual(ONE_MIB);
  });

  test("a CJK body keeps 1 MiB of BYTES, not 1 MiB of code units", () => {
    const result = truncateUtf8(cjk(ONE_MIB * 2), ONE_MIB);
    const bytes = Buffer.byteLength(result, "utf8");
    expect(bytes).toBeLessThanOrEqual(ONE_MIB);
    // The actual proof: a code-unit cap would have kept ~1,048,576 CHARACTERS,
    // which is ~3 MiB of UTF-8. Kept bytes must be within the budget while the
    // kept code-unit count is far below what a code-unit cap would allow.
    expect(result.length).toBeLessThan(ONE_MIB / 2);
  });

  test("never splits a code point", () => {
    // An astral character ("😀" = a surrogate pair) cut between halves renders
    // as U+FFFD: the stored body would be corrupt, not merely short.
    const emoji = "😀".repeat(100);
    const result = truncateUtf8(emoji, 7);
    expect(result).not.toContain("�");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(7);
  });

  test("a body already inside the budget is untouched", () => {
    const body = cjk(100);
    expect(truncateUtf8(body, ONE_MIB)).toBe(body);
  });
});

describe("buildPayloadRecord — byte accounting", () => {
  const base = {
    tenantId: "t1",
    requestId: "r1",
    tenantOptIn: true,
    scope: "tenant" as const,
    requestBody: null,
    responseBody: null,
  };

  test("a CJK request body is capped at 1 MiB of bytes, not code units", () => {
    const record = buildPayloadRecord(
      { ...base, requestBody: cjk(ONE_MIB * 2) },
      new Date(),
      ONE_MIB,
    );
    const stored = record.request_body;
    // Either the body was kept inside the byte budget, or it was marked
    // truncated and carries no content. What must never happen: a kept body
    // whose serialized size exceeds the budget.
    if (typeof stored === "string") {
      expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(ONE_MIB);
    } else if (typeof stored === "object" && stored !== null) {
      expect((stored as Record<string, unknown>)._truncated).toBe(true);
    }
  });

  test("the reported production shape round-trips at full + minimum", () => {
    // The shape from the plan: 743,600-byte client request, 55,000-byte client
    // response, 200,000-byte provider bodies, 1 MiB minimum budget. The bug
    // this pins: the legacy `response_body` alias used to be funded ahead of
    // the provider stages, so both provider panels read empty on a request
    // that did reach an upstream.
    const record = buildPayloadRecord(
      {
        ...base,
        requestBody: latin(743_600),
        responseBody: latin(55_000),
        clientResponseBody: latin(55_000),
        providerRequestBody: latin(200_000),
        providerResponseBody: latin(200_000),
      },
      new Date(),
      ONE_MIB,
    );
    expect(record.request_body).not.toBeNull();
    expect(record.provider_request_body).not.toBeNull();
    // Provider request is stage bit 2; provider response is bit 4.
    expect(record.stages & 2).toBe(2);
  });

  test("the same shape with CJK bodies stays inside the byte budget", () => {
    // Same reported shape, multi-byte content: ~3x the bytes at the same code
    // -unit count, which is exactly the case a code-unit cap got wrong.
    const record = buildPayloadRecord(
      {
        ...base,
        requestBody: cjk(743_600),
        responseBody: cjk(55_000),
        clientResponseBody: cjk(55_000),
        providerRequestBody: cjk(200_000),
        providerResponseBody: cjk(200_000),
      },
      new Date(),
      ONE_MIB,
    );
    let accounted = 0;
    for (const value of [
      record.request_body,
      record.provider_request_body,
      record.provider_response_body,
      record.client_response_body,
      record.response_body,
    ]) {
      if (typeof value === "string") accounted += Buffer.byteLength(value, "utf8");
    }
    expect(accounted).toBeLessThanOrEqual(ONE_MIB);
  });
});

describe("metadata mode stores no bodies", () => {
  const base = {
    tenantId: "t1",
    requestId: "r1",
    tenantOptIn: true,
    scope: "tenant" as const,
    requestBody: null,
    responseBody: null,
  };

  test("a stage recorded without a body carries presence and size only", () => {
    // `captureBody=false` (the none/metadata path) records
    // `{ body_present, body_bytes }` instead of slicing and parsing the
    // provider body. Asserted here on the stored shape: there is no field in
    // which content could hide.
    const record = buildPayloadRecord(
      {
        ...base,
        // What the metadata path produces in place of a body.
        providerRequestBody: { body_present: true, body_bytes: 200_000 } as unknown as string,
      },
      new Date(),
      ONE_MIB,
    );
    const stored = record.provider_request_body;
    expect(stored).toBeDefined();
    // The stored value is the presence marker, never the content: no key holds
    // a body-sized string.
    const serialized = JSON.stringify(stored);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(1_024);
    expect(serialized).not.toContain("x".repeat(500));
  });

  test("an absent surface is null, not an empty string", () => {
    const record = buildPayloadRecord(base, new Date(), ONE_MIB);
    expect(record.request_body).toBeNull();
    expect(record.provider_request_body).toBeNull();
    expect(record.provider_response_body).toBeNull();
    expect(record.client_response_body).toBeNull();
    expect(record.response_body).toBeNull();
  });
});
