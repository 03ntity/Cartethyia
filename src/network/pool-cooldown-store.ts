/**
 * The durable mirror of the pool selector's provider cooldown state.
 *
 * The selector's own map is process-local, mirrored to Redis only when Redis
 * exists — so the usual installation ran with the flags surviving just a
 * restart, while the upstream's refusal of the egress did not. The result was
 * the report that motivated this: no cooldown shown on the proxy page, and
 * still-429 requests, because dispatch re-picked a spent egress it no longer
 * remembered. `network_pools.provider_cooldowns` is that state's home between
 * boots: dispatch flaggers write each marker, boot reads them all back.
 *
 * One entry per cooling provider, keyed by the lowercased provider id — the
 * same normalization the selector applies to its in-memory key.
 */
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { networkPools, healthEvents } from "../persistence/schema";
import { log } from "../observability/logger";
import type { ProxyCooldownEntry } from "./pool/selector";

type PoolProviderCooldownMap = NonNullable<
  (typeof networkPools.$inferSelect)["providerCooldowns"]
>;

function readMarkerMap(
  db: CartethyiaDatabase,
  poolId: string,
): Promise<PoolProviderCooldownMap> {
  return db
    .select({ providerCooldowns: networkPools.providerCooldowns })
    .from(networkPools)
    .where(eq(networkPools.id, poolId))
    .limit(1)
    .then((rows) => rows[0]?.providerCooldowns ?? {});
}

function writeMarkerMap(
  db: CartethyiaDatabase,
  poolId: string,
  map: PoolProviderCooldownMap,
): Promise<unknown> {
  return db.update(networkPools).set({ providerCooldowns: map }).where(eq(networkPools.id, poolId));
}

function entryOf(marker: Omit<ProxyCooldownEntry, "poolId" | "providerId">): {
  until: number;
  reason: string;
  blocked?: boolean;
} {
  return marker.blocked === true
    ? { until: marker.until, reason: marker.reason, blocked: true }
    : { until: marker.until, reason: marker.reason };
}

/**
 * Writes up (or replaces) one provider's marker on the pool row.
 *
 * Fill-in, not replace: an entry for another cooling provider must survive.
 * Failures are logged and swallowed — the in-memory/Redis state stays
 * conservative for the running process, and only the *next* restart would miss
 * a flag this write failed to land.
 */
export async function upsertProviderCooldownMarker(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  marker: { until: number; reason: string; blocked?: boolean },
): Promise<void> {
  try {
    const key = providerId.toLowerCase();
    const map = await readMarkerMap(db, poolId);
    map[key] = entryOf(marker);
    await writeMarkerMap(db, poolId, map);
  } catch (error) {
    log.warn("pool provider cooldown mirror write failed", { networkPoolId: poolId, providerId, error: String(error) });
  }
}

/**
 * Removes one provider's marker, optionally only when it is a *block*.
 *
 * `onlyBlocked` mirrors `clearProviderBlockedOnly`: a probe that answered 429
 * may correct a retired claim but must not release a live cooldown, and the
 * same rule applies to the durable copy.
 */
export async function dropProviderCooldownMarker(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  onlyBlocked = false,
): Promise<void> {
  try {
    const key = providerId.toLowerCase();
    const map = await readMarkerMap(db, poolId);
    const current = map[key];
    if (current === undefined) return;
    if (onlyBlocked && current.blocked !== true) return;
    delete map[key];
    await writeMarkerMap(db, poolId, map);
  } catch (error) {
    log.warn("pool provider cooldown mirror clear failed", { networkPoolId: poolId, providerId, error: String(error) });
  }
}

/**
 * Removes every provider's marker from one pool row (disable/replace paths).
 */
export async function dropAllProviderCooldownMarkers(
  db: CartethyiaDatabase,
  poolId: string,
): Promise<void> {
  try {
    const map = await readMarkerMap(db, poolId);
    if (Object.keys(map).length === 0) return;
    await writeMarkerMap(db, poolId, {});
  } catch (error) {
    log.warn("pool provider cooldown mirror purge failed", { networkPoolId: poolId, error: String(error) });
  }
}

/**
 * Writes a probe-measured 429 the same way a dispatch-side 429 would be
 * recorded: one mirror marker and one `rate_limit_transient` audit row.
 *
 * The probe's 429 is a fresh measurement of "this egress is out of allowance"
 * — without this, an operator who tested a rate-limited pool saw "rate
 * limited" once, refreshing lost it, and the activity panel showed nothing:
 * the fact existed only in the remembered HTTP response.
 *
 * Not coalesced: a probe is operator-initiated and one row per click is the
 * visible history the panel exists for.
 */
export async function recordProbeCooldown(
  db: CartethyiaDatabase,
  poolId: string,
  providerId: string,
  marker: { until: number; reason: string },
): Promise<void> {
  await upsertProviderCooldownMarker(db, poolId, providerId, marker);
  try {
    await db.insert(healthEvents).values({
      entityKind: "pool",
      networkPoolId: poolId,
      fromStatus: null,
      toStatus: "cooldown",
      reason: `provider ${providerId}: ${marker.reason}`,
      errorCategory: "rate_limit_transient",
    });
  } catch (error) {
    log.warn("pool probe cooldown event failed", { networkPoolId: poolId, providerId, error: String(error) });
  }
}

/**
 * Reads every live marker back into the selector at boot.
 *
 * Only future-dated entries are restored: an expired marker describes an
 * allowance that refilled while the process was down, and resurrecting it
 * would sideline a working address. Repeat 429s re-insert markers, so nothing
 * is lost by dropping the expired ones.
 */
export async function restoreProviderCooldownMarkers(
  selector: { hydrateProviderCooldown(entry: ProxyCooldownEntry): void },
  db: CartethyiaDatabase,
): Promise<number> {
  const rows = await db
    .select({ id: networkPools.id, providerCooldowns: networkPools.providerCooldowns })
    .from(networkPools);
  let restored = 0;
  for (const row of rows) {
    const map = row.providerCooldowns;
    if (map === null || map === undefined) continue;
    for (const [providerId, marker] of Object.entries(map)) {
      if (Date.now() >= marker.until) continue;
      selector.hydrateProviderCooldown({
        poolId: row.id,
        providerId,
        until: marker.until,
        reason: marker.reason,
        ...(marker.blocked === true ? { blocked: true } : {}),
      });
      restored += 1;
    }
  }
  return restored;
}
