/**
 * Presentation and small-read helpers for the console's observability store.
 *
 * Split out of `store.ts` so the store class keeps only orchestration (reads,
 * caching, composition) and these pure mappings/derivations live together.
 * None of them touch the store's cache or preferences — they are functions of
 * a single event row, a database handle, or a period token.
 */
import { and, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { networkPools } from "../../persistence/schema";
import { type TelemetryEventRecord } from "../../observability/event-log";
import { clientNameFromUserAgent } from "../../observability/client-name";
import { maskClientIp } from "../../observability/redaction";
import { splitEndpointConfig } from "../../network/pool/agent";
import { payloadReferenceFromRow, readPayloadFrame } from "../../observability/payload-store";
import { pickDefined } from "../shared/object";
import type {
  TelemetryEventView,
  UsageDimension,
  UsageRequestItem,
} from "./contracts";

export function mapTelemetryEventRow(event: TelemetryEventRecord): TelemetryEventView {
  return {
    id: event.id,
    createdAt: event.createdAt,
    tenantId: event.tenantId ?? "",
    requestId: event.requestId,
    ...(event.sourceSurface ? { sourceSurface: event.sourceSurface } : {}),
    ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
    ...(event.reportedModel ? { reportedModel: event.reportedModel } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.latencyMs !== null ? { latencyMs: event.latencyMs ?? undefined } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.estimatedCostUsd !== null
      ? { estimatedCost: Number(event.estimatedCostUsd ?? 0) }
      : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
  };
}

/** The HTTP status a row renders as when the wire status was never recorded. */
export function effectiveHttpStatus(event: TelemetryEventRecord): number {
  if (event.httpStatus !== null) return event.httpStatus;
  if (event.status === "completed") return 200;
  if (event.status === "cancelled") return 499;
  if (event.status === "truncated") return 502;
  return 500;
}

/** Resolves a `usage` period token ("24h", "7d", "30d", "all") to its inclusive start date. */
export function periodStartDate(period: string): Date | undefined {
  const match = /^(\d+)([hd])$/.exec(period);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * unitMs);
}

/** Time-series bucket width for the usage chart, chosen from the window length. */
export function chartBucketSeconds(period: string): number {
  const since = periodStartDate(period);
  if (!since) return 86_400;
  const windowMs = Date.now() - since.getTime();
  if (windowMs <= 2 * 3_600_000) return 300;
  if (windowMs <= 2 * 86_400_000) return 3_600;
  if (windowMs <= 10 * 86_400_000) return 21_600;
  return 86_400;
}

/**
 * The model id with the client's requested reasoning effort as a display
 * suffix — only when the request actually carried one.
 */
export function modelWithEffort(event: TelemetryEventRecord): string | undefined {
  const model = event.requestedModel;
  if (!model) return undefined;
  return event.requestedEffort ? `${model} (${event.requestedEffort})` : model;
}

export function mapUsageRequestItem(
  event: TelemetryEventRecord,
  hideClientIp: boolean,
): UsageRequestItem {
  const input = event.inputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  return {
    requestId: event.requestId,
    ...(event.sourceSurface ? { surface: event.sourceSurface } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...pickDefined({ model: modelWithEffort(event) as string }),
    ...(event.reportedModel ? { reportedModel: event.reportedModel } : {}),
    status: event.status ?? "unknown",
    ...(event.errorCategory ? { errorKind: event.errorCategory } : {}),
    ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
    httpStatus: effectiveHttpStatus(event),
    mode: event.stream ? "stream" : "non_stream",
    startedAt: event.createdAt,
    ...(event.latencyMs !== null ? { durationMs: event.latencyMs ?? undefined } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.cachedInputTokens !== null
      ? { cachedTokens: event.cachedInputTokens ?? undefined }
      : {}),
    ...(event.reasoningTokens !== null
      ? { reasoningTokens: event.reasoningTokens ?? undefined }
      : {}),
    ...(event.endpoint ? { endpoint: event.endpoint } : {}),
    ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    ...(event.networkPoolId ? { networkPoolId: event.networkPoolId } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    ...(event.userAgent ? { clientName: clientNameFromUserAgent(event.userAgent) } : {}),
    ...(event.clientIp
      ? { clientIp: hideClientIp ? maskClientIp(event.clientIp) : event.clientIp }
      : {}),
    ...(input + output > 0 ? { totalTokens: input + output } : {}),
    ...(event.ttfbMs !== null ? { ttfbMs: event.ttfbMs ?? undefined } : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
    ...(event.estimatedCostUsd !== null && event.estimatedCostUsd !== undefined
      ? { estimatedCost: Number(event.estimatedCostUsd) }
      : {}),
    ...(event.creditUsed !== null && event.creditUsed !== undefined
      ? { creditUsed: Number(event.creditUsed) }
      : {}),
    ...(event.resolveMs !== null && event.resolveMs !== undefined
      ? { resolveMs: event.resolveMs }
      : {}),
    // Why the drawer is empty for this request — see the contract field. This is
    // what makes the blank panels diagnosable without server logs.
    ...(event.payloadCaptureState ? { payloadCaptureState: event.payloadCaptureState } : {}),
    // Degenerate stop (short output ended by an ordinary `stop`) — carried so
    // the request detail can flag the pattern.
    ...(event.degenerateStop ? { degenerateStop: true } : {}),
  };
}

export async function resolveProxyLabel(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<string> {
  const rows = await db
    .select({ id: networkPools.id, endpointConfig: networkPools.endpointConfig })
    .from(networkPools)
    .where(and(eq(networkPools.id, poolId), eq(networkPools.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) return `${poolId.slice(0, 8)}…`;
  const { endpoint, label } = splitEndpointConfig((row.endpointConfig ?? {}) as Record<string, unknown>);
  return label ?? endpoint ?? `${poolId.slice(0, 8)}…`;
}

/**
 * The console dimension as the SQL reader's grouping key.
 *
 * `client` maps to `client_name` (stamped at ingestion) rather than
 * `user_agent`: the grouping is now a plain GROUP BY on a column the writer
 * filled, instead of a per-row `clientNameFromUserAgent` call in JavaScript.
 */
export function breakdownDimension(dimension: UsageDimension): string {
  if (dimension === "model") return "model";
  if (dimension === "key") return "api_key";
  if (dimension === "client") return "client";
  if (dimension === "client_ip") return "client_ip";
  return "provider";
}

/**
 * Reads the captured bodies behind one `telemetry_payloads` row.
 *
 * The row stores typed frame-reference columns only; every body lives in the
 * frame file those columns name. Returns `undefined` when there is no row, no
 * usable reference, or the frame cannot be read — all three mean "nothing to
 * show", and the caller renders the request without a payload section. The raw
 * reference is never returned to a caller, so it cannot reach the dashboard.
 */
export async function readCapturedBodies(
  row:
    | {
        readonly storage: string;
        readonly file: string;
        readonly offset: number;
        readonly length: number;
        readonly checksum: string;
        readonly version: number;
      }
    | null
    | undefined,
): Promise<
  | {
      request: unknown;
      response: unknown;
      clientResponse: unknown;
      providerRequest: unknown;
      providerResponse: unknown;
      signals?: { toolCalls: number; images: number; attachments: number };
    }
  | undefined
> {
  if (!row) return undefined;
  const reference = payloadReferenceFromRow(row);
  if (!reference) return undefined;
  try {
    const stored = await readPayloadFrame(reference);
    if (!stored || typeof stored !== "object") return undefined;
    const record = stored as Record<string, unknown>;
    const bodies = {
      request: record["request_body"] ?? undefined,
      response: record["response_body"] ?? undefined,
      clientResponse: record["client_response_body"] ?? undefined,
      providerRequest: record["provider_request_body"] ?? undefined,
      providerResponse: record["provider_response_body"] ?? undefined,
    };
    const signals =
      typeof record["signals"] === "object" &&
      record["signals"] !== null &&
      !Array.isArray(record["signals"])
        ? (record["signals"] as { toolCalls: number; images: number; attachments: number })
        : undefined;
    return {
      ...bodies,
      ...pickDefined({ signals }),
    };
  } catch {
    return undefined;
  }
}
