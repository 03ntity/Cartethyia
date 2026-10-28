import { resolvePackagePath } from "../../src/config/package-paths";
import { resolvePort } from "../../src/config/runtime";
import { ensureDrainToken, attachGateway, stopAttachedGateway, type RunningGateway } from "./instance";
import { startGateway } from "./gateway";
import { stopGateway } from "./gateway";
import { readInstalledVersion } from "./version";
import { reportTrayStartup } from "./startup-signal";
import { createTray } from "./tray/index";
import { openUrl } from "./background";
import { exportBackup, resetConsoleAccount } from "./admin";
import { acquireController, inheritedControllerHandoff } from "./controller";
import { restoreControllerAfterFailedHandoff } from "./controller";

/**
 * Runs the gateway with a tray icon. The tray is platform-specific (`tray/`):
 * on Windows it is a PowerShell NotifyIcon, because a Node tray library leaves
 * an empty console tab open for the tray's whole lifetime, and that window is
 * owned by Windows Terminal — not by this process, so it cannot be found and
 * hidden from inside.
 *
 * The gateway it starts is detached, which is what makes the health poll below
 * necessary — see {@link TRAY_HEALTH_POLL_MS}.
 */

/**
 * How often the tray asks whether the gateway is still answering.
 *
 * 10 s: often enough that an operator who stops the gateway by hand sees the
 * icon go away, and far below the cost of a request. A detached gateway can no
 * longer be waited on, so this poll is the only signal left.
 */
const TRAY_HEALTH_POLL_MS = 10_000;

/**
 * How long the gateway must be unreachable before the tray closes.
 *
 * A count of consecutive misses was the wrong shape: a gateway that is
 * answering, but slowly, misses every probe exactly like a gateway that is
 * gone. Under load — a large prompt, a synchronous GC — `/health` cannot
 * answer inside the probe timeout, so three polls in a row missed and the tray
 * closed itself while the gateway was still serving. `carte --tray` looked
 * fine only because it starts idle and never carries that load.
 *
 * Bounded by wall-clock instead: a gateway that is truly gone stops being
 * reachable immediately and stays that way, so it still closes the tray
 * promptly, while a gateway that is merely busy keeps answering often enough
 * to reset the clock. The window is long enough to span a request that runs
 * to the deadline.
 */
const TRAY_HEALTH_UNREACHABLE_BEFORE_CLOSE_MS = 120_000;

/**
 * How long one health probe waits before counting as a miss.
 *
 * Short probes are the other half of the same bug: `/health` is served by the
 * same process that is busy streaming a response, so a 2 s budget failed on a
 * busy gateway that was perfectly healthy. This is far longer than a healthy
 * answer takes and far shorter than the poll interval, so it cannot overlap
 * the next probe.
 */
const TRAY_HEALTH_PROBE_TIMEOUT_MS = 15_000;

export async function startTray(): Promise<void> {
  const handoff = inheritedControllerHandoff();
  const controller = acquireController("tray", handoff);
  const releaseController = (): void => controller.release();
  process.once("exit", releaseController);
  try {
    await runTray();
  } catch (error) {
    // Only a tray that never became ready restores the menu's lease. After a
    // successful handoff the tray owns the controller; restoring it on a later
    // normal exit would pin a controller record to the long-gone menu pid.
    if (handoff) restoreControllerAfterFailedHandoff(handoff);
    throw error;
  } finally {
    controller.release();
    process.removeListener("exit", releaseController);
  }
}

async function runTray(): Promise<void> {
  const port = resolvePort();
  const drainToken = ensureDrainToken();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const releasesUrl = "https://github.com/risunCodex/Cartethyia/releases";
  const currentVersion = await readInstalledVersion();

  let gateway: Bun.Subprocess | null = null;
  let adoptedGateway: RunningGateway | null = null;
  let closing = false;
  let resetArmed = false;
  let closePromise: Promise<void> | undefined;

  const tray = createTray({
    iconPath: resolvePackagePath(
      "scripts",
      "cli",
      "tray",
      "assets",
      process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
    ),
    tooltip: `Cartethyia ${currentVersion}`,
    items: [
      // Version row is informational; clicking it opens the releases page so
      // the operator can decide for themselves. No background check: the tray
      // used to poll the registry on open and the result was a cue the user
      // did not ask for.
      { kind: "action", id: "version", title: `Cartethyia ${currentVersion}`, enabled: true },
      { kind: "separator" },
      { kind: "action", id: "console", title: `Open Console \u00b7 ${dashboardUrl}` },
      { kind: "action", id: "reset", title: "Reset console password" },
      { kind: "action", id: "backup", title: "Backup" },
      { kind: "separator" },
      { kind: "action", id: "exit", title: "Exit" },
    ],
    onSelect: (id: string) => void handleSelect(id),
    onExit: () => void close(1),
  });

  const close = (exitCode = 0): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const current: Bun.Subprocess | null = gateway;
      gateway = null;
      if (current) await stopGateway(current, port, drainToken);
      else if (adoptedGateway !== null) await stopAttachedGateway(adoptedGateway, drainToken);
      await tray.close();
      process.exitCode = exitCode;
    })();
    return closePromise;
  };

  async function handleSelect(id: string): Promise<void> {
    if (closing) return;
    if (id === "exit") return void (await close());
    if (id === "console") return void (await openUrl(dashboardUrl));
    if (id === "version") return void (await openUrl(releasesUrl));
    if (id === "backup") {
      const result = await exportBackup(port, drainToken);
      if ("error" in result) {
        console.error(result.error);
      } else {
        console.log(
          `Backup written to ${result.path} (${(result.bytes / 1024).toFixed(1)} KiB). Telemetry is not included.`,
        );
      }
      return;
    }
    if (id === "reset") {
      // A tray click cannot ask for the typed confirmation the menu uses, so
      // the first click arms the action and the second one runs it.
      if (!resetArmed) {
        resetArmed = true;
        tray.update("reset", "Reset console password \u00b7 click again to delete", true);
        return;
      }
      resetArmed = false;
      tray.update("reset", "Reset console password", true);
      await resetConsoleAccount(port, drainToken);
      return;
    }
  }

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    await tray.ready();
    // Detached, unlike every other caller: the gateway must outlive this
    // process. Attached, it dies with the tray — and the tray dies with the
    // terminal that launched it, so closing that terminal took the gateway
    // down too and "Hide to tray" left nothing serving. `stopGateway` drains
    // over HTTP before it ever reaches for `kill()`, so detaching costs the
    // exit path nothing: the tray can still stop the gateway on Exit.
    adoptedGateway = await attachGateway(port, drainToken);
    if (adoptedGateway === null) {
      gateway = await startGateway(port, drainToken, { detached: true });
    } else {
      // The adopted gateway was started by the menu as a non-detached child of
      // the menu's console. When the menu exits — and especially when the
      // operator closes that terminal window afterwards — Windows delivers
      // CTRL_CLOSE to the whole console group and the gateway (handling
      // SIGTERM) shuts down with it: "Hide to tray" left nothing serving. The
      // menu cannot hand the same process off to another console, so re-cycle
      // it into a detached gateway now, before reporting ready, so the tray
      // owns a gateway that is not attached to any console after the handoff.
      await stopAttachedGateway(adoptedGateway, drainToken);
      adoptedGateway = null;
      gateway = await startGateway(port, drainToken, { detached: true });
    }
    // The launcher that spawned this tray is blocked on a signal file: it
    // cannot read our stdio, because the tray is detached. Without this write
    // it waits out its 60 s deadline and reports a failure for a tray that is
    // running fine.
    reportTrayStartup({ status: "ready", url: dashboardUrl });
    console.log(`Cartethyia is running at ${dashboardUrl}`);

    // The timestamp of the last probe the gateway actually answered, not a
    // miss counter: a busy gateway answers sometimes, and that must reset the
    // clock rather than being averaged away with its own silences.
    let lastSeenAliveAt = Date.now();
    // A detached child's `exited` never settles on Windows, so the old
    // `await current.exited` would have parked here forever and the tray would
    // never notice the gateway going away. Poll its health endpoint instead:
    // that answers for a process we no longer own, which is the whole point of
    // detaching it. The probe is the same one startup used, so a gateway that
    // is up reads as up regardless of who spawned it.
    while (!closing) {
      await Bun.sleep(TRAY_HEALTH_POLL_MS);
      if (closing || gateway === null && adoptedGateway === null) continue;
      const alive = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(TRAY_HEALTH_PROBE_TIMEOUT_MS),
      }).then((response) => response.ok).catch(() => false);
      if (alive) {
        lastSeenAliveAt = Date.now();
        continue;
      }
      // Only a gateway that has been unreachable for the whole window is
      // treated as gone. One slow answer inside it is enough to start over.
      if (Date.now() - lastSeenAliveAt < TRAY_HEALTH_UNREACHABLE_BEFORE_CLOSE_MS) continue;
      gateway = null;
      console.error("Cartethyia stopped answering; the tray is closing.");
      await close(1);
    }
  } catch (error) {
    await close(1);
    throw error;
  }
}
