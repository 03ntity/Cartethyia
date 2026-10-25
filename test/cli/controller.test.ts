import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireController, restoreControllerAfterFailedHandoff } from "../../scripts/cli/controller";

let configDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "carte-controller-test-"));
  originalConfigDir = process.env.CARTETHYIA_CONFIG_DIR;
  process.env.CARTETHYIA_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CARTETHYIA_CONFIG_DIR;
  else process.env.CARTETHYIA_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

test("a live menu or tray rejects a second interactive controller", () => {
  const first = acquireController("menu");
  expect(() => acquireController("menu")).toThrow("not starting another instance");
  expect(() => acquireController("tray")).toThrow("not starting another instance");
  first.release();
  const replacement = acquireController("tray");
  replacement.release();
});

test("a tray inherits the menu lock without a gap that another menu can enter", async () => {
  const menu = acquireController("menu");
  let output = "";
  let onReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => { onReady = resolve; });
  const holder = new Bun.Terminal({
    data: (_terminal, data) => {
      output += new TextDecoder().decode(data);
      if (output.includes("READY")) onReady();
    },
  });
  const child = Bun.spawn([process.execPath, "-e", `
    import { acquireController } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../scripts/cli/controller.ts")).href)};
    const lease = acquireController("tray", { token: process.env.CARTETHYIA_CONTROLLER_TOKEN, parentPid: Number(process.env.CARTETHYIA_CONTROLLER_PARENT_PID) });
    console.log("READY");
    await Bun.sleep(60_000);
    lease.release();
  `], {
    env: {
      ...process.env,
      CARTETHYIA_CONTROLLER_TOKEN: menu.handoff.token,
      CARTETHYIA_CONTROLLER_PARENT_PID: String(menu.handoff.parentPid),
    },
    terminal: holder,
  });
  try {
    await ready;
    expect(output).toContain("READY");
    expect(() => acquireController("menu")).toThrow("not starting another instance");
    menu.release();
    expect(() => acquireController("menu")).toThrow("not starting another instance");
  } finally {
    child.kill();
    await child.exited;
    holder.close();
    menu.release();
  }
});

test("a failed handoff is restored to the parent and can be released normally", () => {
  const menu = acquireController("menu");
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { acquireController } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../scripts/cli/controller.ts")).href)};
    acquireController("tray", { token: process.env.CARTETHYIA_CONTROLLER_TOKEN, parentPid: Number(process.env.CARTETHYIA_CONTROLLER_PARENT_PID) });
  `], {
    env: {
      ...process.env,
      CARTETHYIA_CONTROLLER_TOKEN: menu.handoff.token,
      CARTETHYIA_CONTROLLER_PARENT_PID: String(menu.handoff.parentPid),
    },
  });
  expect(child.exitCode).toBe(0);
  restoreControllerAfterFailedHandoff(menu.handoff);
  expect(() => acquireController("menu")).toThrow("not starting another instance");
  menu.release();
  acquireController("menu").release();
});
