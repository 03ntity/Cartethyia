/**
 * A growth alert has to mean real growth.
 *
 * The watcher used to raise "Sustained memory growth" on ratio alone, which
 * produced a 2607% alert for a baseline jump: the window's oldest sample was
 * taken before an idle reclaim, so a gateway that had just given memory back
 * read as having leaked 27x in a minute. A ratio is also a poor leak signal on
 * its own — 20MiB to 24MiB is 20% and tells an operator nothing.
 *
 * These two cases pin the absolute-byte gate: a large ratio over a small delta
 * is silent, a large delta raises the alert.
 */
import { expect, test } from "bun:test";
import { memoryNotifications } from "../../src/console/updates/routes";

const MIB = 1024 * 1024;

/** Four monotonic samples one minute apart, from `from` bytes to `to` bytes. */
function rising(from: number, to: number) {
  return [0, 20_000, 40_000, 60_000].map((at, index) => ({
    at,
    rss: Math.round(from + ((to - from) * index) / 3),
    percent: 40,
  }));
}

test("a large ratio over a small delta raises no growth alert", () => {
  // 20MiB -> 24MiB is a 1.2 ratio and a 4MiB delta: the kind of startup
  // fluctuation or post-reclaim recovery that produced the misleading
  // percentage-based alerts.
  const result = memoryNotifications(rising(20 * MIB, 24 * MIB), { high: false, growth: false });
  expect(result.growth).toBe(false);
  expect(result.notifications.map((item) => item.kind)).toEqual([]);
});

test("a large absolute increase raises the growth alert", () => {
  const result = memoryNotifications(rising(150 * MIB, 400 * MIB), { high: false, growth: false });
  expect(result.growth).toBe(true);
  expect(result.notifications.map((item) => item.kind)).toEqual(["memory-growth"]);
});
