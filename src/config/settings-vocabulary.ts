/**
 * Pure vocabulary for operator-configurable request/telemetry settings.
 *
 * A leaf shared by the console runtime-settings surface (which validates and
 * stores these values) and the lower layers that act on them — transport
 * request state and capture policy, the observability payload capture, and
 * provider probing. Import-free so any layer and the dashboard can consume it
 * without pulling in a dependency graph.
 */

export const TELEMETRY_PAYLOAD_MODES = ["full", "metadata", "none"] as const;
/** Telemetry payload capture mode accepted by the runtime-settings PATCH. */
export type TelemetryPayloadMode = (typeof TELEMETRY_PAYLOAD_MODES)[number];

export const TELEMETRY_PAYLOAD_DEPTHS = ["minimum", "moderate", "maximum"] as const;
/** Capture depth for `full` mode accepted by the runtime-settings PATCH. */
export type TelemetryPayloadDepth = (typeof TELEMETRY_PAYLOAD_DEPTHS)[number];

export const MODEL_PROBE_MODES = ["fast", "detail"] as const;
/** Model probe mode accepted by the runtime-settings PATCH and the probe route. */
export type ModelProbeMode = (typeof MODEL_PROBE_MODES)[number];
