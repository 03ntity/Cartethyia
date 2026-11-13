/**
 * Message-envelope tail shared by the buddy family providers (CodeBuddy
 * International `cb` and CodeBuddy CN `cbcn`).
 *
 * Everything here operates on the Chat-wire `messages` array after the
 * payload-level rules in `chat.ts` have run: merging adjacent same-role turns,
 * dropping turns the upstream rejects, guaranteeing the leading system turn,
 * omitting content on tool-call-only assistant turns, and auto-marking
 * cacheable text with ephemeral `cache_control`.
 *
 * Split out of `chat.ts`; `chat.ts` re-exports the public entry points so
 * importers keep their existing module path.
 */
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { isRecord } from "../../../protocol/codecs";

/** Normalizes one message's content into a Chat-wire content-part array. */
function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string")
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === "object",
  );
}

/**
 * Coalesces consecutive `user` messages into one, preserving content-part
 * order. The buddy upstream merges consecutive same-role turns itself and
 * drops `image_url` parts while doing so, so an attachment delivered as its
 * own user turn (the shape VS Code Copilot emits for a pasted screenshot)
 * reaches the model as text only — the image is silently gone even though the
 * gateway forwarded it. Merging here keeps every image in the same message as
 * the text the caller sent alongside it.
 *
 * Lossless: only adjacent same-role `user` turns merge, and every part is
 * retained in order. Assistant/tool/system turns are untouched.
 */
export function coalesceConsecutiveUserMessages(messages: Array<Record<string, unknown>>): void {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (message["role"] !== "user" || previous?.["role"] !== "user") {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      content: [...contentParts(previous["content"]), ...contentParts(message["content"])],
    };
  }
  messages.length = 0;
  messages.push(...out);
}

/**
 * Responses input can split one assistant turn into several adjacent items
 * (text, reasoning, and parallel function calls). Chat wire needs a single
 * assistant message so the reasoning trace accompanies every call in the
 * batch; tool results or user turns always end the batch.
 */
export function coalesceConsecutiveAssistantMessages(messages: Array<Record<string, unknown>>): void {
  let write = 0;
  for (const message of messages) {
    const previous = messages[write - 1];
    if (message["role"] !== "assistant" || previous?.["role"] !== "assistant") {
      messages[write++] = message;
      continue;
    }
    const firstContent = previous["content"];
    const nextContent = message["content"];
    let content: unknown = firstContent ?? nextContent;
    if (firstContent != null && nextContent != null) {
      if (typeof firstContent === "string" && typeof nextContent === "string") {
        if (firstContent.length === 0) content = nextContent;
        else if (nextContent.length === 0) content = firstContent;
        else content = `${firstContent}\n${nextContent}`;
      } else content = [...contentParts(firstContent), ...contentParts(nextContent)];
    }
    const firstCalls = previous["tool_calls"];
    const nextCalls = message["tool_calls"];
    const firstReasoning = previous["reasoning_content"];
    const nextReasoning = message["reasoning_content"];
    const merged: Record<string, unknown> = { ...previous, ...message, content };
    if (Array.isArray(firstCalls) || Array.isArray(nextCalls))
      merged["tool_calls"] = [
        ...(Array.isArray(firstCalls) ? firstCalls : []),
        ...(Array.isArray(nextCalls) ? nextCalls : []),
      ];
    if (typeof firstReasoning === "string" && typeof nextReasoning === "string") {
      if (firstReasoning.length === 0) merged["reasoning_content"] = nextReasoning;
      else if (nextReasoning.length === 0) merged["reasoning_content"] = firstReasoning;
      else merged["reasoning_content"] = `${firstReasoning}\n${nextReasoning}`;
    } else if (typeof firstReasoning === "string" || typeof nextReasoning === "string") {
      merged["reasoning_content"] = firstReasoning ?? nextReasoning;
    }
    messages[write - 1] = merged;
  }
  messages.length = write;
}

/**
 * Drops messages whose content is empty, mirroring the buddy upstream's own
 * validation (empty-content turns are rejected with code `11151`). Guarded:
 * anything carrying tool calls, tool results, or reasoning is kept — an
 * assistant `tool_calls` turn with null content and a ledger-folded result
 * text are both load-bearing, not empty.
 */
export function dropEmptyBuddyMessages(messages: Array<Record<string, unknown>>): void {
  const kept = messages.filter((message) => {
    if (!isRecord(message)) return true;
    if (Array.isArray(message["tool_calls"]) && message["tool_calls"].length > 0) return true;
    if (typeof message["tool_call_id"] === "string" && message["tool_call_id"].trim().length > 0)
      return true;
    const content = message["content"];
    if (typeof content === "string") {
      if (content.trim().length > 0) return true;
      // `content === ""` on a bare assistant turn (no tool_calls, no
      // tool_call_id) is unverifiable by the receiving model regardless of
      // what `reasoning_content` carries. The upstream rejects it with
      // code `11151 "history not found"` for both shapes observed in the
      // wild:
      //   (a) `reasoning_content: ""` — the Chat encoder's output for a
      //       canonical `reasoning` part with no `.summary` and a non-string
      //       `.payload` (signature-less thinking block already stripped on
      //       an earlier hop), and
      //   (b) `reasoning_content: "reasoning unavailable"` — the OMP client's
      //       sentinel in a Responses `reasoning` input item of shape
      //       `{summary: [], content: [{type: "reasoning_text",
      //       text: "reasoning unavailable"}]}`, emitted when the client
      //       strips the previous turn's trace on a model switch.
      // Both are unverifiable: the receiving model never issued that
      // signature, so nothing is round-trippable. Verifiable signatures
      // round-trip on `tool_calls` turns (kept by the guard above) via the
      // `reasoning_content` side channel; a signature on a bare turn with
      // no tool_calls is not a shape any upstream in this family accepts.
      return false;
    }
    if (Array.isArray(content)) return content.length > 0;
    // Null content with no tool/reasoning load is a bare turn the upstream
    // rejects — drop it rather than dispatch a known-invalid payload.
    return false;
  });
  if (kept.length === messages.length) return;
  messages.length = 0;
  messages.push(...kept);
}

/**
 * Guarantees the wire opens with a `system` turn. The buddy upstream rejects a
 * first message that is not a system prompt (code `11128`), and a CN-neutralized
 * or caller-less history can otherwise arrive with a bare `user` turn first.
 * Non-empty by construction: an empty system turn trips the sibling `11151`
 * validation above, so the placeholder carries real content.
 */
export function ensureBuddyLeadingSystem(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
): void {
  if (messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
    return;
  }
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") return;
  messages.unshift({ role: "system", content: systemPrompt });
}

/**
 * Longest message text that gets an automatic ephemeral prompt-cache marker,
 * mirroring the reference gateway (`MIN_AUTO_CACHE_TEXT_LENGTH`).
 */
const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;

/**
 * Marks one message's text content cacheable in place: the system turn and the
 * last user turn are the long, stable ones a prefix cache serves best. A
 * string message becomes a typed text block; a text part inside an array gets
 * `cache_control: {type: "ephemeral"}`. Only the first qualifying text part of
 * a message is marked, like the reference.
 */
function markCacheableTextContent(message: Record<string, unknown>): void {
  const content = message["content"];
  if (typeof content === "string") {
    if (content.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH) {
      message["content"] = [
        { type: "text", text: content, cache_control: { type: "ephemeral" } },
      ];
    }
    return;
  }
  if (!Array.isArray(content)) return;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (!isRecord(part) || part["type"] !== "text") continue;
    const text = typeof part["text"] === "string" ? part["text"] : "";
    if (text.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH && part["cache_control"] === undefined) {
      content[index] = { ...part, cache_control: { type: "ephemeral" } };
      return;
    }
  }
}

/**
 * Auto-injects ephemeral prompt-cache markers on the system turn and the last
 * user turn when the caller declared none. Mirrors `applyPromptCacheControl` in
 * the reference gateway: an explicit `cache_control` anywhere is respected and
 * disables the auto-pass so the caller's own caching strategy wins.
 */
export function applyBuddyAutoPromptCache(messages: Array<Record<string, unknown>>): void {
  const hasExplicit = messages.some((message) =>
    Array.isArray(message["content"]) &&
    (message["content"] as Array<Record<string, unknown>>).some(
      (part) => isRecord(part) && part["cache_control"] !== undefined,
    ),
  );
  if (hasExplicit) return;
  if (messages.length === 0) return;
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") markCacheableTextContent(first);
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRecord(messages[index]) && messages[index]!["role"] === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser >= 0) markCacheableTextContent(messages[lastUser]!);
}

/**
 * Strips the `content` key from assistant tool_calls-only turns.
 *
 * Mirrors the reference gateway's OpenAI transcript: an assistant turn that
 * only asks for tools carries `tool_calls` and no content at all (Go's
 * `omitzero`-style SDKs omit the key rather than send `null`/`""`). Keeping
 * an empty string content invites the upstream to fall back to its prose/DSML
 * channel; omitting the key keeps it on the structured `tool_calls` channel.
 */
export function omitBuddyAssistantToolCallContent(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const calls = message["tool_calls"];
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const content = message["content"];
    if (typeof content === "string" && content.trim().length === 0) {
      delete message["content"];
    } else if (Array.isArray(content) && content.length === 0) {
      delete message["content"];
    }
  }
}

/**
 * Forwards the caller's parallel tool-call intent onto the buddy wire.
 *
 * The canonical control is `generation_controls.parallel_tool_calls`; the
 * reference gateway always passes it through so upstream keeps the structured
 * tool channel, and the same is applied here.
 */
export function injectBuddyParallelToolCalls(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
): void {
  const parallel = request.generation_controls?.parallel_tool_calls;
  if (parallel !== undefined) payload["parallel_tool_calls"] = parallel;
}

export interface BuddyMessageFinalizeOptions {
  /** The fixed leading system prompt installed on the wire. */
  readonly leadPrompt: string;
  /** Coalesce consecutive user turns (default true). */
  readonly coalesceConsecutiveUser?: boolean;
  /** Drop empty-content turns the upstream rejects (default true). */
  readonly dropEmpty?: boolean;
  /** Guarantee the wire opens with a system turn (default true). */
  readonly ensureLeadingSystem?: boolean;
  /** Omit content on assistant tool_calls-only turns (default true). */
  readonly omitToolCallContent?: boolean;
  /** Auto-inject ephemeral prompt-cache markers (default true). */
  readonly autoPromptCache?: boolean;
}

/**
 * The single authoritative buddy message-shape pipeline. Every variant runs
 * the same sequence — coalesce, drop empty turns, guarantee the leading system
 * turn, omit content on tool_calls-only assistant turns, then auto-cache — so
 * the wire shape cannot drift between CodeBuddy intl and CN.
 */
export function finalizeBuddyMessages(
  messages: Array<Record<string, unknown>>,
  options: BuddyMessageFinalizeOptions,
): void {
  if (options.coalesceConsecutiveUser !== false) {
    coalesceConsecutiveUserMessages(messages);
  }
  if (options.dropEmpty !== false) {
    dropEmptyBuddyMessages(messages);
  }
  if (options.ensureLeadingSystem !== false) {
    ensureBuddyLeadingSystem(messages, options.leadPrompt);
  }
  if (options.omitToolCallContent !== false) {
    omitBuddyAssistantToolCallContent(messages);
  }
  if (options.autoPromptCache !== false) {
    applyBuddyAutoPromptCache(messages);
  }
}
