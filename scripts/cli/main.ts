import { mkdirSync } from "node:fs";
import { resolveUserConfigDir } from "../../src/config/package-paths";
import { readRequiredBunVersion, assertBunVersion } from "./version";
import { printUpdateInstructions, runDetachedUpdate } from "./update";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();

const HELP = (minimumBunVersion: string) => `Cartethyia ${minimumBunVersion}+ (Bun is required)

Usage:
  carte                  start, then show an arrow-key menu (no GUI needed)
  carte --tray           start with a system-tray icon instead
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia stop
  cartethyia menu
  cartethyia doctor
  cartethyia admin reset-lockout <username> <clientIp>
  cartethyia admin reset-lockout --all
  cartethyia update

carte starts the gateway in the background and leaves only the console menu on
your terminal — Open Console, Reset password, Backup, Update, Hide to tray,
Exit. Arrow keys and Enter; no desktop environment needed, so it works over SSH
and headless. A menu started by this command drains its child gateway on Exit;
leaving a menu attached to an existing gateway only detaches. Use stop for that.
carte --tray uses a system-tray icon instead, which needs a graphical session.
Stop a detached gateway with cartethyia stop (or the install's ./carte stop).
Setup explains Lite (embedded SQLite) and Full (external PostgreSQL), then saves
configuration under the current user's Cartethyia config directory.
`;

/** Loads the user's `.env` into the environment without overriding it. */
async function loadUserConfig(): Promise<void> {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory could not be resolved");
  mkdirSync(configDir, { recursive: true });
  // Imported here rather than at module scope: `support/env` pulls in the
  // package-root resolver and `node:fs/promises`, and `carte --help` (which
  // never reads a .env) should not pay for either before it prints.
  const { ENV_PATH, readEnvFile } = await import("./env");
  // Bun injects PORT=12800 when no explicit port was supplied. It is a
  // runner default, not an operator override; without removing it, a saved
  // custom port is ignored by npm/carte and the gateway starts on 12800.
  // Preserve any non-default/custom shell value exactly as before.
  if (process.env.PORT === "12800") delete process.env.PORT;
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

/**
 * Reports tray readiness to the launcher waiting on a signal file.
 *
 * Deferred to a dynamic import for the same reason as `loadUserConfig`: only
 * the tray path writes this file, so the other commands should not load
 * `node:fs` machinery they never touch.
 */
async function reportTrayFailed(message: string): Promise<void> {
  const { reportTrayStartup } = await import("./startup-signal");
  reportTrayStartup({ status: "failed", message });
}

async function main(): Promise<void> {
  await assertBunVersion();
  const [command] = process.argv.slice(2);
  if (command === "setup" || command === "start" || command === "stop" || command === "tray" || command === "menu" || command === "doctor" || command === "admin") {
    await loadUserConfig();
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./setup");
      await setup();
      return;
    }
    case "start": {
      const { startForeground } = await import("./start");
      await startForeground();
      return;
    }
    case "stop": {
      const { resolvePort } = await import("../../src/config/runtime");
      const { ensureDrainToken, attachGateway, stopAttachedGateway } = await import("./instance");
      const port = resolvePort();
      const token = ensureDrainToken();
      const gateway = await attachGateway(port, token);
      if (!gateway) {
        console.log("No running Cartethyia gateway is owned by this installation.");
        return;
      }
      await stopAttachedGateway(gateway, token);
      console.log("Cartethyia stopped.");
      return;
    }
    case "menu": {
      const { startMenu } = await import("./console-menu");
      await startMenu();
      return;
    }
    case "tray": {
      const { startTray } = await import("./tray");
      await startTray();
      return;
    }
    case "autostart": {
      const { enableAutostart, disableAutostart, autostartStatus } = await import("./autostart");
      const arg = Bun.argv[3]?.trim();
      if (arg === "off" || arg === "disable") {
        const state = await disableAutostart();
        console.log(`Autostart disabled (${state.location || state.platform}).`);
        return;
      }
      if (arg === "status") {
        const state = autostartStatus();
        console.log(
          `Autostart: ${state.enabled ? "enabled" : "not enabled"} — ${state.location || state.platform}` +
            (state.reason ? ` (${state.reason})` : ""),
        );
        return;
      }
      // The tray is what autostart launches: a gateway alone has no session to
      // attach to and no icon to show.
      const state = await enableAutostart(process.execPath, [Bun.argv[1] ?? "carte", "tray"]);
      console.log(
        state.enabled
          ? `Autostart enabled — ${state.location}`
          : `Autostart not enabled: ${state.reason ?? "unknown reason"}`,
      );
      return;
    }
    case "doctor": {
      const { doctor } = await import("./doctor");
      await doctor();
      return;
    }
    case "admin": {
      if (process.argv[3] !== "reset-lockout") throw new Error("Usage: cartethyia admin reset-lockout <username> <clientIp> | --all");
      const { resetLockout } = await import("./admin");
      await resetLockout(process.argv.slice(4));
      return;
    }
    case "update":
      runDetachedUpdate();
      printUpdateInstructions("this install", null);
      return;
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP(await readRequiredBunVersion()));
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP(await readRequiredBunVersion())}`);
      process.exitCode = 2;
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  if (process.argv[2] === "tray") await reportTrayFailed(message);
  console.error(`Cartethyia failed: ${message}`);
  process.exitCode = 1;
});
