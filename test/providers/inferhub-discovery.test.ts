/**
 * InferHub live `/v1/models` discovery.
 *
 * InferHub republishes a whole marketplace roster, so the catalog must come
 * from the upstream rather than a committed array. Two properties matter and
 * both are easy to get wrong:
 *
 * 1. **The `prefix/model` shape survives.** The prefix selects the upstream
 *    provider behind the marketplace; stripping it routes to the wrong place or
 *    to nothing.
 * 2. **Claude-backed ids land on Messages.** The generic OpenAI discovery loader
 *    only ever says `chat` or `responses`, and the chat wire strips thinking and
 *    native tool_use server-side — so a Claude id classified as chat loses its
 *    reasoning even though the request succeeded.
 */
import { describe, expect, test } from "bun:test";
import { INFERHUB_MODELS, inferhubModelDiscovery } from "../../src/providers/integrations/inferhub";

/** A synthesized `/v1/models` response in InferHub's `prefix/model` shape. */
const MODELS_PAYLOAD = JSON.stringify({
  object: "list",
  data: [
    { id: "cc/claude-opus-5-5", context_window: 1_000_000, max_completion_tokens: 128_000 },
    { id: "ag/claude-sonnet-4-6", context_window: 1_000_000, max_completion_tokens: 128_000 },
    { id: "cb/claude-opus-4.6", context_window: 1_000_000, max_completion_tokens: 128_000 },
    { id: "cx/gpt-5.6-terra", context_window: 1_050_000, max_completion_tokens: 128_000 },
    { id: "zai/glm-5.3-flash", context_window: 1_000_000, max_completion_tokens: 131_072 },
  ],
});

/** A 200 response that names no models — the same failure as a 403, in that
 *  zero discovered models would wipe the catalog. */
const EMPTY_PAYLOAD = JSON.stringify({ object: "list", data: [] });

function stubFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function discover(body: string, status = 200) {
  const loader = inferhubModelDiscovery();
  const discovery = await loader();
  const payload = body === "empty" ? EMPTY_PAYLOAD : body;
  return discovery({
    baseUrl: "https://api.inferhub.dev/v1",
    credential: "sk-airo-test",
    fetcher: stubFetch(payload, status),
  });
}

describe("InferHub model discovery", () => {
  test("keeps the prefix/model shape intact", async () => {
    const models = await discover(MODELS_PAYLOAD);
    expect(models).not.toBeNull();
    const ids = (models ?? []).map((model) => model.modelId).sort();
    expect(ids).toEqual([
      "ag/claude-sonnet-4-6",
      "cb/claude-opus-4.6",
      "cc/claude-opus-5-5",
      "cx/gpt-5.6-terra",
      "zai/glm-5.3-flash",
    ]);
    // A stripped prefix would leave a bare model id behind.
    for (const id of ids) expect(id).toContain("/");
  });

  test("routes Claude-backed ids to the Messages wire", async () => {
    const models = await discover(MODELS_PAYLOAD);
    const byId = new Map((models ?? []).map((model) => [model.modelId, model]));
    for (const id of ["cc/claude-opus-5-5", "ag/claude-sonnet-4-6", "cb/claude-opus-4.6"]) {
      expect(byId.get(id)?.wireFamily).toBe("messages");
      expect(byId.get(id)?.endpointPath).toBe("/v1/messages");
    }
  });

  test("leaves non-Claude ids on the wire the generic loader chose", async () => {
    const models = await discover(MODELS_PAYLOAD);
    const byId = new Map((models ?? []).map((model) => [model.modelId, model]));
    // `gpt-5.6-*` is responses-native; `glm-*` is not, so it stays chat.
    expect(byId.get("cx/gpt-5.6-terra")?.wireFamily).toBe("responses");
    expect(byId.get("zai/glm-5.3-flash")?.wireFamily).toBe("chat");
  });

  test("carries the limits the upstream declares", async () => {
    const models = await discover(MODELS_PAYLOAD);
    const opus = (models ?? []).find((model) => model.modelId === "cc/claude-opus-5-5");
    expect(opus?.contextLimit).toBe(1_000_000);
    expect(opus?.outputLimit).toBe(128_000);
  });

  test("falls back to the offline catalog on a failed fetch", async () => {
    // Probing throws "endpoint returned no usable models" on a null return, and
    // a `config_read` key is rejected with 403 by the inference host — neither
    // means InferHub has no models. The committed list is a valid answer, so a
    // failed read must not fail the whole refresh.
    const models = await discover("nope", 500);
    expect(models).not.toBeNull();
    expect(models).toHaveLength(INFERHUB_MODELS.length);
  });

  test("falls back to the offline catalog on an empty model list", async () => {
    // An upstream that answers 200 with zero rows is the same failure: zero
    // discovered models would wipe the catalog.
    const models = await discover("empty", 200);
    expect(models).not.toBeNull();
    expect(models).toHaveLength(INFERHUB_MODELS.length);
  });

  test("re-derives the wire family for the fallback list too", async () => {
    // The fallback is a single non-Claude row, so this pins that a fallback
    // row is still classified rather than passed through unclassified.
    const models = await discover("nope", 500);
    expect(models?.map((model) => model.modelId)).toEqual(["cb/deepseek-v4.1-flash"]);
    for (const model of models ?? []) {
      expect(model.wireFamily).not.toBe("messages");
    }
  });

  test("a Claude row in the discovered list is forced onto Messages", async () => {
    // Classification must survive the fallback path, not only the live one.
    const models = await discover(
      JSON.stringify({ object: "list", data: [{ id: "cc/claude-opus-5-5" }] }),
      200,
    );
    const claude = models?.filter((model) => model.wireFamily === "messages") ?? [];
    expect(claude.length).toBe(1);
    expect(claude[0]?.endpointPath).toBe("/v1/messages");
  });
});
