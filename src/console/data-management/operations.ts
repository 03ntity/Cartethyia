import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { payloadDirectory, prunePayloadFrames } from "../../observability/payload-store";
import { payloadPruneBound } from "../../observability/payload-capture";
import type {
  DiskUsageBucket,
  DiskUsageResponse,
  PurgeTarget,
  ReclaimAction,
  ReclaimResponse,
} from "./contracts";
import { PurgeNotWiredError, ReclaimNotAllowedError } from "./contracts";
import { hourStamp } from "../../shared/time";

/**
 * Reads and reclaims the on-disk telemetry and payload directories, and
 * purges the health & error log — the console's one row-level deletion.
 *
 * Reclaiming files is safe because the data is already past the point the
 * gateway would read it: payload frames expire minutes after they are written,
 * and telemetry past the retention window sits outside every query's scan
 * bound. The health & error log purge is the deliberate exception: the rows are
 * an operator's diagnostic trail that no request-path code reads, so clearing
 * them costs nothing but the history itself.
 *
 * The telemetry directory is injected rather than read from its module
 * constant so the scanner can be pointed at a fixture. The payload directory
 * is not: reclaim goes through `prunePayloadFrames`, which resolves the
 * directory itself, and a second path would let the two drift so the scanner
 * measured one place while the prune emptied another. The health-event store
 * hook is injected for the same reason: this module should know its numbers,
 * not how storage reaches them.
 */

export interface DataManagementConfig {
  readonly telemetryDir: string;
  readonly retentionDays: number;
  /**
   * How long a payload frame lives, for one tenant.
   *
   * A function of the tenant, not a number: the Request detail window in
   * Settings is per tenant, and a single deployment-level number made this
   * panel report the deployment default while the gateway applied the tenant's
   * own window. The same panel then offered to reclaim frames the gateway
   * still considered live, and left alone ones it had already expired.
   */
  readonly payloadRetentionMs: (tenantId: string | null) => Promise<number>;
  /**
   * The health & error log store, backing the console's only row-level purge.
   * Absent (a reduced console composition) means the purge is not offered
   * rather than failing to boot.
   */
  readonly healthEvents?:
    | {
        count(): Promise<number>;
        purgeAll(): Promise<number>;
      }
    | undefined;
}

interface Scan {
  readonly bytes: number;
  readonly files: number;
}

async function scan(
  directory: string,
  match: (name: string) => boolean,
  modifiedBefore?: number,
): Promise<Scan> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let bytes = 0;
  let files = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (modifiedBefore !== undefined && info.mtimeMs >= modifiedBefore) continue;
    bytes += info.size;
    files += 1;
  }
  return { bytes, files };
}

const isEventLog = (name: string): boolean =>
  name.endsWith(".jsonl") && !name.endsWith(".compacted.jsonl");
const isFrame = (name: string): boolean =>
  name.endsWith(".jsonl");

/**
 * A duration in minutes as the operator's own units, not raw milliseconds.
 *
 * An hour is "1 hour" rather than "60 min" because that is how the window was
 * chosen — the dropdown they picked it from says "1 hour", and a note that
 * renders the same choice as "60 min" makes the two screens disagree about
 * what was set.
 */
function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

/** The UTC day a telemetry file name starts with, compared to a cutoff. */
function eventBefore(name: string, cutoff: number): boolean {
  if (!name.endsWith(".events.jsonl")) {
    return name.slice(0, 13) < hourStamp(new Date(cutoff));
  }
  const at = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(at) && at < cutoff;
}

export function createDataManagementOperations(config: DataManagementConfig) {
  const payloadDir = (): string => payloadDirectory();
  /**
   * Disk usage for one tenant.
   *
   * `tenantId` is required because the payload window is a per-tenant setting:
   * counting "stale" frames against the deployment default declared frames
   * stale while the gateway still held them as live, and under-counted them
   * for a tenant that had shortened its window.
   */
  async function usage(tenantId: string | null): Promise<DiskUsageResponse> {
    const retentionMs = await config.payloadRetentionMs(tenantId);
    const payloadCutoff = Date.now() - retentionMs;

    const [events, frames, staleFrames, healthEventCount] = await Promise.all([
      scan(config.telemetryDir, isEventLog),
      scan(payloadDir(), isFrame),
      scan(payloadDir(), isFrame, payloadCutoff),
      config.healthEvents?.count(),
    ]);

    /*
     * The notes name the same knobs Operations exposes, read at request time
     * rather than written into the copy. A fixed "15 min" was wrong the moment
     * an operator changed the tenant's window: the panel kept quoting the
     * deployment default while the gateway applied their number, so the one
     * place that could correct the assumption repeated it.
     */
    const buckets: DiskUsageBucket[] = [
      {
        id: "telemetry_events",
        label: "Request event files",
        bytes: events.bytes,
        files: events.files,
        note: `Feeds the request list and detail drawer. Kept ${config.retentionDays} days.`,
        reclaimableBytes: null,
        reclaimableFiles: null,
      },
      {
        id: "payload_frames",
        label: "Payload frames",
        bytes: frames.bytes,
        files: frames.files,
        note: `Captured bodies, expiring ${formatMinutes(retentionMs)} after write.`,
        reclaimableBytes: staleFrames.bytes,
        reclaimableFiles: staleFrames.files,
      },
    ];

    return {
      buckets,
      totalBytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
      retentionDays: config.retentionDays,
      payloadRetentionMs: retentionMs,
      ...(healthEventCount === undefined ? {} : { healthEventCount }),
    };
  }

  async function reclaim(action: ReclaimAction): Promise<ReclaimResponse> {
    if (action === "payload_frames") {
      // Delegated rather than reimplemented: frame expiry lives inside each
      // file, so a file's mtime alone cannot say whether it still holds a live
      // frame. Measuring around the call is how the bytes are reported without
      // duplicating that rule.
      const before = await scan(payloadDir(), isFrame);
      // `before` is the expiry bound: a frame still live at this instant is
      // kept. The second argument covers files that cannot be parsed — one
      // written after that bound might still hold a live frame in the part
      // that failed to parse, so it is left for a later pass.
      const now = new Date();
      const deletedFiles = await prunePayloadFrames(now, payloadPruneBound(now));
      const after = await scan(payloadDir(), isFrame);
      return {
        action,
        deletedFiles,
        reclaimedBytes: Math.max(0, before.bytes - after.bytes),
      };
    }
    if (action === "telemetry_retention") {
      const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60_000;
      return unlinkWhere(action, config.telemetryDir, (name) =>
        isEventLog(name) && eventBefore(name, cutoff),
      );
    }
    throw new ReclaimNotAllowedError(`Unknown reclaim action: ${action}`);
  }

  /** The one row-level deletion the console offers. */
  async function purge(target: PurgeTarget): Promise<number> {
    switch (target) {
      case "health_events": {
        const store = config.healthEvents;
        if (store === undefined) throw new PurgeNotWiredError();
        return await store.purgeAll();
      }
    }
  }

  return { usage, reclaim, purge };
}

async function unlinkWhere(
  action: ReclaimAction,
  directory: string,
  match: (name: string) => boolean,
): Promise<ReclaimResponse> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let deletedFiles = 0;
  let reclaimedBytes = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(directory, name);
    // Measured before the unlink, since the size is gone afterwards.
    const size = await stat(path)
      .then((value) => value.size)
      .catch(() => 0);
    const removed = await unlink(path).then(
      () => true,
      () => false,
    );
    if (!removed) continue;
    deletedFiles += 1;
    reclaimedBytes += size;
  }
  // The response names the action, so a caller that fired two reclaims can
  // tell which result is which rather than both reading the same thing.
  return { action, deletedFiles, reclaimedBytes };
}
