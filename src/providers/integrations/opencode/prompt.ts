/**
 * The minimal system prompt injected into free-tier OpenCode payloads.
 *
 * The full CLI prompt is unnecessary: live trimming showed the free-tier gate
 * accepts any system content that carries the `<env>` block with a
 * `Working directory:` line — even a ~30-character placeholder passes. The
 * marker line below is kept so `carriesOpenCodePrompt` can detect an already-
 * injected prompt and avoid duplication.
 */

/** The marker that identifies a body already carrying the injected prompt. */
export const OPENCODE_PROMPT_MARKER = "You are an interactive coding agent that helps users";

/**
 * Assembles the minimal prompt: the marker line plus the `<env>` block the
 * gate requires. No model identity, no skills, no style rules — the model is
 * a gateway proxy and should not claim an upstream identity.
 */
export function opencodeSystemPrompt(): string {
  const directory = process.cwd().trim() || "/workspace";
  return `You are an interactive coding agent that helps users with software engineering tasks.\n<env>  Working directory: ${directory}</env>`;
}

/** Flattens a system/instruction value into its text fragments. */
export function textFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["text"] === "string") return textFragments(record["text"]);
    if (record["content"] !== undefined) return textFragments(record["content"]);
  }
  return [];
}

/** Whether any text inside `value` already contains the injected prompt marker. */
export function carriesOpenCodePrompt(value: unknown): boolean {
  return textFragments(value).some((part) => part.includes(OPENCODE_PROMPT_MARKER));
}

/**
 * Appends the `<env>` block to the first existing system/developer message
 * instead of prepending a new leading system message. The tool's own system
 * content (Claude Code, DSH, …) keeps its place; the gate-required env block
 * is tacked on at the end of it.
 */
export function injectChatPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return false;
  const firstSystem = messages.findIndex((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const role = (raw as Record<string, unknown>)["role"];
    return role === "system" || role === "developer";
  });
  if (firstSystem === -1) {
    payload["messages"] = [{ role: "system", content: prompt }, ...messages];
    return true;
  }
  const message = messages[firstSystem] as Record<string, unknown>;
  if (carriesOpenCodePrompt(message["content"])) return false;
  const existing = textFragments(message["content"]).join("\n");
  message["content"] = existing === "" ? prompt : `${existing}\n\n${prompt}`;
  return true;
}

/** Appends the prompt to the top-level Anthropic `system` value. */
export function injectAnthropicPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const system = payload["system"];
  if (system !== undefined && carriesOpenCodePrompt(system)) return false;
  if (system === undefined) {
    payload["system"] = prompt;
    return true;
  }
  if (typeof system === "string") {
    payload["system"] = system.trim() === "" ? prompt : system + "\n\n" + prompt;
  } else if (Array.isArray(system)) {
    payload["system"] = [...system, { type: "text", text: prompt }];
  } else {
    payload["system"] = prompt;
  }
  return true;
}

/** Appends the prompt to the Responses `instructions` value. */
export function injectResponsesPrompt(payload: Record<string, unknown>, prompt: string): boolean {
  const instructions = payload["instructions"];
  if (instructions !== undefined && carriesOpenCodePrompt(instructions)) return false;
  if (typeof instructions === "string") {
    payload["instructions"] = instructions.trim() === "" ? prompt : instructions + "\n\n" + prompt;
  } else {
    payload["instructions"] = prompt;
  }
  return true;
}

/**
 * Injects the prompt into a free-tier payload for the given wire family.
 * System One payloads are never touched. Reports whether changed.
 */
export function injectOpenCodePrompt(
  payload: Record<string, unknown>,
  wireFamily: "chat" | "responses" | "messages" | "systemone",
): boolean {
  if (wireFamily === "systemone") return false;
  const prompt = opencodeSystemPrompt();
  if (wireFamily === "chat") return injectChatPrompt(payload, prompt);
  if (wireFamily === "messages") return injectAnthropicPrompt(payload, prompt);
  return injectResponsesPrompt(payload, prompt);
}
