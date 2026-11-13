/**
 * Free-pi chat body builder: mid-conversation system/developer turns must
 * reach the wire as their own system messages, and a turn carrying several
 * tool results must emit one `tool` message per result (parallel calls
 * survive). Both shapes were silently dropped before.
 */
import { describe, expect, test } from "bun:test";
import type {
  CanonicalMessage,
  CanonicalRequest,
} from "../../src/protocol/canonical-model";
import { buildFreepiChatBody } from "../../src/providers/integrations/freepi/freepi-protocol";

function requestWith(messages: CanonicalMessage[]): CanonicalRequest {
  return {
    model: "deepseek/deepseek-v4-flash",
    messages,
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

function textOf(message: { role: string; content: unknown }): string {
  return String(message.content);
}

describe("buildFreepiChatBody message mapping", () => {
  test("mid-conversation system and developer turns become system messages in order", () => {
    const body = buildFreepiChatBody(
      "m",
      requestWith([
        { role: "user", content: [{ kind: "text", text: "first" }] },
        { role: "system", content: [{ kind: "text", text: "mid system" }] },
        { role: "assistant", content: [{ kind: "text", text: "answer" }] },
        { role: "developer", content: [{ kind: "text", text: "mid developer" }] },
        { role: "user", content: [{ kind: "text", text: "last" }] },
      ]),
    );
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "system", "assistant", "system", "user"]);
    expect(textOf(body.messages[1]!)).toBe("mid system");
    expect(textOf(body.messages[3]!)).toBe("mid developer");
  });

  test("a turn with parallel tool results emits one tool message per result", () => {
    const body = buildFreepiChatBody(
      "m",
      requestWith([
        {
          role: "assistant",
          content: [
            {
              kind: "toolCall",
              call_id: "call_a",
              name: "read_files",
              arguments: { path: "a" },
            },
            {
              kind: "toolCall",
              call_id: "call_b",
              name: "read_files",
              arguments: { path: "b" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              kind: "toolResult",
              call_id: "call_a",
              content: [{ kind: "text", text: "result A" }],
            },
            {
              kind: "toolResult",
              call_id: "call_b",
              content: [{ kind: "text", text: "result B" }],
            },
          ],
        },
      ]),
    );
    const tools = body.messages.filter((m) => m.role === "tool");
    expect(tools.length).toBe(2);
    expect(tools[0]).toMatchObject({ tool_call_id: "call_a", content: "result A" });
    expect(tools[1]).toMatchObject({ tool_call_id: "call_b", content: "result B" });
  });

  test("a single tool result still emits exactly one tool message", () => {
    const body = buildFreepiChatBody(
      "m",
      requestWith([
        {
          role: "user",
          content: [
            {
              kind: "toolResult",
              call_id: "call_a",
              content: [{ kind: "text", text: "result A" }],
            },
          ],
        },
      ]),
    );
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: "tool", tool_call_id: "call_a" });
  });
});
