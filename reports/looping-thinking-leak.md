# Looping & thinking leak — investigation findings and fix proposal

**Repo:** `Cartethyia`, branch `dev`, HEAD `223c52c2`.
**Reported:** "every ai provider connects into cartethyia like, looping and thinking leak".
**Suspected area (user):** `protocol/translation`. **Confirmed** — every root cause below is in
`src/protocol/**` or in the surface encoders/parsers directly downstream of it.

This document is an investigation report + fix proposal. **No code has been changed.** Every finding
carries `path:line`; each is marked VERIFIED (read directly from code, deterministic) or UNCERTAIN
(plausible but not exercised by any capture/test in this repo).

---

## TL;DR — what actually causes the two symptoms

| Symptom | Root cause | Severity |
|---|---|---|
| **Thinking leak** (thinking rendered as visible answer text) | `payload` + `summary` both carrying the *same* reasoning string on the Messages wire → the Responses encoder emits it **twice**, once as `reasoning_text` and once as `summary_text` | **P0** |
| **Thinking leak** | `src/protocol/response/codex.ts:631-636` catch-all: *any* unrecognized frame carrying a string `delta` becomes `kind:"text"` — including reasoning frames | **P0** |
| **Thinking leak** | `src/protocol/request/messages.ts:368-374`: unsigned reasoning is **downgraded to a visible `text` block** on replay | **P1** |
| **Thinking leak** (literal tag bytes) | `chat.ts:348` strips `<think>` from `reasoning_content` with a **stateless** regex; a tag split across two deltas leaks `<thi` + `nk>…` | **P1** |
| **Looping** | No unbounded content loop found. The repeat the user sees is **duplicated content from one canonical part**, plus retry/empty-stream replay paths | **P1** |
| **Billing** | `kiro.ts:568-569` adds reasoning into the same accumulator that derives billed `completionTokens` | **P2** |

**Honest note on "looping":** I could not find an unbounded `while`/`for` loop that fails to advance.
The Chat streaming decoder's four tail-flush blocks were checked exhaustively and are **disjoint** —
no delta is emitted twice there, and `sequence_number` is strictly increasing at all 16 yield sites.
So the "looping" the user perceives is most likely one of: (a) duplicated content per above, (b) the
empty-stream replay path re-running a request, or (c) a client re-rendering because the surface
encoder reopens blocks. (c) is UNCERTAIN — no capture in the repo confirms it.

---

## Finding 1 — `payload` + `summary` double-write makes the Responses encoder emit reasoning twice

**VERIFIED.**

`src/protocol/response/messages.ts:93-98` (non-stream) and `:375-380` (stream) put the *same* string
in **both** fields of one canonical reasoning part:

```ts
// messages.ts:94-96
kind: "reasoning",
payload: thinking,
summary: thinking,
```

Downstream, `src/transport/surface/responses/encode.ts` emits **two wire events with identical
content** from that single part:

- `encode.ts:479-502` — `content.summary !== undefined` → `response.reasoning_summary_text.delta`
- `encode.ts:515-528` — `readable = content.payload` (a string, non-opaque) → `response.reasoning_text.delta`

and the finalized item carries the text twice: `content:[{type:"reasoning_text",…}]`
(`encode.ts:204-207`) **and** `summary:[{type:"summary_text",…}]` (`encode.ts:208-212`).

**This exact bug is already documented as fixed on one surface.** `src/protocol/response/codex.ts:81-84`:

> "A summary is not a reasoning_text payload. Putting it in both fields made the Responses encoder
> emit the same summary again as readable content, where adjacent parts lost their summary_index
> separators."

Codex got the fix (`payload: null`, summary-only). `messages.ts` never did.

Same un-fixed pattern at ingress: `src/transport/surface/messages/parse.ts:147-150`.
`chat/parse.ts:165-167` and `responses/parse.ts:224-227` use `payload: text ?? null` + conditional
`summary`, so they are safe when the text is absent.

**Why it matters:** one thinking block renders twice in the client — the "leak" the user describes.
It is cross-surface: any Claude/Messages provider whose output is served to a Responses client.

**Proposal:** make the summary/payload split canonical and enforce it at the boundary.
- `messages.ts:93-98` and `:375-380`: `payload` = the raw thinking text, `summary` = **omitted**
  (or `undefined`) when the provider gave no separate summary. Never both the same string.
- `src/transport/surface/messages/parse.ts:147-150`: same change at ingress.
- Add a guard so a reasoning part with `payload === summary` (both strings, equal) cannot reach an
  encoder — either a dev-mode assertion or a normalization step that clears `summary`.

**safe-if:** a client that legitimately wants both the trace *and* a condensed summary — but no
upstream in this repo sends two distinct values today, and Codex already proves summary-only works.

---

## Finding 2 — Codex catch-all turns any unknown frame into visible text

**VERIFIED.**

`src/protocol/response/codex.ts:631-636` is the **last** `else if` of the `process()` chain:

```ts
} else if (typeof json["delta"] === "string" && json["delta"].length > 0) {
  events.push({
    type: "content_delta",
    sequence_number: this.#seq++,
    content: { kind: "text", text: json["delta"] as string },
  });
}
```

Any frame the chain did not recognize — including a reasoning frame, or a future reasoning frame
type — is emitted as **visible assistant text**. This is the only true reasoning→visible-text leak in
the response surfaces; messages.ts, responses.ts and gemini.ts were each checked and are clean.

**Proposal:** never map an unknown frame to `kind:"text"`. Either drop it, or map it to
`kind:"extension"` (the existing pattern at `responses.ts:721-729`) so it stays visible to telemetry
without polluting the answer. Gate on frame type, not on the mere presence of a string `delta`.

**safe-if:** a provider that genuinely sends answer text in an untyped `delta` field with no `type`
key. Worth grepping captures for before choosing drop-vs-extension.

---

## Finding 3 — unsigned reasoning is downgraded to a visible text block on replay

**VERIFIED.**

`src/protocol/request/messages.ts:368-374`:

```ts
case "reasoning":
  if (!part.opaque && (typeof part.signature !== "string" || part.signature.trim().length === 0)) {
    const text = part.summary ?? (stringValue(part.payload) ? part.payload : "");
    return text.length > 0 ? { type: "text", text: toWellFormedString(text) } : undefined;
  }
```

Any reasoning part that is not opaque and has no signature — i.e. **exactly** what comes in from Chat
`reasoning_content` (`chat/parse.ts:232-236`) or plain Responses reasoning (`responses/parse.ts:468`),
neither of which carries a signature — is concatenated into the replayed turn as ordinary visible
`text`. The model then reads the prior chain-of-thought as user-visible prose.

There is **no comment** justifying this downgrade, unlike every neighbouring branch. Plausible motive:
Anthropic rejects an unsigned `thinking` block. **UNCERTAIN** — no capture or comment in the repo
states it.

**Proposal:** emit `{type:"text"}` only as a deliberate, documented fallback; otherwise emit a proper
`thinking` block without a signature, or drop the part. At minimum, add the comment that explains the
choice and a test pinning it.

---

## Finding 4 — stateless `<think>` stripping leaks tag bytes across chunk boundaries

**VERIFIED.**

`src/protocol/response/chat.ts:348` applies `stripThinkingTags()` to `reasoning_content`. That helper
(`think-stream.ts`) is **stateless** by design. So:

- delta 1 = `"<thi"` → no regex match → emitted verbatim as reasoning text
- delta 2 = `"nk>real thought</think>"` → only `</think>` stripped → `"nk>real thought"`

The client receives `<thi` + `nk>real thought`. The comment at `chat.ts:341-343` concedes exactly
this ("an open-ended tag that spans multiple deltas is a splitter job, not this one") but **nothing
routes `reasoning_content` into `MimoThinkSplitter`** — the splitter is fed only `visible` (from
`content`) at `chat.ts:316`. The gap the comment names is unhandled.

Trigger: any upstream that chunks a `<think>` across two `reasoning_content` frames. The file already
documents buddy `hy4-preview-f` as double-wrapping its reasoning in `<think>`.

**Proposal:** route `reasoning_content` through a per-stream `MimoThinkSplitter` instance instead of
the stateless stripper, exactly as `content` already is. Keep the stateless helper for settled
(non-stream) values only.

---

## Finding 5 — two splitter instances on one stream (chat + encoder)

**VERIFIED.** `chat.ts:260` and `encoder.ts:96` each construct their **own** `MimoThinkSplitter`, and
the encoder re-splits text the chat decoder already split.

Empirically confirmed with a throwaway probe (since deleted): text containing a literal `<think>` in
the answer — e.g. `"Use the <think> tag to enable reasoning."` — is swallowed into reasoning by the
first splitter, so the client sees only `"Use the "`. The tail is **lost, not just misclassified**:

```
in      : "Use the <think> tag to enable reasoning."
stage1  : T1:"Use the" | T1:" " | R1:" tag t" | R1:"o enabl" | R1:"e reaso" | R1:"ning."
visible : "Use the "
```

This is a real correctness bug for any answer that mentions a tag literally (docs, code samples).
It is *not* the duplicate-emission cause — the two splitters see different, complementary slices —
but it is the same class of "thinking handling eats the answer" complaint.

**Proposal:** one splitter per stream, owned by one layer. Either (a) the encoder owns it and the wire
decoders stop splitting, or (b) the decoder owns it and the encoder stops. (a) is cleaner: the
encoder is already the one place every surface shares. Requires checking `kiro-stream.ts` and
`commandcode.ts`, which have their own per-stream splitters.

---

## Finding 6 — `payload`/`summary` precedence is inverted between two encoders

**VERIFIED.**

- `src/transport/surface/chat/encode.ts:114-119` (`eventReasoningText`): reads `payload` **then** `summary`.
- `src/transport/surface/messages/encode.ts:113-114` (`blockFromPart`): reads `summary` **then** `payload`.

Two opposite precedence orders for the same two fields. A part carrying **both** yields different
visible text on Chat vs Messages. Combined with Finding 1 (where both hold the same string) this is
currently masked — fixing F1 without fixing this will expose it.

**Proposal:** one shared reader with one documented precedence, used by both surfaces.

---

## Finding 7 — reasoning inflate billed output tokens (Kiro)

**VERIFIED.**

`src/providers/integrations/kiro/kiro.ts:568-569`: `outputText += delta.text` on the reasoning branch.
That same accumulator feeds `kiroUsage(usage, model, outputText)` (`:596`), and
`kiroTokenCounts` (`kiro-request.ts:291-297`) derives
`completionTokens = floor(outputText.length / 4)` from it.

So reasoning text inflates billed completion tokens. The comment at `kiro.ts:531-532` says this is
intentional ("billed as such"), but one accumulator mixes **answer + reasoning + tool-call argument
JSON** (`kiro.ts:540: outputText += delta.arguments_delta`).

**Proposal:** keep a separate `reasoningText` accumulator; decide explicitly whether reasoning is
billable, and document it. Do not silently mix three categories in one string.

---

## Finding 8 — reasoning flattened into replayed history text (Cursor, CommandCode)

**VERIFIED (code). UNCERTAIN (impact).**

- `src/providers/integrations/cursor/cursor-request.ts:585-593` — `messageText()` pushes `part.summary`
  (`:591`) into the same array as `part.text` (`:588`) and joins with `"\n"` (`:593`). That flattened
  string is the escaped history prefix (`:224-228`) and `liveUserText` (`:622-625`). Prior-turn
  reasoning is replayed as indistinguishable prose.
- `src/providers/integrations/commandcode/commandcode.ts:233-237` — `reasoning` is built from
  `part.summary ?? ""`; a payload-only part silently becomes `{type:"reasoning", text:" "}` (`:239`).

Compare the Chat request path, which filters reasoning out explicitly
(`src/protocol/request/chat.ts:394-395`), and `joinTextParts` (`canonical-model.ts:581-588`), which
only collects `kind === "text"`. These two providers are the divergent ones.

---

## Finding 9 — tool-markup parsers drop or leak tail text

**VERIFIED.** Both parsers run on `reasoning_content` as well as content (`chat.ts:55-67`).

- `omp-tool-call-markup.ts:129-134` — `#couldBeOpening` has a **dead branch**: the second clause
  `/^[0-9a-f]{8}$/.test(suffix) && !value.endsWith(">")` is unreachable, because `{8}` hex already
  matched the first `{0,8}` alternative and `||` short-circuits. A pending `<tool_calls:deadbeef>`
  is held as "could be opening" forever, then `flush()` (`:107-113`) returns `{text:""}` — **text
  silently dropped**.
- `omp-tool-call-markup.ts:112` — `OPEN_PATTERN` is not end-anchored, so pending
  `"<tool_calls:deadbeef>xyz"` matches and the **entire** string including visible `"xyz"` is dropped.
- `dsml.ts:79-83` — `flush()` emits the pending buffer **verbatim**, the opposite of the OMP
  invariant ("an unfinished envelope is deliberately discarded rather than leaked"). A stream cut
  mid-opener paints `<｜DSML｜ fu` into the answer.
- `chat.ts:472` and `:508` — `recoveredMarkupCalls.push(...)` is **dead code**: both `flush()`
  implementations return `calls: []` unconditionally.

---

## Finding 10 — no test covers any of the above

**VERIFIED.** `src/transport/translation/thinking.ts` has **zero** test imports. There is no unit test
of the `MimoThinkSplitter` class itself (only the stateless `stripThinkingTags`). No test asserts
strictly increasing `sequence_number` out of the pipeline. No cross-surface reasoning round-trip test.
No test file covers `src/protocol/sse-decoder.ts` at all. There is no shared
`expectNoDuplicate`/`assertMonotonic` helper — only local inline assertions in a few files.

Full gap list:
1. `MimoThinkSplitter` class — no direct unit test (NUL stripping, `<thinking>` vs `<think>`, `flush()`
   inside a reasoning span, reasoning-after-text, split closing tag).
2. `encoder.ts` sequence-number guard — untested.
3. `kiro-stream.ts` `KiroStreamDecoder` — untested.
4. `commandcode.ts` per-stream splitter — untested.
5. Non-streaming chat think-split path (`chat.ts:89-113`) — untested.
6. Messages-surface reasoning — untested.
7. Cross-surface reasoning round-trip — untested.
8. `src/transport/translation/thinking.ts` — untested.
9. Responses prelude retry duplicating frames — untested.
10. `provider-reasoning.ts` (`applyOpenAIReasoning`, `applyDeepSeekReasoning`,
    `backfillDeepSeekReasoningContent`) — untested.

---

## Proposed execution order

Each step is independently shippable and testable.

| # | Fix | Files | Risk |
|---|---|---|---|
| 1 | Add failing tests that pin current behavior for F1, F2, F4 | `test/protocol/**` | none |
| 2 | **F1**: stop writing the same string to `payload` and `summary` | `response/messages.ts:93-98,375-380`; `surface/messages/parse.ts:147-150` | medium — changes rendered output; needs the F6 precedence fix first or together |
| 3 | **F6**: one shared reasoning-text reader, one precedence | `surface/chat/encode.ts:114`; `surface/messages/encode.ts:113` | low |
| 4 | **F2**: unknown Codex frames never become `kind:"text"` | `response/codex.ts:631-636` | medium — needs a capture check for untyped-delta providers (see safe-if) |
| 5 | **F4**: route `reasoning_content` through a stateful splitter | `response/chat.ts:341-359` | low |
| 6 | **F5**: one splitter per stream, owned by the encoder | `response/chat.ts:260`; `streaming/encoder.ts:96`, plus kiro/commandcode | **high** — touches every surface; do last, with the full suite green |
| 7 | **F3**: document/decide the Messages unsigned-reasoning downgrade | `request/messages.ts:368-374` | low |
| 8 | **F9**: fix the OMP dead branch + end-anchor; make DSML flush consistent; delete dead pushes | `omp-tool-call-markup.ts:112,129`; `dsml.ts:79`; `chat.ts:472,508` | low |
| 9 | **F7/F8**: separate reasoning from billed/replayed text | `kiro.ts:568`; `cursor-request.ts:591`; `commandcode.ts:233` | medium — F7 changes billed token counts |

**Recommended split:** ship 2+3 together (they interact), then 4, 5, 8. Hold 6 and 9 for a second
pass — 6 is the highest-risk and 7/9 change billing.

### Verification gates

- `bun run typecheck`
- `bun run scripts/test/run.ts --scope backend`
- `git diff --check`
- New: a cross-surface reasoning round-trip test (Chat → Responses → Messages) asserting the thinking
  text appears **exactly once** and never in a `kind:"text"` part.
- New: a monotonic-sequence assertion helper, used by at least the chat and responses decoders.

---

## What I did NOT verify

- **No runtime reproduction.** Every finding is read from code; none has been executed against a live
  provider. The one empirical probe I ran (Finding 5, double-split) was a local simulation and its
  script was deleted.
- **The user's "looping" symptom is not fully explained.** I found duplication and retry/replay paths,
  but no unbounded loop. If the user is seeing an actual infinite repeat, the remaining candidates are
  `src/transport/dispatch/empty-stream.ts:113-153` (replay loop; note `:117` has an **identical-branch
  ternary** `isLastEndpoint ? maxReplays : maxReplays` — a no-op that suggests the intended distinction
  is missing) and client-side re-rendering. A capture would settle it.
- **The two reference repos were not analyzed** — `Public/9router` and `Public/oh-my-pi` were only
  listed at directory level. `oh-my-pi` maps to the in-repo `OmpToolCallMarkupParser`, so the
  connection is plausible but unconfirmed; no reference implementation was compared.
