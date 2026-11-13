/**
 * Antigravity agent-envelope construction: wraps the shared Gemini payload in
 * the Antigravity agent envelope and stamps the session/telemetry fields.
 *
 * Split out of `antigravity.ts`, which re-exports `buildAntigravityEnvelope`
 * so no importer changes. `ANTIGRAVITY_SYSTEM_INSTRUCTION` and
 * `ANTIGRAVITY_FORCED_TOOL_DIRECTIVE` are internal constants used only here.
 */
import { randomUUID } from "node:crypto";
import { buildGeminiPayload } from "../../../protocol/request/gemini";
import { isRecord } from "../../../protocol/codecs";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { log } from "../../../observability/logger";
import {
  antigravityThinkingBudget,
  applySkipThoughtSignatureBypass,
  dropAntigravityUnsignedReasoning,
  getAntigravityModelWireProfile,
  normalizeAntigravityToolSchemas,
} from "./antigravity-protocol";
import {
  signedAntigravitySessionId,
  type AntigravitySessionState,
} from "./antigravity-session";

// Original reference instruction (captured from the Antigravity client):
//   "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**"
// Generalized to a neutral identity so the gateway does not impersonate the
// vendor's branded assistant. The brand-specific wording is kept above for
// reference; re-enable it if an upstream behavior ever depends on it.
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are a helpful assistant.";

/**
 * Restatement appended as a trailing user turn when a Gemini route carries a
 * forced tool choice. The backend drops `toolConfig` on Gemini routes (answers
 * in text under `mode: "ANY"`, still emits calls under `"NONE"`), so without
 * the restatement `tool_choice=required` silently degrades to free text.
 *
 * UNCONFIRMED: the reference ships its directive text from an external file
 * (`google-antigravity-forced-tool.md`, a 1-line "TOOL-ONLY TURN" stub at the
 * compared commit) — no captured body shows the real wording. This constant is
 * the explicit seam to confirm from live replay; the log line in
 * `buildAntigravityEnvelope` marks every send for that comparison.
 */
const ANTIGRAVITY_FORCED_TOOL_DIRECTIVE =
  "TOOL-ONLY TURN. Call exactly one available tool now. Do not emit any text before or after the call.";

/**
 * Wraps the shared Gemini payload in the Antigravity agent envelope.
 * Antigravity's `daily-cloudcode-pa` exposes the fixed
 * `v1internal:streamGenerateContent` / `v1internal:generateContent` RPC
 * (no per-model URL path): the resolved wire model id travels here as the
 * envelope `model`, while the Gemini `contents`/`tools`/`generationConfig`
 * ride inside `request` with Antigravity's `labels` telemetry.
 */
export function buildAntigravityEnvelope(
  request: CanonicalRequest,
  projectId: string | undefined,
  wireModelId: string,
  logicalModelId: string,
  state: AntigravitySessionState,
  sessionSeed: string,
): Record<string, unknown> {
  // Tools first: a declaration whose real schema is nested under
  // `parametersJsonSchema` (the spelling Cloud Code Assist sends) must be
  // unwrapped *before* the shared Gemini builder, whose sanitizer has no entry
  // for that key and would drop both the wrapper and the schema inside it —
  // the tool would ship as `{"type":"object"}` with every property gone.
  // Rewriting after the payload is built leaves nothing to recover.
  //
  // Claude routes also drop replayed reasoning without a signature (donor
  // `drop-unsigned-thinking`): upstream rejects an unsigned `thinking` part
  // with 400 `messages.N.content.0.thinking.signature: Field required`.
  const isClaudeRoute = logicalModelId.toLowerCase().includes("claude");
  const geminiPayload = buildGeminiPayload(
    normalizeAntigravityToolSchemas(
      dropAntigravityUnsignedReasoning(request, isClaudeRoute),
    ),
  );
  const profile = getAntigravityModelWireProfile(wireModelId);

  const generationConfig = isRecord(geminiPayload["generationConfig"])
    ? (geminiPayload["generationConfig"] as Record<string, unknown>)
    : {};
  if (profile) {
    generationConfig["maxOutputTokens"] = profile.maxOutputTokens;
  }
  const budget = antigravityThinkingBudget(logicalModelId);
  if (budget !== undefined) {
    generationConfig["thinkingConfig"] = { includeThoughts: true, thinkingBudget: budget };
  }

  state.agentId ??= randomUUID();
  state.trajectoryId ??= randomUUID();
  state.sessionId ??= signedAntigravitySessionId(sessionSeed);
  state.stepIndex = (state.stepIndex ?? 1) + 1;
  const step = state.stepIndex;

  const labels: Record<string, string> = {
    ...(state.lastExecutionId ? { last_execution_id: state.lastExecutionId } : {}),
    trajectory_id: state.trajectoryId,
    last_step_index: String(step - 1),
    used_claude: profile?.usageLabel ?? String(logicalModelId.includes("claude")),
    used_claude_conservative: profile?.usageLabel ?? String(logicalModelId.includes("claude")),
  };
  if (profile?.modelEnum) {
    labels["model_enum"] = profile.modelEnum;
  }

  const existingContents = Array.isArray(geminiPayload["contents"])
    ? (geminiPayload["contents"] as Record<string, unknown>[])
    : [];
  // Forced choice on Gemini routes: the backend drops `toolConfig` here, so a
  // canonical `tool_choice=required` with no declared change is restated as a
  // trailing user directive (reference behavior). Claude routes implement
  // VALIDATED natively and are left untouched.
  if (
    !isClaudeRoute &&
    (request.tool_choice === "required" ||
      (typeof request.tool_choice === "object" &&
        request.tool_choice !== null &&
        request.tool_choice.type !== undefined)) &&
    existingContents.length > 0
  ) {
    existingContents.push({
      role: "user",
      parts: [{ text: ANTIGRAVITY_FORCED_TOOL_DIRECTIVE }],
    });
    log.info("antigravity: forced tool choice restated for Gemini route", {
      model: wireModelId,
    });
  }
  const injectIdentity =
    logicalModelId.toLowerCase().includes("claude") || logicalModelId.toLowerCase().includes("gemini-3");
  // Identity rides the dedicated systemInstruction field (captured shape),
  // never a fake user turn: a fabricated history turn pollutes multi-turn
  // context, while systemInstruction stays out of the conversation.
  const existingInstruction = isRecord(geminiPayload["systemInstruction"])
    ? (geminiPayload["systemInstruction"] as Record<string, unknown>)
    : undefined;
  const existingParts = Array.isArray(existingInstruction?.["parts"])
    ? (existingInstruction?.["parts"] as Record<string, unknown>[])
    : [];
  const hasIdentity = existingParts.some(
    (part) => isRecord(part) && part["text"] === ANTIGRAVITY_SYSTEM_INSTRUCTION,
  );
  const systemInstruction =
    !injectIdentity || hasIdentity
      ? existingInstruction
      : {
          role: "user",
          parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
        };

  const requestPayload: Record<string, unknown> = {
    ...geminiPayload,
    contents: existingContents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    labels,
    sessionId: state.sessionId,
    ...(Object.keys(generationConfig).length > 0
      ? { generationConfig }
      : {}),
  };
  // No built-in tools on this route. A `googleSearch` entry alongside
  // `functionDeclarations` is refused with
  // `400 ... enable tool_config.include_server_side_tool_invocations to use
  // Built-in tools with Function calling`, and the reference client never
  // sends one: web search reaches Antigravity as an ordinary function tool.
  // Injecting it was the only reason that refusal ever appeared here.
  if (logicalModelId.includes("claude") && !isRecord(requestPayload["toolConfig"])) {
    requestPayload["toolConfig"] = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  // Gemini default is left unset: the shared Gemini builder owns toolConfig
  // on this path, and stamping VALIDATED here would overwrite a caller choice
  // the envelope cannot see. Only the forced-choice restatement above runs on
  // the Gemini path.
  applySkipThoughtSignatureBypass(requestPayload, logicalModelId);

  const envelope: Record<string, unknown> = {
    requestId: `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${step}`,
    model: wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    request: requestPayload,
  };
  if (projectId) {
    envelope["project"] = projectId;
  }
  return envelope;
}
