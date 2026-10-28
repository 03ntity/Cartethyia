import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import { degradedRequestVariants } from "../../src/transport/request/degradation";

/**
 * A tools+image request against routes grouped by capability planner. The
 * failing production shape: a text-only model that tool-calls fine served a
 * transcript of `[tool:<name>]` placeholders with no tool catalog, because the
 * cumulative degradation chain lost `tools` as collateral while walking toward
 * the variant that survives (the later-ordered `image` loss).
 */
function toolsAndImageRequest(): CanonicalRequest {
  return {
    model: "test-model",
    messages: [
      { role: "user", content: [{ kind: "image", payload: { bytes: 16 } }] },
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: "c1", name: "shell", arguments: {} }],
      },
      { role: "tool", content: [{ kind: "text", text: "stdout" }] },
      { role: "user", content: [{ kind: "text", text: "done" }] },
    ],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    tools: [{ name: "shell", description: "run", parameters: { type: "object", properties: {} } }],
  } as unknown as CanonicalRequest;
}

describe("degradedRequestVariants", () => {
  test("emits the pristine variant first with the full requirement set", () => {
    const original = toolsAndImageRequest();
    const first = degradedRequestVariants(original).next().value;
    expect(first.degraded).toEqual([]);
    expect(first.request).toBe(original);
    expect(first.required).toContain("tools");
    expect(first.required).toContain("image");
  });

  test("offers every single-capability loss before the chain can stack losses", () => {
    const singles = [...degradedRequestVariants(toolsAndImageRequest())].filter(
      (variant) => variant.degraded.length === 1,
    );
    // Both required-but-lossy capabilities were degraded, figure: `tools`
    // (cheapest-to-degrade policy) before `image`.
    expect(singles.map((variant) => variant.degraded[0])).toContain("tools");
    expect(singles.map((variant) => variant.degraded[0])).toContain("image");
  });

  test("the image-only loss keeps the tool catalog and the tool-call turn intact", () => {
    const imageOnly = [...degradedRequestVariants(toolsAndImageRequest())].find((variant) =>
      variant.degraded.includes("image"),
    );
    expect(imageOnly).toBeDefined();
    const request = imageOnly!.request;
    expect(request.tools?.map((tool) => tool.name)).toEqual(["shell"]);
    const assistant = request.messages.find((message) => message.role === "assistant");
    const call = assistant?.content.find(
      (part) => (part as { kind: string }).kind === "toolCall",
    ) as { kind: "toolCall"; name: string } | undefined;
    // Not rewritten into a `[tool:shell]` text placeholder.
    expect(call?.name).toBe("shell");
    // The image itself was replaced by its text fallback.
    expect(request.messages[0]?.content[0]).toEqual({ kind: "text", text: "[image]" });
  });

  test("the cumulative chain still follows the single-capability pre-pass", () => {
    const variants = [...degradedRequestVariants(toolsAndImageRequest())];
    const firstChainIndex = variants.findIndex((variant) => variant.degraded.length > 1);
    const lastSingleIndex = variants.map((variant) => variant.degraded.length).lastIndexOf(1);
    expect(firstChainIndex).toBeGreaterThanOrEqual(0);
    expect(firstChainIndex).toBeGreaterThan(lastSingleIndex);
    // And it is cumulative: each step adds one loss to the previous request.
    expect(variants[firstChainIndex]!.degraded.length).toBeGreaterThanOrEqual(2);
  });
});
