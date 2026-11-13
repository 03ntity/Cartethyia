/**
 * The shared tuple-row catalog factory (`shared/catalog-rows.ts`).
 *
 * The contract that matters is not the happy path — it is that the factory
 * cannot silently drop or reshape a row: `modelId` always comes from the
 * tuple's first slot, `caps` supplies every shared field, `translate` may
 * override per row, and a field neither side supplies falls through to
 * `defineModel`'s own catalog resolution exactly as the hand-written
 * builders did.
 */
import { describe, expect, test } from "bun:test";
import { catalogRows } from "../../src/providers/integrations/shared/catalog-rows";

type Row = readonly [id: string, ctx: number, reasoning: boolean];

const build = catalogRows<Row>({
  providerId: "testprovider",
  caps: {
    wireFamily: "chat",
    endpoint: "/chat/completions",
    vision: true,
    toolCall: true,
  },
  translate: ([, ctx, reasoning]) => ({ ctx, reasoning }),
});

describe("catalogRows", () => {
  test("tuple slot 0 is the model id, never a translate field", () => {
    const row = build(["model-a", 1000, true]);
    expect(row.modelId).toBe("model-a");
    expect(row.contextLimit).toBe(1000);
    expect(row.reasoning).toBe(true);
  });

  test("caps supply the shared fields on every row", () => {
    const row = build(["model-a", 1000, true]);
    expect(row.wireFamily).toBe("chat");
    expect(row.endpointPath).toBe("/chat/completions");
    expect(row.toolCall).toBe(true);
    expect(row.modalities.input).toContain("image");
  });

  test("a translate value wins over a caps default", () => {
    const withOverride = catalogRows<Row>({
      caps: { wireFamily: "chat", reasoning: false },
      translate: ([, ctx, reasoning]) => ({ ctx, reasoning }),
    });
    expect(withOverride(["m", 5, true]).reasoning).toBe(true);
  });

  test("fields neither side supplies fall back to defineModel defaults", () => {
    const minimal = catalogRows<readonly [id: string]>({
      caps: {},
      translate: () => ({}),
    });
    const row = minimal(["unfiled-model-id"]);
    // `unfiled-model-id` is filed nowhere: the row stays routable on the
    // shared fallback limits and is flagged as estimated, not silently exact.
    expect(row.limitsEstimated).toBe(true);
    expect(row.contextLimit).toBeGreaterThan(0);
    expect(row.outputLimit).toBeGreaterThan(0);
  });

  test("providerId reaches the base-catalog lookup", () => {
    // `gpt-4o` is filed under several providers; pinning one keeps the row's
    // limits/cost scoped to that provider's serving rather than a bare-id
    // majority vote.
    const scoped = catalogRows<readonly [id: string]>({
      providerId: "openai",
      caps: {},
      translate: () => ({}),
    });
    const row = scoped(["gpt-4o"]);
    expect(row.modelId).toBe("gpt-4o");
    expect(row.contextLimit).not.toBeNull();
  });
});
