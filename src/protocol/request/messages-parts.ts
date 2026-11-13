/**
 * Canonical content-part → Claude Messages block projection.
 *
 * Owns the per-part translation rules of the Messages wire builder: image
 * normalization and clamping, file/document source projection, tool-call and
 * tool-result encoding, and reasoning/extension blocks. Request-level assembly
 * (message ordering, system hoisting, max_tokens, thinking config, tools,
 * controls, fallbacks) lives in `messages.ts`, which drives this module through
 * an explicit `ClaudePartContext`.
 */
import type { ContentPart } from "../canonical-model";
import {
  isRecord,
  normalizeAnthropicToolCallId,
  parseArguments,
  claudeToolName,
  resolveImageSource,
  splitDataUrl,
  toWellFormedDeep,
  toWellFormedString,
  type ClaudeWireObject,
  type ToolNameAlias,
} from "../codecs";
import { reasoningTextForReplay } from "../reasoning-text";
import { log } from "../../observability/logger";
import { base64DecodedByteLength, clampImage } from "../image-clamp";

/** Anthropic Messages' documented base64-image media-type allowlist. */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Anthropic `source.type` is a closed set: `base64` | `url` | `file`. */
const ANTHROPIC_SOURCE_TYPES: ReadonlySet<string> = new Set(["base64", "url", "file"]);

/** Common aliases that resolve to a supported Anthropic media type. */
const IMAGE_MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Shared mutable state threaded through one Messages request projection.
 *
 * Tool-call id normalization is stateful: the same call id must map to the
 * same normalized id across its `tool_use` and `tool_result` blocks, and ids
 * must stay unique request-wide. Image clamping needs the request-wide count.
 */
export interface ClaudePartContext {
  /** Seen tool-call ids, for id normalization dedupe. */
  seen: Map<string, number>;
  /** Original → normalized tool-call id map, shared across call/result blocks. */
  idMap: Map<string, string>;
  isOAuth: boolean;
  /** Total image blocks in the request, feeding the per-image clamp ceiling. */
  imageCount: number;
  /** Recorded sent-name ↔ original-name tool aliases, reported to the caller. */
  toolAliases: ToolNameAlias[];
  maxBytesOverride?: number;
}

/**
 * Normalizes a base64 image block's `media_type` (aliases like `jpg`→`jpeg`)
 * and validates it against Anthropic's supported set, logging — rather than
 * silently forwarding — an unsupported spelling (gap report P14).
 */
function normalizeAnthropicImageMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  const normalized = ANTHROPIC_IMAGE_MEDIA_TYPES.has(lower)
    ? lower
    : (IMAGE_MEDIA_TYPE_ALIASES[lower] ?? lower);
  if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(normalized)) {
    log.warn(
      `claude: unsupported image media_type "${mediaType}", forwarding as-is`,
      {
        media_type: mediaType,
      },
    );
    return mediaType;
  }
  return normalized;
}

/**
 * Placeholder substituted for an image block the clamp refuses to send.
 *
 * A `reject` decision means the block would be accepted and then poison every
 * retry and every later turn that replays the history. Dropping it silently
 * would leave the model answering a question whose attachment is gone, so the
 * block is replaced by visible text — the same degrade-to-placeholder shape the
 * `audio` case below uses for a part this wire cannot encode.
 */
function clampedImagePlaceholder(): ClaudeWireObject {
  return { type: "text", text: "[image omitted: over the provider size limit]" };
}

/**
 * Reads a declared pixel dimension (`width`/`height`) off an image payload.
 *
 * No wire this gateway speaks carries one — an Anthropic `source` has only
 * `type`/`media_type`/`data` and an OpenAI `image_url` only `url`/`detail` — so
 * this is a courtesy read for a client that declares it anyway. Both plausible
 * declaration sites are checked: the payload itself and its nested `source`.
 */
function declaredDimension(payload: unknown, key: "width" | "height"): number | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = payload[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const source = payload["source"];
  if (isRecord(source)) {
    const nested = source[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

/**
 * Applies the shared pre-send image clamp to an already-projected block.
 *
 * Only inline bytes are measurable here: a `url` or `file` source carries no
 * payload in this request, so it is forwarded untouched rather than refused for
 * being unmeasurable. Dimensions are honoured when the origin declared them.
 */
function applyImageClamp(
  block: ClaudeWireObject,
  imageCount: number,
  payload: unknown,
  maxBytesOverride?: number,
): ClaudeWireObject {
  const source = block["source"];
  const data = isRecord(source) ? source["data"] : undefined;
  const width = declaredDimension(payload, "width");
  const height = declaredDimension(payload, "height");
  const decision = clampImage({
    ...(typeof data === "string" ? { bytes: base64DecodedByteLength(data) } : {}),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    imageCount,
    ...(maxBytesOverride === undefined ? {} : { maxBytesOverride }),
  });
  if (decision.action === "pass") return block;
  log.warn(
    decision.action === "reject"
      ? "claude: image block over the send limit, omitted"
      : "claude: image block over the dimension limit, omitted (no re-encode in the router)",
    {
      action: decision.action,
      reason: decision.reason,
      max_dimension_px: decision.maxDimensionPx,
      max_bytes: decision.maxBytes,
      image_count: imageCount,
    },
  );
  return clampedImagePlaceholder();
}

/**
 * Projects a canonical image part onto an Anthropic `image` block.
 *
 * Anthropic's `source.type` is a closed set — `base64` | `url` | `file` — and
 * the upstream rejects anything else. A canonical image part is an opaque
 * origin payload, so it can arrive in a vocabulary that is *not* Anthropic's:
 * a Responses part carries `type: "input_image"` with a top-level `image_url`
 * string, and a Chat part carries a nested `image_url` object. Forwarding either
 * with its own `type` intact (or with no `source` at all) sends a Claude model
 * `source.type: "input_image"` — an invalid block the provider refuses.
 *
 * Every shape collapses to a valid source, preferring the cheapest
 * transport: a Files API reference, then a URL, then base64 bytes (a `data:`
 * URL is split rather than embedded, because Anthropic has no data-URL field).
 */
function normalizeImageBlock(payload: unknown): ClaudeWireObject {
  // A bare string payload (a tolerant Chat parse of `image_url: "…"`) is a URL,
  // not a source object. Anthropic has no string source, so it is projected
  // like any other origin shape instead of being passed through as `source`.
  if (!isRecord(payload)) {
    const resolved = resolveImageSource(payload);
    if (resolved?.url !== undefined) {
      const split = splitDataUrl(resolved.url);
      return {
        type: "image",
        source:
          split !== undefined
            ? { type: "base64", media_type: split.mediaType, data: split.data }
            : { type: "url", url: resolved.url },
      };
    }
    if (resolved?.fileId !== undefined) {
      return { type: "image", source: { type: "file", file_id: resolved.fileId } };
    }
    return { type: "image", source: payload };
  }
  const rawSource = isRecord(payload["source"]) ? payload["source"] : payload;
  if (!isRecord(rawSource)) return payload;

  // A `source` that is already Anthropic-shaped keeps its own fields; anything
  // else is re-projected from whichever origin vocabulary it arrived in.
  const sourceIsAnthropic = ANTHROPIC_SOURCE_TYPES.has(String(rawSource["type"]));
  const source: Record<string, unknown> = sourceIsAnthropic ? { ...rawSource } : {};
  // A `url` source carrying a data URI is not a URL: the bytes are in the
  // string. Leaving it as `type: "url"` hands the upstream a data URI in a
  // file-uri field, which it cannot fetch — so the image is lost while the
  // request still succeeds. Split it into the base64 source it actually is.
  if (sourceIsAnthropic && source["type"] === "url" && typeof source["url"] === "string") {
    const split = splitDataUrl(source["url"]);
    if (split !== undefined) {
      source["type"] = "base64";
      source["media_type"] = split.mediaType;
      source["data"] = split.data;
      delete source["url"];
    }
  }
  if (!sourceIsAnthropic) {
    const fileId = rawSource["file_id"];
    // A nested `image_url` (Chat) may itself be a string or `{url}`.
    const nested = rawSource["image_url"];
    const nestedUrl = isRecord(nested) ? nested["url"] : nested;
    const url = typeof nestedUrl === "string" ? nestedUrl : rawSource["url"];
    const inlineData = rawSource["data"];
    if (typeof fileId === "string") {
      source["type"] = "file";
      source["file_id"] = fileId;
    } else if (typeof url === "string") {
      const split = splitDataUrl(url);
      if (split !== undefined) {
        source["type"] = "base64";
        source["media_type"] = split.mediaType;
        source["data"] = split.data;
      } else {
        source["type"] = "url";
        source["url"] = url;
      }
    } else if (typeof inlineData === "string") {
      source["type"] = "base64";
      source["media_type"] = typeof rawSource["media_type"] === "string" ? rawSource["media_type"] : "image/png";
      source["data"] = inlineData;
    }
    // `detail` is an OpenAI hint with no Anthropic equivalent; it is dropped
    // rather than forwarded, since the upstream rejects unknown source fields.
  }
  if (typeof source["media_type"] === "string") {
    source["media_type"] = normalizeAnthropicImageMediaType(source["media_type"]);
  }
  // A source still lacking a valid discriminator cannot be repaired into one;
  // preserve the origin payload rather than fabricating a transport.
  if (!ANTHROPIC_SOURCE_TYPES.has(String(source["type"]))) {
    return rawSource === payload ? { type: "image", source } : { ...payload, source };
  }
  return rawSource === payload
    ? { type: "image", source }
    : { ...payload, source };
}

/**
 * Projects a canonical file part onto Anthropic's `document.source`, preferring
 * the Files API reference over an inlined base64 payload so a replayed
 * `file_id` is not re-uploaded as bytes.
 */
function anthropicFileSource(part: Extract<ContentPart, { kind: "file" }>): ClaudeWireObject {
  if (part.file_id !== undefined) return { type: "file", file_id: part.file_id };
  if (
    part.url !== undefined &&
    (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
  ) {
    return { type: "url", url: part.url };
  }
  return { type: "base64", media_type: part.media_type, data: part.data };
}

/** Projects a canonical document part onto Anthropic's `document.source`. */
function anthropicDocumentSource(
  part: Extract<ContentPart, { kind: "document" }>,
): ClaudeWireObject {
  if (part.source_type === "url" && part.url !== undefined) return { type: "url", url: part.url };
  if (part.source_type === "file" && part.file_id !== undefined)
    return { type: "file", file_id: part.file_id };
  if (part.source_type === "text")
    return { type: "text", media_type: part.media_type, data: part.data };
  return { type: "base64", media_type: part.media_type, data: part.data };
}

export function partToClaudeBlock(
  part: ContentPart,
  ctx?: ClaudePartContext,
): ClaudeWireObject | undefined {
  switch (part.kind) {
    case "text":
      return { type: "text", text: toWellFormedString(part.text) };
    case "image":
      return applyImageClamp(
        normalizeImageBlock(part.payload),
        ctx?.imageCount ?? 1,
        part.payload,
        ctx?.maxBytesOverride,
      );
    case "file":
      return {
        type: "document",
        source: anthropicFileSource(part),
        ...(part.filename === undefined ? {} : { title: part.filename }),
      };
    case "document":
      return {
        type: "document",
        source: anthropicDocumentSource(part),
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.citations === undefined ? {} : { citations: { enabled: part.citations } }),
      };
    case "audio":
      // The Messages wire defines no audio content block, so there is nothing
      // to encode here — see `AUDIO_CAPABLE_WIRE_FAMILIES`, which denies audio
      // to this wire so the request degrades before it reaches this builder.
      // Emitting the part anyway would put an undefined block type on the wire
      // and fail the whole request; degrade to the same visible placeholder the
      // capability path uses, so an unexpected part loses only the attachment.
      return { type: "text", text: "[audio]" };
    case "refusal":
      return { type: "text", text: toWellFormedString(part.text) };
    case "toolCall": {
      const seen = ctx?.seen ?? new Map<string, number>();
      const idMap = ctx?.idMap ?? new Map<string, string>();
      const normalized = normalizeAnthropicToolCallId(part.call_id, seen);
      idMap.set(part.call_id, normalized);
      // No `index`. It is a streaming field — the position of a `tool_use`
      // delta inside an SSE stream — and the Messages request schema has no
      // such key: Anthropic rejects the whole body with
      // `messages.N.content.0.tool_use.index: Extra inputs are not permitted`.
      // A canonical `toolCall` carries one because the Chat/Responses parsers
      // stamp every call with its array position, so copying it here leaked a
      // stream-only field into a request. The position is not lost: the block
      // order in `content[]` already expresses it.
      const sentName = claudeToolName(part.name, ctx?.isOAuth ?? false);
      if (sentName !== part.name) ctx?.toolAliases.push({ sent: sentName, original: part.name });
      return {
        type: "tool_use",
        id: normalized,
        name: sentName,
        input: toWellFormedDeep(parseArguments(part.arguments)),
        ...(part.namespace === undefined ? {} : { namespace: part.namespace }),
      };
    }
    case "toolResult": {
      const seen = ctx?.seen;
      const idMap = ctx?.idMap;
      let normalizedId = part.call_id;
      if (idMap?.has(part.call_id)) {
        normalizedId = idMap.get(part.call_id) as string;
      } else if (seen) {
        normalizedId = normalizeAnthropicToolCallId(part.call_id, seen);
        idMap?.set(part.call_id, normalizedId);
      } else {
        normalizedId = normalizeAnthropicToolCallId(part.call_id);
      }
      const content =
        typeof part.content === "string"
          ? toWellFormedString(part.content)
          : part.content.flatMap((p) => {
              const block = partToClaudeBlock(p, ctx);
              return block === undefined ? [] : [block];
            });
      return {
        type: "tool_result",
        tool_use_id: normalizedId,
        content,
        ...(part.is_error === true ? { is_error: true } : {}),
      };
    }
    case "reasoning":
      if (
        !part.opaque &&
        (typeof part.signature !== "string" || part.signature.trim().length === 0)
      ) {
        const text = reasoningTextForReplay(part) ?? "";
        return text.length > 0 ? { type: "text", text: toWellFormedString(text) } : undefined;
      }
      if (part.opaque) {
        return isRecord(part.payload)
          ? (toWellFormedDeep(part.payload) as ClaudeWireObject)
          : { type: "redacted_thinking", data: toWellFormedDeep(part.payload) };
      }
      return {
        type: "thinking",
        thinking: toWellFormedString(reasoningTextForReplay(part) ?? ""),
        ...(part.signature === undefined
          ? {}
          : { signature: toWellFormedString(part.signature) }),
      };
    case "extension": {
      // Only Messages-native extensions survive onto the Anthropic wire:
      // server blocks pass through verbatim and `messages:*` types strip to
      // their native block shape. Foreign-surface annotations
      // (`responses:*`, chat `audio`/obfuscation, `unknown`) have no Messages
      // representation — forwarding them would draw an upstream 400 for an
      // unknown block type. The Chat/Responses request builders degrade
      // extensions away the same way, so this matches house convention.
      if (!isRecord(part.payload)) return undefined;
      if (
        part.name === "server_tool_use" ||
        part.name === "search_result" ||
        part.name === "web_search_tool_result" ||
        part.name === "document" ||
        (part.name.startsWith("messages:") && part.name !== "messages:unknown")
      )
        return toWellFormedDeep(part.payload) as ClaudeWireObject;
      return undefined;
    }
  }
}
