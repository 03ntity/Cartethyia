/**
 * Splits inline thinking tags in the Xiaomi MiMo Studio SSE stream.
 *
 * Studio interleaves `<think>` or `<thinking>` spans with answer text and
 * NUL padding. Desktop uses the separate `reasoning_content` chat field,
 * so its standard OpenAI-compatible stream decoder does not use this splitter.
 *
 * The splitter is stateful because a tag can straddle two SSE frames: the
 * `<thi` of one chunk and the `nk>` of the next are one opening tag, and a
 * stateless regex would emit the fragment as text. It therefore holds back a
 * trailing run that could still become a tag until the next chunk settles it.
 *
 * Two further quirks are handled here rather than at each call site:
 * - NUL bytes (`\u0000`) are injected by the upstream between thought tokens;
 *   forwarded verbatim they break JSON encoders and terminal renderers.
 * - Text before an opening tag is the answer (some models answer first and
 *   reason afterwards), so it stays content; only the enclosed span becomes
 *   reasoning.
 */

/** Tags whose enclosed span is reasoning, longest-first so `</thinking>` is never split as `<t`. */
const OPEN_TAGS = ["<thinking>", "<think>"] as const;
const CLOSE_TAGS = ["</thinking>", "</think>"] as const;

/**
 * Removes stray thinking tags from a settled string.
 *
 * Call sites that stream `reasoning_content` through to the client as a
 * canonical `reasoning` part forward the field verbatim, so when the upstream
 * double-wraps its own reasoning in `<think>…</think>` the tag bytes reach the
 * client. The hy4-preview-f buddy model does this intermittently: the real
 * answer appears inside the reasoning stream between `<think>` markers and the
 * `content` stream reads blank, which is why the model is sometimes read as
 * "not thinking" even though it was.
 *
 * The function is for a value that has already settled — a non-stream message
 * body, or a stream delta that is not being tracked across chunks — so it is
 * not stateful; a tag split across two chunks is a job for `MimoThinkSplitter`.
 * Both case variants pass through: `<Think>` and `<THINK>` survived everyone's
 * normalizer long enough for them not to be the leak this closes.
 */
/**
 * Removes visible thinking tags, leaving any that sit inside a code span or
 * fence alone.
 *
 * A tag inside backticks is the *subject* of the answer — documentation or a
 * code sample showing the tag — not markup the upstream leaked, so stripping it
 * would silently rewrite the answer.
 */
export function stripThinkingTags(value: string): string {
  if (!value.includes("<")) return value;
  const pattern = /<think(?:ing)?\b[^>]*>|<\/think(?:ing)?\s*>|`+/g;
  let out = "";
  let last = 0;
  let ticks = 0;
  for (const match of value.matchAll(pattern)) {
    const text = match[0];
    const index = match.index ?? 0;
    if (text.startsWith("`")) {
      // A fence and an inline span are both just "inside code" here: the
      // distinguishing case (a newline closing an unterminated span) cannot
      // affect a tag already indexed in a settled string.
      if (ticks === 0) {
        ticks = text.length;
      } else if (text.length === ticks) {
        ticks = 0;
      }
      continue;
    }
    // Inside code: keep the tag verbatim.
    if (ticks > 0) continue;
    out += value.slice(last, index);
    last = index + text.length;
  }
  return out + value.slice(last);
}

/** The longest suffix of `text` that is a proper prefix of any tag. */
function danglingTagPrefix(text: string): string {
  const tags = [...OPEN_TAGS, ...CLOSE_TAGS];
  const maxLength = Math.max(...tags.map((tag) => tag.length)) - 1;
  const limit = Math.min(maxLength, text.length);
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

/** Strips the NUL padding MiMo injects into thought streams. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
}

export interface ThinkSplit {
  /** Answer text, with all reasoning spans removed. */
  readonly text: string;
  /** Reasoning text, tag-free. Empty when the chunk carried no thought. */
  readonly reasoning: string;
}

/** A tag match plus the code state at the match, so the caller commits it. */
interface TagMatch {
  readonly index: number;
  readonly length: number;
  readonly codeTicks: number;
  readonly codeFenced: boolean;
}

/**
 * Splits one upstream text chunk into answer text and reasoning text.
 *
 * Call `flush()` once the upstream stream ends to release any text the
 * splitter held back while it waited for a possible tag to complete.
 */
export class MimoThinkSplitter {
  #buffer = "";
  #inReasoning = false;
  /** Backtick run that opened the code span/fence we are inside; 0 when not in
   *  code. A tag inside a code span is the *subject* of the answer — a doc or a
   *  code sample mentioning `<think>` — not a delimiter, so it must survive
   *  verbatim instead of splitting the stream. */
  #codeTicks = 0;
  /** Whether `#codeTicks` opened a fenced block (closes on its own line) rather
   *  than an inline span. */
  #codeFenced = false;

  /** Feeds a chunk; returns the text/reasoning split for everything settled. */
  push(chunk: string): ThinkSplit {
    this.#buffer += stripNul(chunk);
    let text = "";
    let reasoning = "";

    for (;;) {
      if (!this.#inReasoning) {
        const opened = this.#findOpen();
        if (opened === undefined) break;
        text += this.#consumeUpTo(opened);
        this.#buffer = this.#buffer.slice(opened.index + opened.length);
        this.#inReasoning = true;
        continue;
      }
      const closed = this.#findClose();
      if (closed === undefined) break;
      reasoning += this.#consumeUpTo(closed);
      this.#buffer = this.#buffer.slice(closed.index + closed.length);
      this.#inReasoning = false;
    }

    // Hold back a suffix that could still grow into a tag; the rest is settled.
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    this.#buffer = held;
    // A lone closing tag lands here when the upstream dropped the opener before
    // committing the answer — the same quirk `stripThinkingTags` handles for
    // settled values, and just as bad to forward: the tag bytes are rendered in
    // the chat. Inside a reasoning span the text is already tag-free, so only
    // the answer side is swept.
    if (this.#inReasoning) reasoning += settled;
    else text += stripThinkingTags(settled);

    return { text, reasoning };
  }

  /** Releases text held back for a tag that never completed. */
  flush(): ThinkSplit {
    const rest = this.#buffer;
    this.#buffer = "";
    this.#codeTicks = 0;
    this.#codeFenced = false;
    return this.#inReasoning
      ? { text: "", reasoning: rest }
      : { text: stripThinkingTags(rest), reasoning: "" };
  }

  /** Returns the text before a tag and commits the code state at it. */
  #consumeUpTo(match: TagMatch): string {
    this.#codeTicks = match.codeTicks;
    this.#codeFenced = match.codeFenced;
    return this.#buffer.slice(0, match.index);
  }

  #findOpen(): TagMatch | undefined {
    return this.#findTag(OPEN_TAGS);
  }

  #findClose(): TagMatch | undefined {
    return this.#findTag(CLOSE_TAGS);
  }

  /**
   * The earliest occurrence of any of `tags` that is *not* inside a code span
   * or fence, scanning left to right so code state is tracked exactly once per
   * position. Returns the match and the code state at it, so `push` can commit
   * that state when it consumes the tag.
   */
  #findTag(tags: readonly string[]): TagMatch | undefined {
    const buffer = this.#buffer;
    let ticks = this.#codeTicks;
    let fenced = this.#codeFenced;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === "`") {
        let run = 1;
        while (buffer[i + run] === "`") run++;
        if (ticks === 0) {
          ticks = run;
          // Three or more backticks open a fence rather than an inline span.
          fenced = run >= 3;
        } else if (run === ticks) {
          ticks = 0;
          fenced = false;
        }
        i += run - 1;
        continue;
      }
      // A newline closes an inline span that never closed on its own line; a
      // fence runs to a closing line instead.
      if (char === "\n" && ticks > 0 && !fenced) ticks = 0;
      if (char !== "<" || ticks > 0) continue;
      for (const tag of tags) {
        if (!buffer.startsWith(tag, i)) continue;
        return { index: i, length: tag.length, codeTicks: ticks, codeFenced: fenced };
      }
    }
    return undefined;
  }
}

