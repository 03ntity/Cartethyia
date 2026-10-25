/**
 * Cursor-native tool variants resolve to canonical calls, and results find
 * their way back to the arm they came from.
 *
 * The one property worth pinning is the round trip's identity: `pi_read` must
 * not come back as `read`. They are two tools with two args shapes and two
 * result shapes, and a mapping that collapsed them would look correct in every
 * test that never checked `variant`.
 */
import { describe, expect, test } from "bun:test";
import {
  CURSOR_TOOL_VARIANTS,
  CursorToolCallProvenance,
  cursorNativeToolDeclaration,
  cursorToolArm,
  decodeCursorNativeToolCall,
} from "../../src/providers/integrations/cursor/protocol/tool-canonical";

describe("cursor native tool mapping", () => {
  test("every arm resolves to its own identity, not a merged one", () => {
    // read / pi_read and shell / pi_bash / write_shell_stdin stay distinct:
    // their args and result shapes genuinely differ, and folding them would
    // mean telling the truth about one and lying about the other.
    const names = [...CURSOR_TOOL_VARIANTS.values()].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("read");
    expect(names).toContain("pi_read");
    expect(names).toContain("shell");
    expect(names).toContain("pi_bash");
    expect(names).toContain("write_shell_stdin");
  });

  test("the modern exec family is mapped at all", () => {
    // The gap this closes: the Pi* arms (61-67) had no entry anywhere in the
    // protocol layer, so those calls were simply never recognised.
    for (const field of [61, 62, 63, 64, 65, 66, 67]) {
      expect(CURSOR_TOOL_VARIANTS.get(field)).toBeDefined();
    }
    expect(CURSOR_TOOL_VARIANTS.get(61)!.name).toBe("pi_read");
  });

  test("a decoded call keeps the arm it came from", () => {
    const decoded = decodeCursorNativeToolCall("call-1", {
      piReadToolCall: { args: { path: "src/main.ts" } },
    });
    expect(decoded?.name).toBe("pi_read");
    expect(decoded?.variant.field).toBe(61);
    expect(decoded?.arguments).toEqual({ path: "src/main.ts" });
  });

  test("provenance round-trips: pi_read does not come back as read", () => {
    const decoded = decodeCursorNativeToolCall("call-2", {
      piReadToolCall: { args: { path: "a" } },
    })!;
    const provenance = new CursorToolCallProvenance();
    provenance.record(decoded.callId, decoded.variant);
    expect(provenance.lookup("call-2")?.name).toBe("pi_read");
    // The legacy arm is untouched by a pi_ call's provenance.
    expect(provenance.lookup("call-2")?.name).not.toBe("read");
    provenance.complete("call-2");
    expect(provenance.lookup("call-2")).toBeUndefined();
  });

  test("an unknown arm is left for MCP rather than guessed", () => {
    // `mcp_tool_call` is deliberately absent: client-declared tools have no
    // native slot in agent.proto. Returning undefined is what lets the MCP
    // meta-tool path claim the call instead of it being swallowed here.
    expect(cursorToolArm({ mcpToolCall: { args: {} } })).toBeUndefined();
    expect(decodeCursorNativeToolCall("c", { mcpToolCall: { args: {} } })).toBeUndefined();
  });

  test("a ToolCall with no populated arm is not a tool call", () => {
    expect(cursorToolArm({})).toBeUndefined();
    expect(cursorToolArm({ shellToolCall: null })).toBeUndefined();
  });

  test("declarations are advertised under the canonical name", () => {
    const declaration = cursorNativeToolDeclaration(
      CURSOR_TOOL_VARIANTS.get(63)!,
      "Apply an edit",
    );
    expect(declaration.name).toBe("pi_edit");
    expect(declaration.jsonSchema).toEqual({ type: "object", properties: {} });
  });
});
