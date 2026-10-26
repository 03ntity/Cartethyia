/**
 * InferHub market routes end to end.
 *
 * Drives the real Elysia app (`createInferhubRoutes`) over synthesized upstream
 * payloads, so the assertions are about what a client actually receives rather
 * than about an internal helper.
 *
 * The properties pinned here are the ones the design rests on:
 * - Market data is fetched on demand, and a second request inside the freshness
 *   window issues **no** upstream call.
 * - Global admin only — an unauthenticated request is rejected.
 * - No response ever carries the credential.
 * - Staleness and age are reported, never hidden.
 */
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createInferhubRoutes } from "../../src/console/inferhub/routes";
import { __resetStore, setModels } from "../../src/console/inferhub/store";
import { __resetRateLimit } from "../../src/console/inferhub/client";
import { normalizeCatalogModel } from "../../src/console/inferhub/normalize";
import type { AccessDecision } from "../../src/security/access-control";

const CONFIG_KEY = "sk-airo-config-read-key";

/**
 * An `inferhub` catalog in the real wire shape: a **bare array** of upstreams,
 * each with its own `models` array. Prices are `[price, providerCount]` tuples
 * and the model id is the `upstreamModelId` slug (`id` is a UUID).
 */
const CATALOG = [
  {
    prefix: "cc",
    label: "Claude Code",
    systemPromptNote: "Adds a client header block.",
    models: [
      {
        id: "eac4da12-04f0-4314-bb80-4e43bcacb322",
        upstreamModelId: "claude-opus-4-6",
        officialIn: "15",
        officialOut: "75",
        pricePointsIn: [[6, 2]],
        pricePointsOut: [[30, 2]],
      },
    ],
  },
  {
    prefix: "cb",
    label: "CodeBuddy",
    systemPromptNote: null,
    models: [
      {
        id: "70cfd249-9284-4fe6-a8a4-dd17b75a3f55",
        upstreamModelId: "claude-opus-4.6",
        officialIn: "15",
        officialOut: "75",
        pricePointsIn: [[3, 1]],
        pricePointsOut: [[15, 1]],
      },
    ],
  },
  {
    prefix: "zai",
    label: "Z.AI",
    systemPromptNote: null,
    // Empty price points: the "No Provider" case.
    models: [
      {
        id: "9509973c-a898-48d4-9a60-6c3d293065cc",
        upstreamModelId: "glm-5.3-flash",
        officialIn: "1",
        officialOut: "4",
        pricePointsIn: [],
        pricePointsOut: [],
      },
    ],
  },
];

const MARKET = {
  ts: 1,
  models: [
    { slug: "cc/claude-opus-4-6", minAskIn: 6, lastRate: 12.5 },
    { slug: "cb/claude-opus-4.6", minAskIn: 3, lastRate: null },
  ],
};

const ADMIN = { scopes: ["platform:admin"] } as unknown as AccessDecision;

function app(
  options: {
    access?: AccessDecision | undefined;
    configKey?: string | undefined;
    onFetch?: (url: string) => void;
  } = {},
) {
  let calls = 0;
  const fetchFn = (async (url: string) => {
    calls += 1;
    options.onFetch?.(String(url));
    const path = String(url);
    const body = path.includes("/catalog")
      ? CATALOG
      : path.includes("/market")
        ? MARKET
        : { families: [{ slug: "antigravity", prefix: "ag", family: "Antigravity", state: "operational", availability24hPct: 99.74, availability7dPct: 92.24 }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const elysia = new Elysia().use(
    createInferhubRoutes({
      accessResolver: () => options.access,
      resolveConfigKey: () => options.configKey,
      fetchFn,
    }),
  );
  return {
    elysia,
    calls: () => calls,
  };
}

describe("InferHub market routes", () => {
  test("compare lists every matching prefix sorted by min input ask", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/compare?alias=claude-opus-4-6"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: { id: string; minAskIn: number | null }[] };
    expect(body.models.map((model) => model.id)).toEqual(["cb/claude-opus-4.6", "cc/claude-opus-4-6"]);
    expect(body.models[0]?.minAskIn).toBe(3);
  });

  test("a model with no asks reports zero live providers and stays listed", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/models?prefix=zai"),
    );
    const body = (await response.json()) as {
      models: { id: string; providersLive: number; routable: boolean }[];
    };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.providersLive).toBe(0);
    expect(body.models[0]?.routable).toBe(false);
  });

  test("a second request inside the freshness window issues no upstream call", async () => {
    __resetStore();
    __resetRateLimit(0);
    const harness = app({ access: ADMIN, configKey: CONFIG_KEY });
    const url = "http://localhost/inferhub/models";
    await harness.elysia.handle(new Request(url));
    const afterFirst = harness.calls();
    await harness.elysia.handle(new Request(url));
    // The whole design is on-demand: no poller, so a repeat read is free.
    expect(harness.calls()).toBe(afterFirst);
  });

  test("an unauthenticated request is rejected", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: undefined, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/models"),
    );
    expect(response.status).toBe(401);
  });

  test("a tenant-scoped reader without platform:admin is rejected", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({
      access: { scopes: ["dashboard:read"] } as unknown as AccessDecision,
      configKey: CONFIG_KEY,
    });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/models"),
    );
    expect(response.status).toBe(403);
  });

  test("no response ever carries the config key", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/summary"),
    );
    const text = await response.text();
    expect(text).not.toContain("sk-airo");
    expect(text).not.toContain(CONFIG_KEY);
  });

  test("every response reports ageSeconds and fetchedAt", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/models"),
    );
    const body = (await response.json()) as { meta: { ageSeconds: number; fetchedAt: number; stale: boolean } };
    expect(typeof body.meta.ageSeconds).toBe("number");
    expect(body.meta.fetchedAt).toBeGreaterThan(0);
    expect(body.meta.stale).toBe(false);
  });

  test("per-family state and availability are mapped, not left null", async () => {
    // These were hardcoded to null, so the card showed no state at all even
    // though `/status` reports one for every family.
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(new Request("http://localhost/inferhub/summary"));
    const body = (await response.json()) as {
      providers: { prefix: string; family: string; familyState: string | null; availability24hPct: number | null }[];
    };
    const family = body.providers[0];
    expect(family?.familyState).toBe("operational");
    // `family` is the display name; `slug` is only the fallback.
    expect(family?.family).toBe("Antigravity");
    expect(family?.availability24hPct).toBe(99.74);
  });

  test("a missing config key reports no_config_key instead of failing", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: undefined });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/summary"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: string | null };
    expect(body.error).toBe("no_config_key");
  });

  test("the untrusted systemPromptNote is carried through as data", async () => {
    __resetStore();
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/models?prefix=cc"),
    );
    const body = (await response.json()) as { models: { systemPromptNote: string | null }[] };
    expect(body.models[0]?.systemPromptNote).toBe("Adds a client header block.");
  });

  test("the CSV export quotes fields and neutralizes a leading formula character", async () => {
    __resetStore();
    // The id itself starts with `=`, which a spreadsheet would execute as a
    // formula. The guard must neutralize the *field*, not a slash in the middle
    // of one.
    setModels(
      [
        normalizeCatalogModel(
          { id: "uuid-1", upstreamModelId: "=cmd/calc", officialIn: "1", officialOut: "2", pricePointsIn: [[1, 1]], pricePointsOut: [[2, 1]] },
          { prefix: "cb", label: "CodeBuddy", systemPromptNote: null },
        )!,
      ],
      Date.now(),
    );
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/export.csv"),
    );
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/csv");
    // A leading `=` would be executed as a formula by a spreadsheet.
    // A value that *starts* with `=` is neutralized; `=` in the middle of a
    // field (`cb/=cmd/calc`) is inert and must be left alone.
    expect(text).toContain('"cb/=cmd/calc"');
    expect(text).not.toContain("\"=cmd/calc\"");
  });

  test("a value that genuinely starts with = is neutralized", async () => {
    __resetStore();
    // The *family* begins with `=`, so the guard must fire on that field.
    setModels(
      [
        normalizeCatalogModel(
          { id: "u1", upstreamModelId: "m1", officialIn: "1", officialOut: "2", pricePointsIn: [[1, 1]], pricePointsOut: [[2, 1]] },
          { prefix: "cb", label: "=cmd/calc", systemPromptNote: null },
        )!,
      ],
      Date.now(),
    );
    __resetRateLimit(0);
    const { elysia } = app({ access: ADMIN, configKey: CONFIG_KEY });
    const response = await elysia.handle(
      new Request("http://localhost/inferhub/export.csv"),
    );
    const text = await response.text();
    expect(text).toContain('"\'=cmd/calc"');
  });
});
