/**
 * Antigravity adapter — facade.
 *
 * Antigravity is Google's Cloud Code Assist backend
 * (`daily-cloudcode-pa.googleapis.com`), reached via Google OAuth. The wire
 * reuses the Gemini `buildGeminiPayload` envelope from `protocol/request/gemini.ts`,
 * wrapped in Antigravity's agent envelope (`project`/`requestId`/wire
 * `model`/`request`) and POSTed to the fixed `v1internal:{generate,stream
 * Generate}Content` RPC — no per-model URL path.
 *
 * The implementation is split across the siblings in this directory, all
 * re-exported here so importers are unchanged:
 *   - `./antigravity-adapter` — the ProviderAdapter implementation and factory
 *   - `./antigravity-models` — the cross-brand model catalog and wire paths
 *   - `./antigravity-session` — sticky conversation session state and store
 *   - `./antigravity-envelope` — the agent-envelope builder
 *   - `./antigravity-transport` — failover and empty-stream peek helpers
 *   - `./antigravity-protocol` — wire helpers (User-Agent, model-id mapping,
 *     tool-schema normalization, skip-thought-signature bypass, project lookup)
 *   - `./antigravity-oauth` / `./antigravity-provision` / `./antigravity-quota`
 *     / `./antigravity-discovery` — auth, provisioning, quota, model discovery
 */
export {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_SEARCH_MODELS,
} from "./antigravity-models";
export type { AntigravitySessionState } from "./antigravity-session";
export { AntigravitySessionStore } from "./antigravity-session";
export { buildAntigravityEnvelope } from "./antigravity-envelope";
export { failoverAntigravityUrl } from "./antigravity-transport";
export { AntigravityAdapter, antigravityAdapter, createAntigravityAdapter } from "./antigravity-adapter";
