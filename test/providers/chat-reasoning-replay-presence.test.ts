/**
 * The DeepSeek-style reasoning replay rule for OpenAI-compatible resellers.
 *
 * Cline's resold `reflection/beam-free` rejected the whole request with
 * "Missing required parameter: 'messages[3].reasoning_content'" — the upstream
 * demands the field on every earlier assistant turn, *presence* not content,
 * even when a turn has no trace to replay. The reference client already learned
 * the rule and sends `reasoning_content: ""` for exactly those turns, which is
 * the honest value for a turn with nothing to replay.
 *
 * The same rule reaches OpenRouter, Hermes, and Kilo through the shared chat
 * wire, so it is locked at the shared layer rather than per adapter.
 */
import { describe, expect, test } from "bun:test";
import {
  backfillDeepSeekReasoningContent,
  ensureChatReasoningReplayPresence,
} from "../../src/protocol/reasoning";

function payload(
  model: string,
  messages: Record<string, unknown>[],
): { model: string; messages: Record<string, unknown>[] } {
  return { model, messages };
}

describe("chat reasoning replay presence (Cline/OpenRouter/Hermes/Kilo)", () => {
  test("fills an empty reasoning_content on bare assistant turns when a trace exists", () => {
    // The real Cline capture: most earlier assistant turns carry the field, a
    // few bare ones dropped it, and the upstream rejected the whole history.
    // A single surviving trace is enough to put the conversation in replay
    // mode, after which every bare assistant turn must carry the field.
    const p = payload("reflection/beam-free", [
      { role: "assistant", content: "s", reasoning_content: "trace" },
      { role: "user", content: "go on" },
      { role: "assistant", content: "bare" },
    ]);
    ensureChatReasoningReplayPresence(p);
    expect(p.messages[0]).toMatchObject({ reasoning_content: "trace" });
    expect(p.messages[2]).toMatchObject({ role: "assistant", reasoning_content: "" });
  });

  test("does not touch a non-thinking model", () => {
    const p = payload("gpt-5.6-terra", [
      { role: "assistant", content: "no reasoning here" },
    ]);
    ensureChatReasoningReplayPresence(p);
    expect(p.messages[0]).not.toHaveProperty("reasoning_content");
  });

  test("does not fabricate presence when nothing is thinking", () => {
    const p = payload("reflection/beam-free", [
      { role: "user", content: "plain" },
      { role: "assistant", content: "plain answer" },
    ]);
    ensureChatReasoningReplayPresence(p);
    expect(p.messages[1]).not.toHaveProperty("reasoning_content");
  });

  test("preserves a real trace and an explicit empty value", () => {
    const p = payload("reflection/beam-free", [
      { role: "assistant", content: "s", reasoning_content: "real trace" },
      { role: "assistant", content: "t", reasoning_content: "" },
      { role: "assistant", content: "u" },
    ]);
    ensureChatReasoningReplayPresence(p);
    expect(p.messages[0]).toMatchObject({ reasoning_content: "real trace" });
    expect(p.messages[1]).toMatchObject({ reasoning_content: "" });
    expect(p.messages[2]).toMatchObject({ reasoning_content: "" });
  });

  test("backfill still mirrors the model's own reasoning key", () => {
    const p = payload("reflection/beam-free", [
      { role: "assistant", content: "s", reasoning: "inner thought" },
    ]);
    backfillDeepSeekReasoningContent(p);
    expect(p.messages[0]).toMatchObject({ reasoning_content: "inner thought" });
  });
});
