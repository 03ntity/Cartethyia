import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import SysTray, { type MenuItem } from "systray2";
import { resolvePackagePath } from "../../../src/config/package-paths";

/**
 * A row as systray2 holds it. The helper numbers the rows itself and reports
 * that number back on a click and on an update, but it is absent from the
 * package's typings.
 */
type IdentifiedItem = MenuItem & { readonly __id?: number };

/**
 * One tray row. `action` rows report their id on click; separators are drawn
 * but never fire.
 */
export type TrayItem =
  | { readonly kind: "action"; readonly id: string; readonly title: string; readonly enabled?: boolean }
  | { readonly kind: "separator" };

export interface TrayOptions {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly items: readonly TrayItem[];
  readonly onSelect: (id: string) => void;
  readonly onExit: () => void;
}

export interface Tray {
  /** Resolves once the icon is on screen and clicks can arrive. */
  ready(): Promise<void>;
  /** Replaces the title and enabled state of an existing row. */
  update(id: string, title: string, enabled?: boolean): void;
  setTooltip(text: string): void;
  /** Removes the icon. Idempotent. */
  close(): Promise<void>;
}

/**
 * Windows tray: a PowerShell NotifyIcon driven over JSON lines.
 *
 * `systray2` on Windows leaves the spawning process attached to a console, so
 * Windows Terminal keeps an empty tab open for the tray's whole lifetime — the
 * window cannot be hidden from inside the process because it is owned by the
 * terminal, and `MainWindowHandle` reads 0 so it cannot be found and closed
 * either. A PowerShell NotifyIcon started with `-WindowStyle Hidden` owns no
 * console at all, which is the only arrangement that shows an icon and no
 * window.
 */
class WindowsTray implements Tray {
  readonly #process: ChildProcess;
  readonly #onSelect: (id: string) => void;
  readonly #onExit: () => void;
  readonly #index = new Map<string, number>();
  #ready: Promise<void>;
  #closed = false;

  constructor(options: TrayOptions) {
    this.#onSelect = options.onSelect;
    this.#onExit = options.onExit;

    this.#process = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-InputFormat",
        "Text",
        "-OutputFormat",
        "Text",
        "-File",
        resolvePackagePath("scripts", "cli", "tray", "windows.ps1"),
        "-IconPath",
        options.iconPath,
        "-Tooltip",
        options.tooltip,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#ready = promise;

    const lines = createInterface({ input: this.#process.stdout! });
    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event === null || typeof event !== "object" || !("type" in event)) return;
      if (event.type === "ready") {
        resolve();
        return;
      }
      if (event.type === "click" && "index" in event && typeof event.index === "number") {
        for (const [id, index] of this.#index) {
          if (index === event.index) {
            this.#onSelect(id);
            return;
          }
        }
      }
    });

    this.#process.once("error", reject);
    this.#process.once("exit", () => {
      if (!this.#closed) this.#onExit();
      reject(new Error("the tray process exited before it was ready"));
    });

    // Rows are added after "started": the script creates its NotifyIcon first
    // and would drop commands that arrive before it is listening.
    let index = 0;
    for (const item of options.items) {
      if (item.kind === "separator") {
        this.#send({ action: "add-separator", index });
        index += 1;
        continue;
      }
      this.#index.set(item.id, index);
      this.#send({ action: "add-item", index, title: item.title, enabled: item.enabled ?? true });
      index += 1;
    }
    this.#send({ action: "ready" });
  }

  #send(command: Record<string, unknown>): void {
    if (this.#closed || !this.#process.stdin?.writable) return;
    this.#process.stdin.write(`${JSON.stringify(command)}\n`, "utf8");
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  update(id: string, title: string, enabled = true): void {
    const index = this.#index.get(id);
    if (index === undefined) return;
    this.#send({ action: "update-item", index, title, enabled });
  }

  setTooltip(text: string): void {
    this.#send({ action: "set-tooltip", text });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#send({ action: "kill" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#process.kill();
        resolve();
      }, 1_500);
      this.#process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * macOS and Linux tray: `systray2` runs its own helper, and neither platform
 * attaches a console window to it, so the bundled tray is used as-is.
 *
 * Clicks arrive only through `onClick`; a menu built without a listener shows
 * every row and reports none of them, which is why the callbacks are wired
 * here rather than left to the default.
 */
class UnixTray implements Tray {
  readonly #tray: SysTray;
  readonly #onSelect: (id: string) => void;
  readonly #onExit: () => void;
  /** Row objects kept by reference: a click hands back the object, not the id. */
  readonly #items = new Map<string, IdentifiedItem>();
  #closed = false;

  constructor(options: TrayOptions) {
    this.#onSelect = options.onSelect;
    this.#onExit = options.onExit;
    const items = options.items.map((item) => {
      if (item.kind === "separator") return SysTray.separator;
      const menuItem: IdentifiedItem = {
        title: item.title,
        tooltip: item.title,
        enabled: item.enabled ?? true,
      };
      this.#items.set(item.id, menuItem);
      return menuItem;
    });
    this.#tray = new SysTray({
      menu: {
        icon: options.iconPath,
        title: "Cartethyia",
        tooltip: options.tooltip,
        items,
      },
      copyDir: true,
    });
  }

  async ready(): Promise<void> {
    await this.#tray.ready();
    // Registered after `ready()`: the helper process does not exist before
    // that, and `onExit` attaches to it directly.
    this.#tray.onExit(() => {
      if (!this.#closed) this.#onExit();
    });
    await this.#tray.onClick((action) => {
      for (const [id, item] of this.#items) {
        // Identity first: `onClick` merges the clicked row into the object this
        // class built, so a match needs no assumptions about the numbering.
        if (item === action.item || item.__id === action.__id) {
          this.#onSelect(id);
          return;
        }
      }
    });
  }

  update(id: string, title: string, enabled = true): void {
    const item = this.#items.get(id);
    // An update sent before the helper reports ready carries no row number, and
    // systray2 then rewrites the first row instead of this one.
    if (item?.__id === undefined) return;
    const next: IdentifiedItem = { title, tooltip: title, enabled, __id: item.__id };
    void this.#tray.sendAction({ type: "update-item", item: next });
  }

  setTooltip(text: string): void {
    // systray2 has no tooltip-only action; the tooltip travels with the title,
    // which `update()` already sends.
    void text;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const helper = this.#tray.process;
    // `kill()` settles on the helper's `exit` event, so a helper that already
    // exited would leave it pending forever and hang the shutdown after it.
    if (helper.exitCode !== null || helper.signalCode !== null) return;
    try {
      // `false`: systray2 otherwise calls `process.exit(0)` when the helper
      // exits, which discards the exit code this close was given.
      await this.#tray.kill(false);
    } catch {
      // The helper may already be gone.
    }
  }
}

/** Creates the tray for this platform. */
export function createTray(options: TrayOptions): Tray {
  return process.platform === "win32" ? new WindowsTray(options) : new UnixTray(options);
}
