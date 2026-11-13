/**
 * The Command Code envelope and identity headers, against what its own client
 * sends.
 *
 * Three things were wrong, and each was invisible because the upstream still
 * answered:
 *
 *   * Tools omitted `type: "function"`. The reference client sends it on every
 *     tool, and a tool without it is not recognised as callable.
 *
 *   * `taste` and `skills` were absent and `memory` was `""`. The client sends
 *     all three as `null`, and the envelope is validated, so an absent field is
 *     not the same as a null one.
 *
 *   * `config.environment` was `""`. The client reports the real runtime; a
 *     blank attribution field is indistinguishable from one never filled in.
 *
 * Headers: `x-cli-environment` was `cli` rather than `production`, and
 * `x-project-slug` / `x-taste-learning` / `User-Agent` were missing entirely.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRequest,
  COMMANDCODE_GENERATE_PATH,
  COMMANDCODE_HOST,
  createCommandCodeAdapter,
  geminiSafeSchema,
  headers,
} from "../../src/providers/integrations/commandcode/commandcode";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-contracts";

const REQUEST: CanonicalRequest = {
  model: "xiaomi/mimo-v2.6-flash",
  system: [{ kind: "text", text: "system fixture" }],
  instructions: [{ kind: "text", text: "instruction fixture" }],
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  generation_controls: { max_output_tokens: 1024, temperature: 0.5, top_p: 0.9 },
  stream: false,
  source_surface: "chat",
};

type CommandCodeTool = {
  readonly name: string;
  readonly description: string | undefined;
  readonly jsonSchema: unknown;
};

function envelope(tools: readonly CommandCodeTool[] = []) {
  return buildRequest(
    "xiaomi/mimo-v2.6-flash",
    {
      ...REQUEST,
      tools: [...tools],
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      reasoningEffort: null,
    },
    "11111111-1111-4111-8111-111111111111",
  );
}

describe("commandcode envelope", () => {
  test("a tool carries type: function", () => {
    const body = envelope([
      { name: "read", description: "read a file", jsonSchema: { type: "object" } },
    ]);
    const params = body["params"] as Record<string, unknown>;
    const tools = params["tools"] as readonly Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["type"]).toBe("function");
    expect(tools[0]?.["input_schema"]).toEqual({ type: "object" });
  });

  test("memory, taste and skills are null, not empty or absent", () => {
    const body = envelope();
    expect(body["memory"]).toBeNull();
    expect("taste" in body).toBe(true);
    expect(body["taste"]).toBeNull();
    expect("skills" in body).toBe(true);
    expect(body["skills"]).toBeNull();
  });

  test("config.environment reports the real runtime", () => {
    const body = envelope();
    const config = body["config"] as Record<string, unknown>;
    expect(config["environment"]).toBe(
      `${process.platform}-${process.arch}, Node.js ${process.version}`,
    );
  });

  test("the envelope keeps the fields the upstream validates", () => {
    // Every one of these was named by the API's own validation errors.
    const config = envelope()["config"] as Record<string, unknown>;
    for (const key of [
      "workingDir",
      "date",
      "environment",
      "structure",
      "isGitRepo",
      "currentBranch",
      "mainBranch",
      "gitStatus",
      "recentCommits",
    ]) {
      expect(key in config).toBe(true);
    }
  });
});

describe("commandcode identity headers", () => {
  test("the environment is production, not cli", async () => {
    expect((await headers("s1", "tok"))["x-cli-environment"]).toBe("production");
  });

  test("attribution headers the client always sends are present", async () => {
    const h = await headers("s1", "tok");
    expect(h["x-taste-learning"]).toBe("true");
    expect(h["x-project-slug"]).toBeTruthy();
    expect(h["user-agent"]).toBe("cli");
    expect(h["x-command-code-version"]).toBeTruthy();
  });

  test("the credential is the bearer", async () => {
    expect((await headers("s1", "tok"))["authorization"]).toBe("Bearer tok");
  });
});

describe("commandcode Go-plan dispatch", () => {
  function dispatchContext() {
    return {
      credential: {
        provider_id: "commandcode",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("go-plan-token"),
      },
      deadline: Date.now() + 60_000,
      abort_signal: new AbortController().signal,
    } as ProviderDispatchContext;
  }

  function dispatchTarget(wire: "chat" | "responses" | "messages"): ProviderDispatchTarget {
    return {
      provider_id: "commandcode",
      model_id: "gpt-5.4-mini",
      wire_family: wire,
      endpoint_path: COMMANDCODE_GENERATE_PATH,
      capabilities: {},
    };
  }

  test("uses the CLI endpoint and one stable session id per conversation", async () => {
    const seen: Array<{ url: string; sessionId: string | null; body: Record<string, unknown> }> = [];
    const adapter = createCommandCodeAdapter({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          sessionId: new Headers(init?.headers).get("x-session-id"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response('{"type":"finish","finishReason":"stop"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }) as typeof fetch,
    });
    const context = dispatchContext();

    for (const wire of ["chat", "responses", "messages"] as const) {
      for await (const _event of adapter.dispatch(
        { ...REQUEST, model: "public-model-alias", conversation_id: "conv-1" },
        dispatchTarget(wire),
        context,
      )) {
        // Drain the stream so the outbound request completes.
      }
    }

    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.url).toBe(`${COMMANDCODE_HOST}${COMMANDCODE_GENERATE_PATH}`);
      // The session id is the conversation's: every wire family of one
      // conversation presents the same `x-session-id` and `threadId`.
      expect(request.sessionId).toBe("conv-1");
      expect(request.body["threadId"]).toBe("conv-1");
      expect(request.body["memory"]).toBeNull();
      expect(request.body["config"]).toBeTruthy();
      expect(request.body["params"]).toMatchObject({
        model: "gpt-5.4-mini",
        system: "system fixture\ninstruction fixture",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stream: true,
        max_tokens: 1024,
        temperature: 0.5,
        top_p: 0.9,
      });
    }
  });

  test("omits x-session-id when the request carries no conversation identity", async () => {
    // The client omits the header rather than inventing a session; the
    // envelope still needs a threadId, so a fresh one is minted for it alone.
    const seen: Array<{ sessionId: string | null; body: Record<string, unknown> }> = [];
    const adapter = createCommandCodeAdapter({
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          sessionId: new Headers(init?.headers).get("x-session-id"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response('{"type":"finish","finishReason":"stop"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }) as typeof fetch,
    });

    for await (const _event of adapter.dispatch(
      { ...REQUEST, model: "public-model-alias" },
      dispatchTarget("chat"),
      dispatchContext(),
    )) {
      // Drain the stream so the outbound request completes.
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBeNull();
    expect(typeof seen[0]?.body["threadId"]).toBe("string");
    expect((seen[0]?.body["threadId"] as string).length).toBeGreaterThan(0);
  });
});

describe("gemini-safe tool schema", () => {
  test("a nullable type array becomes one type plus nullable", () => {
    // Vertex rejects the gateway's `any_of with sibling fields`, which is what
    // a nullable type array becomes.
    expect(geminiSafeSchema({ type: ["string", "null"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  test("a genuine multi-type union is left alone", () => {
    // Only the nullable spelling is the problem; a real union is data.
    expect(geminiSafeSchema({ type: ["string", "number"] })).toEqual({
      type: ["string", "number"],
    });
  });

  test("a null default is dropped", () => {
    expect(geminiSafeSchema({ type: "string", default: null })).toEqual({ type: "string" });
  });

  test("nested properties are rewritten too", () => {
    expect(
      geminiSafeSchema({
        type: "object",
        properties: { name: { type: ["string", "null"] } },
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: "string", nullable: true } },
    });
  });
});
