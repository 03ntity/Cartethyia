// Regression: Gemini `tools` must merge hosted declarations WITH function
// declarations. The function block used to overwrite the hosted block, so a
// request declaring `googleSearch` plus any function tool silently lost the
// websearch grounding while the request still succeeded.
import { describe, expect, test } from "bun:test";
import { buildGeminiPayload } from "../../src/protocol/request/gemini";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function requestWithTools(
  tools: ReadonlyArray<Record<string, unknown>>,
): CanonicalRequest {
  return {
    model: "gemini-3-flash",
    stream: false,
    source_surface: "gemini",
    generation_controls: {},
    tools,
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  } as unknown as CanonicalRequest;
}

describe("buildGeminiPayload tool declarations", () => {
  test("mixed hosted + function tools keep both entries", () => {
    const payload = buildGeminiPayload(
      requestWithTools([
        { name: "googleSearch", jsonSchema: {} },
        { name: "get_weather", jsonSchema: { type: "object" } },
      ]),
    );
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools.some((entry) => "googleSearch" in entry)).toBe(true);
    const functions = tools.find((entry) => "functionDeclarations" in entry);
    expect(functions).toBeDefined();
    const declarations = functions!["functionDeclarations"] as Array<{ name: string }>;
    expect(declarations.map((d) => d.name)).toEqual(["get_weather"]);
  });

  test("hosted-only requests still emit only the hosted declaration", () => {
    const payload = buildGeminiPayload(
      requestWithTools([{ name: "googleSearch", jsonSchema: {} }]),
    );
    expect(payload["tools"]).toEqual([{ googleSearch: {} }]);
  });

  test("function-only requests still emit only functionDeclarations", () => {
    const payload = buildGeminiPayload(
      requestWithTools([{ name: "get_weather", jsonSchema: { type: "object" } }]),
    );
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect("functionDeclarations" in tools[0]!).toBe(true);
  });

  test("web_search tool_type also merges with function tools", () => {
    const payload = buildGeminiPayload(
      requestWithTools([
        { name: "search", tool_type: "web_search", jsonSchema: {} },
        { name: "get_weather", jsonSchema: { type: "object" } },
      ]),
    );
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    expect(tools.some((entry) => "googleSearch" in entry)).toBe(true);
    expect(tools.some((entry) => "functionDeclarations" in entry)).toBe(true);
  });
});
