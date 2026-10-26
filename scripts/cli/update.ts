/**
 * The update path.
 *
 * npm cannot replace this package's directory while a process is executing out
 * of it (EBUSY on Windows). So we spawn the installer as a detached process,
 * print a short notice, and exit — the installer runs after this process is gone.
 * After install, it attempts to restart the gateway (systemd if available, else
 * `cartethyia start`), so the new version comes up automatically.
 * Cross-OS: uses npm.cmd on Windows.
 */
import { spawn } from "node:child_process";

export function updateCommand(): string {
  return "npm install -g cartethyia@latest --prefer-online";
}

/**
 * Processes still running out of the package directory, so npm can rename it.
 *
 * The rename is the whole install on Windows, and it fails with EBUSY while
 * anything holds the directory — including a hold that outlives the process
 * that took it. `carte` itself runs from that directory, so the install has to
 * wait until this process is gone; these are the others.
 */
function stopHoldingProcesses(): void {
  if (process.platform !== "win32") return;
  // `taskkill` filters on the window title and image name only, so it is asked
  // for the two processes this CLI can leave behind. /T takes the tree, so a
  // detached gateway started by a tray goes with it.
  for (const image of ["cartethyia.exe", "carte.exe"]) {
    try {
      spawn("taskkill", ["/F", "/T", "/IM", image], { stdio: "ignore" }).unref();
    } catch {
      // A missing taskkill is not the install's problem; npm will report the
      // hold if one is left.
    }
  }
}

export function runDetachedUpdate(): void {
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const install = "npm install -g cartethyia@latest --prefer-online";
  const restart = isWin
    ? "cartethyia start"
    : "systemctl restart cartethyia 2>/dev/null || cartethyia start";
  const script = `${install} && ${restart}`;
  const args = isWin ? ["/c", script] : ["-c", script];
  stopHoldingProcesses();
  const child = spawn(shell, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function printUpdateInstructions(from: string, to: string | null): void {
  console.log("");
  console.log(`Update available: ${from} \u2192 ${to ?? "latest"}`);
  console.log("");
  // Names the one thing that actually breaks this install: npm cannot rename
  // the package directory while any process still holds it, and on Windows the
  // hold survives the process that took it — so a detached install that starts
  // before this one has let go fails with EBUSY and the version never changes.
  // The operator cannot fix that from inside the running CLI; they have to stop
  // running out of the directory being replaced.
  console.log("Detached update started; it installs in the background.");
  console.log("");
  console.log("Close this terminal, then run `carte` again.");
  console.log("The install needs this window closed: npm cannot replace the");
  console.log("package directory while a process is still running from it.");
  console.log("");
  console.log("If `carte` still shows the old version afterwards, run:");
  console.log(`  ${updateCommand()}`);
  console.log("");
}