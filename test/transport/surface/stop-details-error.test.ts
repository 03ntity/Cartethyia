/**
 * The shared failed-terminal error builder used by the chat, completion, and
 * Responses encoders. One shape (`type`/`code`/`status?`/`message`) so the
 * surfaces cannot drift; `stop_details` supplies provider failure details and
 * the canonical stop reason is the fallback code.
 */
import { describe, expect, test } from "bun:test";
import { stopDetailsError } from "../../../src/transport/surface/adapters";

describe("stopDetailsError", () => {
  test("passes through the provider's message, status, and stop-reason code", () => {
    expect(
      stopDetailsError(
        { message: "quota exhausted", status: 429, code: "rate_limit" },
        "error",
      ),
    ).toEqual({
      type: "server_error",
      code: "error",
      status: 429,
      message: "quota exhausted",
    });
  });

  test("falls back to the generic message and provider_error code", () => {
    expect(stopDetailsError(undefined, undefined)).toEqual({
      type: "server_error",
      code: "provider_error",
      message: "The upstream response failed",
    });
    expect(stopDetailsError("not a record", "content_filter")).toEqual({
      type: "server_error",
      code: "content_filter",
      message: "The upstream response failed",
    });
  });

  test("an empty or non-string message falls back; a non-number status is dropped", () => {
    expect(
      stopDetailsError({ message: "", status: "429" }, "error"),
    ).toEqual({
      type: "server_error",
      code: "error",
      message: "The upstream response failed",
    });
  });
});
