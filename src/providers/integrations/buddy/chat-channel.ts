/**
 * DeepSeek Harness (DSH) channel-identity scrub for the buddy family.
 *
 * DSH is the harness behind the buddy family; a history that still carries its
 * self-description reads to the upstream as a foreign channel, so the hardened
 * client rewrites it back to the CodeBuddy identity rather than forwarding a
 * competing one.
 *
 * Split out of `chat.ts`; `chat.ts` re-exports the public entry points so
 * importers keep their existing module path.
 */
import { isRecord } from "../../../protocol/codecs";

const BUDDY_ZWSP = "\\u200b";

function escapeBuddyRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a matcher that tolerates the zero-width spaces upstream interleaves
 * between characters, so an identity template is still recognized after a
 * normalizer has split it apart.
 */
function buddyTemplateSource(text: string): string {
  const words = text
    .split(" ")
    .map((word) => [...word].map(escapeBuddyRegexLiteral).join(`${BUDDY_ZWSP}*`));
  return words.join(`[\\s${BUDDY_ZWSP}]+`) + `${BUDDY_ZWSP}*`;
}

function buddyTemplatePattern(text: string): RegExp {
  return new RegExp(`(?<!\\w)${buddyTemplateSource(text)}(?!\\w)`, "i");
}

// DeepSeek Harness (DSH) role identities. DSH is the harness behind the buddy
// family; a history that still carries its self-description reads to the
// upstream as a foreign channel, so the hardened client rewrites it back to
// the CodeBuddy identity rather than forwarding a competing one.
const DSH_CODING_PATTERN = new RegExp(
  `(?<!\\w)${buddyTemplateSource("You are a coding agent powered by the")}` +
    `[\\s${BUDDY_ZWSP}]+([^\\r\\n]{1,200}?)[\\s${BUDDY_ZWSP}]+` +
    `${buddyTemplateSource("model")}(?!\\w)`,
  "i",
);
const DSH_CHANNEL_IDENTITY_PATTERN = buddyTemplatePattern(
  "You are an AI agent powered by DeepSeek Harness",
);
const DSH_MINIMAL_PATTERN = buddyTemplatePattern("You are a helpful software engineer assistant");
const DSH_DIRECT_PATTERN = buddyTemplatePattern("You are DeepSeek Harness");
const DSH_WEB_GUI_PATTERN = buddyTemplatePattern("DeepSeek Harness Web GUI");

/** The identity DSH role prompts are rewritten to; neutral and minimal. */
const DSH_CODEBUDDY_IDENTITY = "You are a helpful assistant";

/**
 * Rewrites DeepSeek Harness role identities in one message's text back to the
 * CodeBuddy identity. Port of the donor gateway's always-on
 * `desensitize_channel_body`, scoped to text the wire actually carries.
 *
 * This normalizes a replayed history (or a surviving system turn) that still
 * claims the DSH harness, so a buddy request never advertises a competing
 * channel identity upstream. The coding persona keeps the model it named:
 * "You are a coding agent powered by the X model" becomes the CodeBuddy
 * identity plus "powered by the X model".
 */
export function scrubBuddyChannelIdentityText(text: string): string {
  if (!text) return text;
  const withCodingPersona = text.replace(
    DSH_CODING_PATTERN,
    (_match, model: string) =>
      `${DSH_CODEBUDDY_IDENTITY}. This conversation is powered by the ${model.trim()} model`,
  );
  return withCodingPersona
    .replace(DSH_CHANNEL_IDENTITY_PATTERN, DSH_CODEBUDDY_IDENTITY)
    .replace(DSH_MINIMAL_PATTERN, DSH_CODEBUDDY_IDENTITY)
    .replace(DSH_DIRECT_PATTERN, DSH_CODEBUDDY_IDENTITY)
    .replace(DSH_WEB_GUI_PATTERN, "CodeBuddy Web GUI");
}

function scrubBuddyMessageText(message: Record<string, unknown>, field: string): void {
  const value = message[field];
  if (typeof value === "string") {
    const scrubbed = scrubBuddyChannelIdentityText(value);
    if (scrubbed !== value) message[field] = scrubbed;
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!isRecord(part)) continue;
    const text = part["text"];
    if (typeof text === "string") {
      const scrubbed = scrubBuddyChannelIdentityText(text);
      if (scrubbed !== text) part["text"] = scrubbed;
    }
  }
}

/**
 * Applies the DSH identity scrub across a buddy conversation: every
 * `system`/`developer`/`assistant` turn's text and `reasoning_content` is
 * normalized, so a replayed harness history cannot carry a competing channel
 * identity upstream.
 */
export function scrubBuddyChannelIdentity(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = message["role"];
    if (role !== "system" && role !== "developer" && role !== "assistant") continue;
    scrubBuddyMessageText(message, "content");
    scrubBuddyMessageText(message, "reasoning_content");
  }
}
