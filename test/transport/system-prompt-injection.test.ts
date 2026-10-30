/**
 * Tenant system-prompt injection: resolution (most-specific-wins), the
 * canonical transform (append/override), the buddy wrapped-append path, and
 * the console API validation.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";
import {
  SYSTEM_PROMPT_WRAPPER_PREFIX,
  SYSTEM_PROMPT_WRAPPER_SUFFIX,
  systemPromptModelKey,
} from "../../src/console/system-prompt/contracts";
import {
  applyInjectSystemPrompt,
  resolveTenantSystemPrompt,
} from "../../src/transport/request/system-prompt-injection";
import { applyBuddySystemPrompt } from "../../src/providers/integrations/buddy/buddy-chat-shared";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "model-x",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    ...overrides,
  } as CanonicalRequest;
}

function setting(text: string, mode: "append" | "override" = "append", enabled = true) {
  return { enabled, mode, text };
}

describe("resolveTenantSystemPrompt", () => {
  const prompts = {
    global: setting("global-prompt"),
    providers: {
      "prov-a": { followGlobal: true },
      "prov-b": { followGlobal: false, setting: setting("prov-b-prompt") },
      "prov-off": { followGlobal: false, setting: setting("off", "append", false) },
    },
    models: {
      [systemPromptModelKey("prov-a", "model-1")]: setting("model-prompt"),
    },
  };

  test("model scope wins over provider/global", () => {
    expect(resolveTenantSystemPrompt(prompts, { providerId: "prov-a", modelId: "model-1" })?.text).toBe("model-prompt");
  });

  test("followGlobal provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(prompts, { providerId: "prov-a", modelId: "model-2" })?.text).toBe("global-prompt");
  });

  test("custom provider setting beats global", () => {
    expect(resolveTenantSystemPrompt(prompts, { providerId: "prov-b", modelId: "m" })?.text).toBe("prov-b-prompt");
  });

  test("disabled custom provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(prompts, { providerId: "prov-off", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("unconfigured provider falls back to global", () => {
    expect(resolveTenantSystemPrompt(prompts, { providerId: "other", modelId: "m" })?.text).toBe("global-prompt");
  });

  test("no global configured → undefined", () => {
    expect(
      resolveTenantSystemPrompt(
        { global: null, providers: {}, models: {} },
        { providerId: "x", modelId: "y" },
      ),
    ).toBeUndefined();
  });
});

describe("applyInjectSystemPrompt", () => {
  test("appends tenant text after existing system content", () => {
    const base = request({ system: [{ kind: "text", text: "caller" }] });
    const next = applyInjectSystemPrompt(
      base,
      { global: setting("tenant"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toHaveLength(2);
    expect(next.system?.[1]).toEqual({ kind: "text", text: "tenant" });
  });

  test("creates system content when absent", () => {
    const next = applyInjectSystemPrompt(
      request(),
      { global: setting("tenant"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("override replaces caller system content", () => {
    const base = request({ system: [{ kind: "text", text: "caller" }] });
    const next = applyInjectSystemPrompt(
      base,
      { global: setting("tenant", "override"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("override keeps replaced content when no caller system exists", () => {
    const next = applyInjectSystemPrompt(
      request(),
      { global: setting("tenant", "override"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next.system).toEqual([{ kind: "text", text: "tenant" }]);
  });

  test("idempotent: the same text is not appended twice", () => {
    const base = applyInjectSystemPrompt(
      request(),
      { global: setting("tenant"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    const again = applyInjectSystemPrompt(
      base,
      { global: setting("tenant"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(again.system).toHaveLength(1);
  });

  test("skips non-llm service kinds", () => {
    const base = request();
    const next = applyInjectSystemPrompt(
      base,
      { global: setting("tenant"), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "systemone" },
    );
    expect(next).toBe(base);
  });

  test("disabled setting is a no-op", () => {
    const base = request();
    const next = applyInjectSystemPrompt(
      base,
      { global: setting("x", "append", false), providers: {}, models: {} },
      { providerId: "p", modelId: "m", serviceKind: "llm" },
    );
    expect(next).toBe(base);
  });
});

describe("buddy wrapped append", () => {
  test("identity prompt stays the opener; tenant text rides wrapped", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "caller system" },
      { role: "user", content: "hi" },
    ];
    applyBuddySystemPrompt(messages, "You are CodeBuddy Code.", "tenant directive");
    expect(messages[0]?.["role"]).toBe("system");
    const content = String(messages[0]?.["content"]);
    expect(content.startsWith("You are CodeBuddy Code.")).toBe(true);
    expect(content).toContain(SYSTEM_PROMPT_WRAPPER_PREFIX);
    expect(content).toContain("tenant directive");
    expect(content).toContain(SYSTEM_PROMPT_WRAPPER_SUFFIX);
    // Caller system text was replaced (identity preserved, caller dropped).
    expect(content).not.toContain("caller system");
    // The user turn survived.
    expect(messages.some((m) => m["role"] === "user")).toBe(true);
  });

  test("no tenant text → prompt unchanged", () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }];
    applyBuddySystemPrompt(messages, "You are CodeBuddy Code.");
    expect(messages[0]?.["content"]).toBe("You are CodeBuddy Code.");
  });
});
