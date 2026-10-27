/**
 * Wire-family and surface contract coverage.
 *
 * The gateway understands each wire shape twice: the registry codecs
 * (`src/protocol/registry.ts`) for the OpenAI-compatible adapters, and the
 * bespoke per-integration builders for the branded providers. The two trees
 * must stay in step with the canonical model, and the client-surface map must
 * stay one-to-one. These tests pin the structural invariants around that
 * contract so a drift is a failing test, not a silent mis-encode.
 */
import { describe, expect, test } from "bun:test";
import { preloadCodec } from "../../src/protocol/registry";
import {
  SurfaceAdapterRegistry,
  SURFACE_DESCRIPTORS,
} from "../../src/transport/surface/adapters";

describe("wire-family codec coverage", () => {
  test("registry loads a codec for every non-native wire family", async () => {
    await expect(preloadCodec("chat")).resolves.toBeUndefined();
    await expect(preloadCodec("responses")).resolves.toBeUndefined();
    await expect(preloadCodec("messages")).resolves.toBeUndefined();
  });

  test("gemini has no registry codec — it dispatches through its native path", async () => {
    await expect(preloadCodec("gemini")).rejects.toThrow();
  });
});

describe("client surface map", () => {
  test("every descriptor names a distinct surface and path prefix", () => {
    const surfaces = new Set(SURFACE_DESCRIPTORS.map((d) => d.surface));
    const prefixes = new Set(SURFACE_DESCRIPTORS.map((d) => d.pathPrefix));
    expect(surfaces.size).toBe(SURFACE_DESCRIPTORS.length);
    expect(prefixes.size).toBe(SURFACE_DESCRIPTORS.length);
  });

  test("detection maps each canonical endpoint to exactly its surface", () => {
    const registry = new SurfaceAdapterRegistry(
      SURFACE_DESCRIPTORS.map((d) => ({
        surface: d.surface,
        matchesBodyShape: () => false,
      })),
    );
    for (const d of SURFACE_DESCRIPTORS) {
      const detected = registry.detectOnce({
        body: {},
        headers: {},
        path: d.pathPrefix,
      });
      expect(detected.surface).toBe(d.surface);
    }
  });
});
