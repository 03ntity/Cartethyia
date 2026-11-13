// Vision-handoff request rewriting: turn a request whose images were described
// by a vision model into a text-only request the main model can carry. Pure
// request shaping — no dependency on routing or admission.
import type { CanonicalRequest, CanonicalMessage, ContentPart } from "../../protocol/canonical-model";
import { isImageOrPlaceholderPart, lastImageCarryingUserTurnIndex } from "../vision-handoff";

/**
 * The text that replaces an image part after a successful vision handoff.
 * The description is wrapped so the receiving model understands it is an
 * automated description of an image the user attached — not prose the user
 * typed — which is what made it answer as if it had no image at all.
 */
function visionDescriptionText(description: string): string {
  return `[The user attached an image. A vision model described it for you: ${description}]`;
}

/**
 * Replaces every image part (or its `[image]` degradation placeholder) in the
 * request with a single text part carrying the vision-handoff description.
 * Returns `null` when the request has neither image parts nor placeholders.
 * Only user-message parts are replaced; system/tool-result images are left
 * untouched.
 */
export function replaceImagePartsWithText(
  request: CanonicalRequest,
  description: string,
): CanonicalRequest | null {
  const activeIndex = lastImageCarryingUserTurnIndex(request);
  const strip = (parts: readonly ContentPart[]): readonly ContentPart[] => {
    const hasImage = parts.some(isImageOrPlaceholderPart);
    if (!hasImage) return parts;
    return parts.flatMap((part): ContentPart[] =>
      isImageOrPlaceholderPart(part)
        ? [{ kind: "text", text: visionDescriptionText(description) }]
        : [part],
    );
  };
  const nextMessages = request.messages.map((message, i) => {
    if (message.role !== "user") return message;
    // The active turn (the one the handoff actually described) gets the
    // description; older image-carrying history turns are dropped — they are
    // not part of the current context the vision model saw, and leaving a
    // stale image on a text-only route would risk an upstream rejection.
    if (i === activeIndex) {
      return { ...message, content: strip(message.content) };
    }
    const hasImage = message.content.some(isImageOrPlaceholderPart);
    if (!hasImage) return message;
    // Never delete images silently (proposal Option E): replace a dropped
    // older image with a marker so the main model at least knows something
    // was there, instead of the loss being invisible.
    return {
      ...message,
      content: message.content.flatMap((part) =>
        isImageOrPlaceholderPart(part)
          ? [{ kind: "text" as const, text: "[image omitted]" }]
          : [part],
      ),
    };
  });
  const unchangedMessages = nextMessages.every(
    (message, i) => message === request.messages[i],
  );
  if (unchangedMessages) return null;
  return { ...request, messages: nextMessages };
}

/**
 * When a handoff request is a giant session (opencode CLI sessions routinely
 * carry hundreds of tool-result turns), the text-only request that goes to the
 * main model is still enormous: the handoff only replaced the image parts, so
 * the full history — including 700+ tool transcripts — is forwarded verbatim.
 * Upstreams reject or reset such payloads (502/ECONNRESET), which is the
 * "broken on large sessions" report: a small fresh chat works, a session with
 * a large context dies even though the handoff itself is just a description.
 *
 * The handoff describes *an image the user just attached* — it does not need
 * the rest of the session. For a giant request this pass returns only the
 * system prompt (when present) plus the active image-carrying turn; the whole
 * history is dropped so the payload stays small and upstreams do not reset it.
 * Small requests (< the thresholds) pass through untouched.
 */
export function condenseHandoffRequest(request: CanonicalRequest): CanonicalRequest {
  const activeIndex = lastImageCarryingUserTurnIndex(request);
  if (activeIndex < 0) return request;

  const totalMessages = request.messages.length;
  let totalChars = 0;
  for (const message of request.messages) totalChars += messageCharSize(message);
  if (totalMessages <= HANDOFF_CONDENSE_MESSAGE_THRESHOLD && totalChars <= HANDOFF_CONDENSE_CHARS_THRESHOLD) {
    return request;
  }

  const kept: CanonicalMessage[] = [];
  for (let i = 0; i < request.messages.length; i += 1) {
    const message = request.messages[i]!;
    if (message.role === "system") {
      kept.push(message);
      continue;
    }
    if (i === activeIndex) {
      kept.push(message);
      // Anything after the active turn stays after it (rare, but preserved).
      kept.push(...request.messages.slice(activeIndex + 1));
      break;
    }
  }
  // Never return a request that lost the very turn we are answering.
  if (!kept.includes(request.messages[activeIndex]!)) return request;
  return { ...request, messages: kept };
}

const HANDOFF_CONDENSE_MESSAGE_THRESHOLD = 100;
const HANDOFF_CONDENSE_CHARS_THRESHOLD = 200_000;

function messageCharSize(message: CanonicalMessage): number {
  let size = 0;
  for (const part of message.content) {
    if (part.kind === "text" || part.kind === "refusal") {
      size += part.text.length;
    } else if (part.kind === "toolCall") {
      size += part.name.length;
      try {
        size += JSON.stringify(part.arguments).length;
      } catch {
        size += 64;
      }
    } else {
      try {
        size += JSON.stringify((part as { data?: unknown }).data ?? "").length;
      } catch {
        size += 64;
      }
    }
  }
  return size;
}
