/**
 * Disk housekeeping: measurement and reclaim.
 *
 * What is worth pinning is the safety boundary, because a reclaim that deletes
 * the wrong category is silent data loss. Hourly files are the only copy of
 * their requests until compaction folds them up, so the console refuses to
 * delete them; summaries past the retention window sit outside every query's
 * scan bound, so those are fair game.
 *
 * The telemetry directory is injected. The payload directory is not: reclaim
 * delegates to `prunePayloadFrames`, which resolves that path itself, so the
 * test overrides it through the same env var production uses rather than
 * pretending the two can be pointed apart.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TELEMETRY_DIR = await mkdtemp(join(tmpdir(), "carte-dm-events-"));
const PAYLOAD_DIR = await mkdtemp(join(tmpdir(), "carte-dm-payload-"));
const previousPayloadDir = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = PAYLOAD_DIR;

const { createDataManagementOperations } = await import(
  "../../src/console/data-management/operations"
);
const { PurgeNotWiredError } = await import(
  "../../src/console/data-management/contracts"
);
const { writePayloadFrame } = await import("../../src/observability/payload-store");
const OPS = createDataManagementOperations({
  telemetryDir: TELEMETRY_DIR,
  retentionDays: 30,
  payloadRetentionMs: async () => 15 * 60_000,
});

/** A UTC day offset from today, as `YYYY-MM-DD`. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

async function clear(): Promise<void> {
  for (const name of await readdir(TELEMETRY_DIR).catch(() => [])) {
    await rm(join(TELEMETRY_DIR, name), { force: true });
  }
  for (const name of await readdir(PAYLOAD_DIR).catch(() => [])) {
    await rm(join(PAYLOAD_DIR, name), { force: true });
  }
}

beforeEach(async () => {
  await mkdir(TELEMETRY_DIR, { recursive: true });
  await mkdir(PAYLOAD_DIR, { recursive: true });
  await clear();
});

afterAll(async () => {
  await clear();
  await rm(TELEMETRY_DIR, { recursive: true, force: true });
  await rm(PAYLOAD_DIR, { recursive: true, force: true });
  if (previousPayloadDir === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
  else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = previousPayloadDir;
});

describe("disk usage", () => {
  test("counts each category separately, not as one total", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "x".repeat(100));
    // `.jsonl`, matching `FRAME_FILE_SUFFIX`: the scanner matches the suffix the
    // writer actually uses, so a fixture named for an older extension is counted
    // as nothing and the payload bucket silently reads zero.
    await writeFile(join(PAYLOAD_DIR, "frame.jsonl"), "z".repeat(25));

    const usage = await OPS.usage(null);
    const byId = Object.fromEntries(usage.buckets.map((b) => [b.id, b]));

    expect(byId.telemetry_events?.bytes).toBe(100);
    expect(byId.telemetry_events?.files).toBe(1);
    expect(byId.payload_frames?.bytes).toBe(25);
    expect(usage.totalBytes).toBe(125);
  });

  test("retention reclaim targets raw event files, not an index", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(90)}.events.jsonl`), "y".repeat(64));
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(2)}.events.jsonl`), "y".repeat(32));

    const result = await OPS.reclaim("telemetry_retention");
    expect(result.deletedFiles).toBe(1);
    expect(result.reclaimedBytes).toBe(64);
    expect(await readdir(TELEMETRY_DIR)).toEqual([`${dayOffset(2)}.events.jsonl`]);
  });

  test("an empty install reports zeroes rather than failing", async () => {
    const usage = await OPS.usage(null);
    expect(usage.totalBytes).toBe(0);
    expect(usage.buckets.every((b) => b.files === 0)).toBe(true);
  });
});

describe("payload frames", () => {
  test("a live frame is not offered for reclaim", async () => {
    const recent = new Date(Date.now() - 60 * 60_000);
    await writePayloadFrame({ probe: true }, recent);
    const usage = await OPS.usage(null);
    const frames = usage.buckets.find((b) => b.id === "payload_frames");
    expect(frames?.files).toBe(1);
    expect(frames?.reclaimableFiles).toBe(0);
    expect(frames?.reclaimableBytes).toBe(0);
  });

  test("the window is the tenant's, not the deployment's", async () => {
    // The bug this pins: the panel resolved the payload window once at boot
    // from the deployment default, so a tenant that set Request detail window
    // to 60 minutes was still told "expiring 15 min after write" — and frames
    // the gateway held as live were counted reclaimable.
    const ops = createDataManagementOperations({
      telemetryDir: TELEMETRY_DIR,
      retentionDays: 30,
      payloadRetentionMs: async (tenantId) =>
        tenantId === "tenant-long" ? 60 * 60_000 : 15 * 60_000,
    });
    /*
     * The scan keys staleness off the file's mtime, so what the window is
     * compared against is when the file was written — the frame's own expiry
     * lives inside the file and only the prune reads it.
     */
    const file = join(PAYLOAD_DIR, "window.jsonl");
    await writeFile(file, "y".repeat(32));
    // 30 minutes old: past a 15-minute window, inside a 60-minute one.
    const stamp = new Date(Date.now() - 30 * 60_000);
    await utimes(file, stamp, stamp);

    const short = await ops.usage("tenant-short");
    const shortFrames = short.buckets.find((b) => b.id === "payload_frames");
    expect(shortFrames?.reclaimableFiles).toBe(1);
    expect(shortFrames?.note).toContain("15 min");

    const long = await ops.usage("tenant-long");
    const longFrames = long.buckets.find((b) => b.id === "payload_frames");
    expect(longFrames?.reclaimableFiles).toBe(0);
    expect(longFrames?.note).toContain("1 hour");
    await unlink(file);
  });

});

describe("reclaim", () => {
  test("removing past-retention raw logs leaves newer ones alone", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(90)}.events.jsonl`), "y".repeat(10));
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "y".repeat(20));

    const result = await OPS.reclaim("telemetry_retention");
    expect(result.deletedFiles).toBe(1);
    expect(result.reclaimedBytes).toBe(10);
    expect(result.action).toBe("telemetry_retention");
    expect(await readdir(TELEMETRY_DIR)).toHaveLength(1);
  });

  test("a reclaim never touches a category it was not asked about", async () => {
    await writeFile(join(TELEMETRY_DIR, `${dayOffset(1)}.events.jsonl`), "x".repeat(10));
    await OPS.reclaim("telemetry_retention");
    // An hourly file survives a retention reclaim even when nothing is pruned.
    expect(await readdir(TELEMETRY_DIR)).toHaveLength(1);
  });

  test("a file whose frames have all expired is dropped", async () => {
    // Written through the real frame writer: expiry lives inside the file, not
    // in its mtime, so a hand-made file would not exercise the rule this
    // reclaim depends on.
    await writePayloadFrame({ body: "expired" }, new Date(Date.now() - 1_000));
    const before = await readdir(PAYLOAD_DIR);
    expect(before.length).toBeGreaterThan(0);

    const result = await OPS.reclaim("payload_frames");
    expect(result.action).toBe("payload_frames");
    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(await readdir(PAYLOAD_DIR)).toHaveLength(0);
  });

  test("a file still holding a live frame is kept", async () => {
    // The load-bearing safety rule: frames are appended to one file, so the
    // file goes whole or not at all. Dropping it because an earlier frame in
    // it expired would take a payload whose row is still current.
    await writePayloadFrame({ body: "expired" }, new Date(Date.now() - 1_000));
    await writePayloadFrame({ body: "live" }, new Date(Date.now() + 60 * 60_000));

    const result = await OPS.reclaim("payload_frames");
    expect(result.deletedFiles).toBe(0);
    expect(await readdir(PAYLOAD_DIR)).toHaveLength(1);
  });
});

describe("the health & error log purge", () => {
  test("usage reports the row count, and purging clears the whole trail", async () => {
    const rows: string[] = [];
    const store = {
      count: async () => rows.length,
      purgeAll: async () => {
        const deleted = rows.length;
        rows.length = 0;
        return deleted;
      },
    };
    rows.push("one", "two", "three");
    const ops = createDataManagementOperations({
      telemetryDir: TELEMETRY_DIR,
      retentionDays: 30,
      payloadRetentionMs: async () => 15 * 60_000,
      healthEvents: store,
    });
    const usage = await ops.usage(null);
    expect(usage.healthEventCount).toBe(3);
    expect(await ops.purge("health_events")).toBe(3);
    const after = await ops.usage(null);
    expect(after.healthEventCount).toBe(0);
  });

  test("a composition without the health-event store refuses the purge", async () => {
    // The same reduced install that hides the control must not delete rows
    // through the raw route — the budget of the button is the budget of the
    // endpoint.
    await expect(OPS.purge("health_events")).rejects.toBeInstanceOf(PurgeNotWiredError);
  });

  test("usage omits the count rather than reporting zero when unwired", async () => {
    const usage = await OPS.usage(null);
    expect(usage.healthEventCount).toBeUndefined();
  });
});
