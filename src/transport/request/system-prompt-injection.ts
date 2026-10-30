/**
 * Tenant system-prompt injection at the canonical level.
 *
 * Runs inside `applyTenantPreferences`, after reasoning/thinking shaping and
 * before RTK/PonyTail, so the injected text composes with (and is then
 * appended-to by) the compression directive. Wire-agnostic: one transform
 * covers messages/chat/responses/gemini/codex/kiro; provider-native
 * injection (Claude identity/billing prepend, buddy fixed system turn,
 * antigravity identity) happens later, in the adapters, and is untouched.
 *
 * Resolution is most-specific-wins: model > provider > global, where a
 * provider either follows the tenant's global prompt or carries a custom one.
 * Failure is non-fatal — an unusable configuration must not fail a
 * dispatchable request.
 */
import type { CanonicalRequest } from "../../protocol/canonical-model";
import type { ServiceKind } from "../../protocol/canonical-model";
import type {
  PromptSetting,
  TenantSystemPrompts,
} from "../../console/system-prompt/contracts";
import {
  systemPromptModelKey,
} from "../../console/system-prompt/contracts";

/** The route facts the resolution needs. */
export interface SystemPromptRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly serviceKind: ServiceKind;
}

/**
 * Resolves the effective prompt for a route: the most-specific enabled scope
 * wins. A provider scope honours its `followGlobal` toggle; model scope is
 * always explicit. Returns `undefined` when nothing applies.
 */
export function resolveTenantSystemPrompt(
  prompts: TenantSystemPrompts | undefined,
  route: Pick<SystemPromptRoute, "providerId" | "modelId">,
): PromptSetting | undefined {
  if (prompts === undefined) return undefined;
  const model = prompts.models[systemPromptModelKey(route.providerId, route.modelId)];
  if (model !== undefined && model.enabled) return model;
  const provider = prompts.providers[route.providerId];
  if (provider !== undefined) {
    if (provider.followGlobal) {
      return prompts.global !== null && prompts.global.enabled ? prompts.global : undefined;
    }
    if (provider.setting !== undefined && provider.setting.enabled) return provider.setting;
  }
  return prompts.global !== null && prompts.global.enabled ? prompts.global : undefined;
}

/** Marker text guard so retries never double-inject. */
function carriesText(system: readonly { kind: string }[] | undefined, text: string): boolean {
  return (system ?? []).some((part) => part.kind === "text" && (part as { text?: string }).text === text);
}

/**
 * Applies the resolved tenant prompt to the canonical request. Appends after
 * existing system content (or replaces the caller's system content for
 * `override` — provider-native identity injection later re-adds the fixed
 * provider prompt, so override is never a bare wire).
 */
export function applyInjectSystemPrompt(
  request: CanonicalRequest,
  prompts: TenantSystemPrompts | undefined,
  route: SystemPromptRoute,
): CanonicalRequest {
  // Non-chat native protocols have no system surface to inject into.
  if (route.serviceKind !== "llm") return request;
  const setting = resolveTenantSystemPrompt(prompts, route);
  if (setting === undefined || setting.text.length === 0) return request;

  const text = setting.text;
  // `override` replaces only the CALLER's system content: the adapters later
  // prepend their mandatory identity/billing blocks (claude, antigravity) or
  // install their fixed system turn (buddy), so the wire always keeps the
  // provider-native prompt. For wrapped-injection providers the override
  // cannot survive the replace at all — the identity must stay the opener —
  // so it degrades to append there.
  const existing = request.system ?? [];
  if (setting.mode === "override" && existing.length > 0) {
    return { ...request, system: [{ kind: "text", text }] };
  }
  if (carriesText(existing, text)) return request;
  return { ...request, system: [...existing, { kind: "text", text }] };
}
