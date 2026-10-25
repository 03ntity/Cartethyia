/**
 * Payload capture for a request rejected before it ever reached routing.
 *
 * An early rejection — ingress, auth, parse, or the preparer — never calls
 * `completeAttempt`, and that was the only place a payload frame was written.
 * The result was a request row whose four capture panels were all empty, for
 * exactly the case an operator most wants to read: what did the client
 * actually send, and what did we answer?
 *
 * There is no provider exchange to capture here because no provider was
 * reached, so the frame carries what the case has: the ingress body and the
 * error envelope the client received.
 */
import type { PayloadCaptureState } from "../../observability/payload-capture";
import { resolvePayloadCapture } from "../../observability/payload-capture";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
/** The capture surface this helper needs; matches the real capture's method. */
export interface EarlyRejectionCaptureSink {
  capture(input: EarlyRejectionCapture): Promise<{
    id: string;
    expiresAt: Date;
    payloadCaptureState?: string;
  }>;
}

/** One early-rejection payload frame. */
export interface EarlyRejectionCapture {
  readonly tenantId: string;
  readonly requestBody: unknown;
  readonly responseBody: unknown;
  readonly clientResponseBody?: unknown;
  readonly scope: "tenant";
  readonly tenantOptIn: boolean;
  readonly requestId?: string;
}

/** The state this helper reads; a subset of `ProxyRequestState`. */
export interface EarlyRejectionState {
  readonly requestId: string;
  readonly ingressBody?: unknown;
  readonly clientResponseText?: string;
  readonly payloadCapture?: EarlyRejectionCaptureSink;
  /**
   * The request's memoized capture preference, when the request already
   * resolved one. Early rejections rarely have, so the helper resolves the
   * tenant preference itself through the same `resolvePayloadCapture` path
   * every other capture decision uses — the bypass this field exists to end
   * was an early rejection capturing bodies with the deployment's full cap
   * while the tenant had configured `none` or `metadata`.
   */
  payloadCapturePreference?: unknown;
  /**
   * Written by this helper so telemetry can record whether the rejection's body
   * was captured. Mutable because the reason is an outcome, not an input.
   */
  payloadCaptureState?: PayloadCaptureState;
}

/**
 * Records the ingress body and client error for a rejected request.
 *
 * Fire-and-forget by contract: the response is already on the wire when this
 * runs, so a storage fault must never change the status the client was given.
 * Swallowing the rejection is the point, not an oversight.
 */
export async function captureEarlyRejectionPayload(
  state: EarlyRejectionState,
  authorization: { readonly tenantId: string },
  db?: CartethyiaDatabase,
): Promise<void> {
  const capture = state.payloadCapture;
  if (capture === undefined) return;
  if (state.ingressBody === undefined) return;
  try {
    // The same preference path a dispatched request resolves (memoized on the
    // state when the request got far enough to have one). `none` captures
    // nothing at all; `metadata` records stage presence only, without the
    // ingress body; only `full` keeps bodies — and at the tenant's own
    // retention, never the deployment default by accident.
    const preference =
      state.payloadCapturePreference !== undefined
        ? (state.payloadCapturePreference as { ok: boolean })
        : db !== undefined
          ? await resolvePayloadCapture(db, authorization.tenantId)
          : { ok: false };
    const mode = preference.ok === true ? (preference as { mode: string }).mode : "none";
    if (mode === "none") {
      state.payloadCaptureState = "skipped_mode_none";
      return;
    }
    if (mode === "metadata") {
      // Stage presence only: the ingress body is exactly what `metadata`
      // mode declines to retain. A frame with no body is pointless, so the
      // state records the mode outcome and nothing is written.
      state.payloadCaptureState = "captured_metadata";
      return;
    }
    const result = await capture.capture({
      tenantId: authorization.tenantId,
      requestBody: state.ingressBody,
      // No provider exchange: the request never reached one.
      responseBody: null,
      ...(state.clientResponseText === undefined ? {} : { clientResponseBody: state.clientResponseText }),
      scope: "tenant",
      tenantOptIn: true,
      requestId: state.requestId,
    });
    state.payloadCaptureState =
      (result.payloadCaptureState as PayloadCaptureState | undefined) ?? "captured";
  } catch {
    // A capture failure is not a request failure; the telemetry row stands.
    state.payloadCaptureState = "failed_write";
  }
}
