/**
 * Facade for the probe phase helpers.
 *
 * The original single file split onto clean phase-family seams: wire/account
 * resolution (`probe-phase-resolve.ts`), preferences + request construction
 * (`probe-phase-request.ts`), stream classification (`probe-phase-stream.ts`),
 * and health/verdict (`probe-phase-verdict.ts`). This module re-exports every
 * public symbol unchanged so importers keep their existing surface.
 */
export {
  loadProviderWireRow,
  resolveProbeAdapter,
  resolveProbeTarget,
  selectProbeAccount,
  selectUsableAccount,
  wireContextFrom,
} from "./probe-phase-resolve";
export type {
  ProbeAccountSelection,
  ProbeProviderRow,
  ProbeTarget,
} from "./probe-phase-resolve";
export {
  buildProbeCanonicalRequest,
  loadProbePreferences,
  PROBE_FAST_DEFAULT_PROMPT,
  PROBE_FAST_DEFAULT_TIMEOUT_SECONDS,
  PROBE_FAST_MAX_OUTPUT_TOKENS,
  PROBE_FAST_SAMPLE_MAX_CHARS,
} from "./probe-phase-request";
export type {
  ProbePreferences,
  ProbeReasoning,
} from "./probe-phase-request";
export {
  extractSample,
  GROK_407_PROBE_PROMPT,
  grok407ProbeFailure,
  hasMeaningfulOutput,
  modelFromEvents,
} from "./probe-phase-stream";
export {
  computeProbeVerdict,
  recordProbeHealth,
} from "./probe-phase-verdict";
export type {
  ProbeVerdict,
} from "./probe-phase-verdict";
