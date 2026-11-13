// Raw Drizzle row access for the network-pool console domain: every SELECT /
// INSERT / UPDATE / DELETE statement against the pool tables, plus the
// row-to-record mapping. `store.ts` owns the store surface and orchestrates
// probes, health checks, and credential handling on top of this layer.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import { networkPools, poolRoutingSettings, providerPoolAccounts } from "../../../persistence/schema";
import type { NetworkPoolRecord, PoolStrategySetting, StoredProviderProbe } from "./contracts";
import { deriveKind, splitEndpointConfig } from "../../../network/pool/agent";

type NetworkPoolRow = typeof networkPools.$inferSelect;

/** Column-value map accepted by `UPDATE network_pools SET ...`. */
export type NetworkPoolUpdateSet = {
  [Key in keyof typeof networkPools.$inferInsert]?:
    | (typeof networkPools.$inferInsert)[Key]
    | SQL
    | undefined;
};

/**
 * The stored probe verdict for a row, or nothing when it does not describe the
 * pool as it stands.
 *
 * Two ways it can be stale, and both must read as "never probed" rather than as
 * a verdict:
 *
 * - The endpoint changed. The verdict was measured against a specific egress,
 *   and the pool now points somewhere else.
 * - The row was written before `provider_probe_endpoint` existed. There is no
 *   address to compare against, so the claim cannot be validated.
 */
export function storedProviderProbe(
  row: NetworkPoolRow,
  currentEndpoint: string,
): StoredProviderProbe | undefined {
  const status = row.providerProbeStatus;
  if (
    status !== "allowed" &&
    status !== "blocked" &&
    status !== "throttled" &&
    status !== "unreachable"
  ) {
    return undefined;
  }
  if (row.providerProbeEndpoint !== currentEndpoint) return undefined;
  const providerId = row.providerProbeProviderId;
  if (!providerId) return undefined;
  return {
    providerId,
    status,
    endpoint: currentEndpoint,
    checkedAt: (row.providerProbeAt ?? new Date(0)).toISOString(),
    ...(row.providerProbeHttpStatus === null || row.providerProbeHttpStatus === undefined
      ? {}
      : { httpStatus: row.providerProbeHttpStatus }),
    ...(row.providerProbeReason ? { reason: row.providerProbeReason } : {}),
    ...(row.providerProbeLatencyMs === null || row.providerProbeLatencyMs === undefined
      ? {}
      : { latencyMs: row.providerProbeLatencyMs }),
  };
}

/** Maps one `network_pools` row to the console-facing record. */
export function mapNetworkPoolRow(row: NetworkPoolRow, tenantId: string): NetworkPoolRecord {
  const raw = (row.endpointConfig ?? {}) as Record<string, unknown>;
  const { endpoint, label, rest } = splitEndpointConfig(raw);
  return {
    id: row.id,
    kind: deriveKind(row.kind, endpoint ?? ""),
    endpoint: endpoint ?? "",
    ...(label ? { label } : {}),
    maxInflight: row.maxInflight ?? 10,
    weight: row.weight ?? 100,
    status: row.status,
    inflight: 0,
    consecutiveFailures: row.consecutiveFailures,
    ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
    ...(row.lastLatencyMs !== null && row.lastLatencyMs !== undefined
      ? { lastLatencyMs: row.lastLatencyMs }
      : {}),
    ...(row.lastHealthCheckAt ? { lastHealthCheckAt: row.lastHealthCheckAt.toISOString() } : {}),
    ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
    ...(row.egressIp ? { egressIp: row.egressIp } : {}),
    ...(row.quotaBytes !== null && row.quotaBytes !== undefined
      ? { quotaBytes: row.quotaBytes }
      : {}),
    ...(row.bytesSentTotal !== null && row.bytesSentTotal !== undefined
      ? { bytesSentTotal: row.bytesSentTotal }
      : {}),
    ...(row.bytesReceivedTotal !== null && row.bytesReceivedTotal !== undefined
      ? { bytesReceivedTotal: row.bytesReceivedTotal }
      : {}),
    ...(row.lastSpeedtestBytes !== null && row.lastSpeedtestBytes !== undefined
      ? { lastSpeedtestBytes: row.lastSpeedtestBytes }
      : {}),
    ...(row.lastSpeedtestDurationMs !== null && row.lastSpeedtestDurationMs !== undefined
      ? { lastSpeedtestDurationMs: row.lastSpeedtestDurationMs }
      : {}),
    ...(row.lastSpeedtestStatus === "ok" || row.lastSpeedtestStatus === "failed"
      ? { lastSpeedtestStatus: row.lastSpeedtestStatus }
      : {}),
    ...(row.lastSpeedtestError ? { lastSpeedtestError: row.lastSpeedtestError } : {}),
    ...(row.lastSpeedtestAt ? { lastSpeedtestAt: row.lastSpeedtestAt.toISOString() } : {}),
    ...(() => {
      // A verdict describes the address recorded beside it. Once the pool is
      // re-pointed, that address is gone and the verdict is a claim about an
      // address the pool no longer uses — report "never probed" instead of
      // showing a colour the operator cannot trust.
      const probe = storedProviderProbe(row, endpoint ?? "");
      return probe === undefined ? {} : { providerProbe: probe };
    })(),
    ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
    ...(row.credentialCiphertext ? { hasCredential: true } : {}),
    ...(row.family ? { family: row.family } : {}),
    tenantId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Reads every pool row for one tenant, newest-first by id. */
export async function selectPoolRows(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<readonly NetworkPoolRow[]> {
  return db
    .select()
    .from(networkPools)
    .where(eq(networkPools.tenantId, tenantId))
    .orderBy(asc(networkPools.createdAt), asc(networkPools.id));
}

/** Reads one pool row, or nothing when it does not exist. */
export async function selectPoolRow(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<NetworkPoolRow | undefined> {
  const rows = await db
    .select()
    .from(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
    .limit(1);
  return rows[0];
}

/** Reads only the id of one pool row, for existence checks. */
export async function selectPoolRowId(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: networkPools.id })
    .from(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
    .limit(1);
  return rows[0];
}

/** Inserts pool rows in one statement. */
export async function insertPoolRows(
  db: CartethyiaDatabase,
  values: (typeof networkPools.$inferInsert)[],
): Promise<void> {
  await db.insert(networkPools).values(values);
}

/** Inserts pool-as-account rows in one statement. */
export async function insertPoolAccountRows(
  db: CartethyiaDatabase,
  values: (typeof providerPoolAccounts.$inferInsert)[],
): Promise<void> {
  await db.insert(providerPoolAccounts).values(values);
}

/**
 * Sets one status on every named pool in a single statement; returns how many
 * rows matched.
 */
export async function updatePoolStatuses(
  db: CartethyiaDatabase,
  tenantId: string,
  poolIds: readonly string[],
  status: NetworkPoolRecord["status"],
): Promise<number> {
  const rows = await db
    .update(networkPools)
    .set({ status })
    .where(
      and(
        eq(networkPools.tenantId, tenantId),
        inArray(networkPools.id, [...poolIds]),
      ),
    )
    .returning({ id: networkPools.id });
  return rows.length;
}

/** Deletes every named pool in one statement; returns how many rows matched. */
export async function deletePoolRows(
  db: CartethyiaDatabase,
  tenantId: string,
  poolIds: readonly string[],
): Promise<number> {
  const rows = await db
    .delete(networkPools)
    .where(
      and(
        eq(networkPools.tenantId, tenantId),
        inArray(networkPools.id, [...poolIds]),
      ),
    )
    .returning({ id: networkPools.id });
  return rows.length;
}

/** Deletes one pool; returns whether a row existed. */
export async function deletePoolRow(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<boolean> {
  const rows = await db
    .delete(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
    .returning({ id: networkPools.id });
  return rows.length > 0;
}

/** Updates one pool row; returns the updated row, or nothing when it did not exist. */
export async function updatePoolRow(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
  set: NetworkPoolUpdateSet,
): Promise<NetworkPoolRow | undefined> {
  const rows = await db
    .update(networkPools)
    .set(set)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
    .returning();
  return rows[0];
}

/** Updates one pool row by id alone; returns the updated row, or nothing when it did not exist. */
export async function updatePoolRowById(
  db: CartethyiaDatabase,
  poolId: string,
  set: NetworkPoolUpdateSet,
): Promise<NetworkPoolRow | undefined> {
  const rows = await db
    .update(networkPools)
    .set(set)
    .where(eq(networkPools.id, poolId))
    .returning();
  return rows[0];
}

/** Reads the tenant's routing-settings row, or nothing when never configured. */
export async function selectPoolStrategy(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<(typeof poolRoutingSettings.$inferSelect) | undefined> {
  const rows = await db
    .select()
    .from(poolRoutingSettings)
    .where(eq(poolRoutingSettings.tenantId, tenantId))
    .limit(1);
  return rows[0];
}

/** Upserts the tenant's single routing-settings row. */
export async function upsertPoolStrategy(
  db: CartethyiaDatabase,
  tenantId: string,
  setting: PoolStrategySetting,
): Promise<void> {
  await db
    .insert(poolRoutingSettings)
    .values({ tenantId, strategy: setting.strategy, rotateCount: setting.rotateCount })
    .onConflictDoUpdate({
      target: poolRoutingSettings.tenantId,
      set: { strategy: setting.strategy, rotateCount: setting.rotateCount },
    });
}
