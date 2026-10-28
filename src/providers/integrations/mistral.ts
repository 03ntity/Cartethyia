import type { ModelDefinition } from "../provider-model-definition";
import { defineModel } from "../provider-model-definition";

const MISTRAL_PROVIDER_ID = "mistral" as const;

/**
 * Mistral's catalog for the generic OpenAI-compatible API-key provider.
 *
 * The provider is registered as a generic API-key provider, which carries no
 * catalog of its own: without this list, every model it serves stays absent
 * until a discovery run happens to fetch them.
 *
 * Limits and pricing come from the base catalog via `providerId`: `defineModel`
 * resolves `mistral:<id>` and falls back to the majority row, so no number is
 * restated here to drift away from it. Capability *is* declared per row,
 * because the base catalog is keyed by bare id and a bare id maps to many
 * providers' servings.
 *
 * Which rows are here: the chat models live on a real Mistral account (the
 * code/codestral family, the ministral small/medium/large sizes, voxtral
 * small, and the small/medium generalist tiers). A live probe against the
 * Mistral API verified each of these responds on `/v1/chat/completions`.
 *
 * Deliberately not included:
 *
 * - `mistral-large-latest` / dated large rows — tier-gated (Mistral answers
 *   403 `tier_not_allowed` on many subscription tiers).
 * - The embed/moderation/OCR/transcribe/TTS/realtime rows — they speak a
 *   different endpoint, not chat.
 * - The Labs rows (`labs-leanstral-*`) — need an organization admin flag.
 * - The open-weights rows (`open-mistral-7b`, `open-mixtral-8x7b`) and the
 *   devstral family — separate product lines.
 */
export const MISTRAL_MODELS: readonly ModelDefinition[] = [
  // Code / coding family
  defineModel({
    id: "codestral-2508",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "codestral-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-code-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-code-fim-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  // Ministral sizes
  defineModel({
    id: "ministral-14b-2512",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "ministral-14b-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "ministral-8b-2512",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "ministral-8b-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "ministral-3b-2512",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "ministral-3b-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  // Voxtral small (chat-capable)
  defineModel({
    id: "voxtral-small-2507",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "voxtral-small-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  // Medium generalist tiers
  defineModel({
    id: "mistral-medium-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium-3-5",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium-3.5",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium-3",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium-2604",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  // Vibe CLI family
  defineModel({
    id: "mistral-vibe-cli-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-vibe-cli-with-tools",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-vibe-cli-fast",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  // Magistral / small generalist tiers (chat-capable)
  defineModel({
    id: "magistral-medium-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-small-2603",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-small-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "magistral-small-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];
