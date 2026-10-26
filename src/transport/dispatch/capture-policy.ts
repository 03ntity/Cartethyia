// Tenant payload-capture policy resolved once and shared by dispatch attempts.
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { payloadRetentionMs, resolvePayloadCapture } from "../../observability/payload-capture";
import type { TelemetryPayloadDepth, TelemetryPayloadMode } from "../../console/settings/contracts";

/** Per-stage body cap for the provider request/response tee. */
export function providerCaptureMaxBytes(depth?: TelemetryPayloadDepth): number {
  if (depth === "moderate") return 2 * 1024 * 1024;
  if (depth === "maximum") return 4 * 1024 * 1024;
  return 1024 * 1024;
}

/** Resolve whether provider bodies should be retained, memoized on this request. */
export async function shouldCaptureProviderBodyForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: { payloadCapturePreference?: unknown },
): Promise<boolean> {
  if (state.payloadCapturePreference === undefined) {
    state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
  }
  const resolved = state.payloadCapturePreference as
    | { readonly ok: true; readonly mode: string }
    | { readonly ok: false };
  return resolved.ok === true && resolved.mode === "full";
}

/** Resolve the tenant's capture mode once per request; failed reads fail closed. */
export async function resolveCaptureModeForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: { payloadCapturePreference?: unknown },
): Promise<TelemetryPayloadMode> {
  if (state.payloadCapturePreference === undefined) {
    state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
  }
  const resolved = state.payloadCapturePreference as
    | { readonly ok: true; readonly mode: TelemetryPayloadMode }
    | { readonly ok: false };
  return resolved.ok === true ? resolved.mode : "none";
}

/** Resolve the tenant's capture depth once per request. */
export async function resolveCaptureDepthForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: { payloadCapturePreference?: unknown },
): Promise<TelemetryPayloadDepth> {
  if (state.payloadCapturePreference === undefined) {
    state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
  }
  const resolved = state.payloadCapturePreference as
    | { readonly ok: true; readonly depth: TelemetryPayloadDepth }
    | { readonly ok: false };
  return resolved.ok === true ? resolved.depth : "minimum";
}

/** Resolve the tenant's payload retention once per request. */
export async function resolveCaptureRetentionForRequest(
  db: CartethyiaDatabase,
  tenantId: string | null,
  state: { payloadCapturePreference?: unknown },
): Promise<number> {
  if (state.payloadCapturePreference === undefined) {
    state.payloadCapturePreference = await resolvePayloadCapture(db, tenantId);
  }
  const resolved = state.payloadCapturePreference as
    | { readonly ok: true; readonly retentionMs: number }
    | { readonly ok: false };
  return resolved.ok === true ? resolved.retentionMs : payloadRetentionMs();
}

/** Combined body cap for the four payload panels at one configured depth. */
export function captureDepthMaxBytes(depth: TelemetryPayloadDepth): number {
  if (depth === "moderate") return 8 * 1024 * 1024;
  if (depth === "maximum") return 16 * 1024 * 1024;
  return 1 * 1024 * 1024;
}
