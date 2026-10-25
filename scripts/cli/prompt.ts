import Enquirer from "enquirer";

/**
 * One row in a menu: an action the caller can run, or a rule between groups.
 * Rules are never selectable and are not included in the returned action index.
 */
export type MenuRow =
  | { readonly kind: "action"; readonly label: string; readonly hint?: string }
  | { readonly kind: "rule" };

/** Options for {@link chooseFromMenu}. Indices count actions, not rules. */
export interface MenuOptions {
  readonly initialIndex?: number;
  /** Short status retained below the menu after an action completes. */
  readonly status?: { readonly tone: "success" | "error"; readonly text: string };
}

interface MouseEvent {
  readonly button: number;
  readonly column: number;
  readonly row: number;
  readonly release: boolean;
}

const CURSOR_HOME = "\u001b[H";
const CLEAR_SCREEN = "\u001b[2J";
const CLEAR_LINE = "\u001b[2K";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";
const RESET = "\u001b[0m";
const MOUSE_PATTERN = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;

function parseMouseEvents(sequence: string): MouseEvent[] {
  return [...sequence.matchAll(MOUSE_PATTERN)].map((match) => ({
    button: Number(match[1]),
    column: Number(match[2]),
    row: Number(match[3]),
    release: match[4] === "m",
  }));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function plainText(value: string, width: number): string {
  return value.length <= width ? value : width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

/**
 * An interactive terminal menu with keyboard and xterm SGR mouse support.
 *
 * A single click focuses on press and activates on release over the same row,
 * matching ordinary desktop buttons. Terminals without mouse reporting retain
 * the complete arrow-key/Enter interface. stdin is restored even on Ctrl-C or
 * Esc so the caller can drain the gateway normally.
 */
export async function chooseFromMenu(
  header: string | readonly string[],
  rows: readonly MenuRow[],
  options: MenuOptions = {},
): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) return -1;

  const actionRows = rows.flatMap((row, rowIndex) => row.kind === "action" ? [rowIndex] : []);
  if (actionRows.length === 0) return -1;
  let selected = clamp(options.initialIndex ?? 0, 0, actionRows.length - 1);
  let pressedAction: number | null = null;
  let settled = false;
  let frameTop = 0;
  let menuWidth = 0;
  const color = output.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const paint = (code: string, value: string): string => color ? `\u001b[${code}m${value}${RESET}` : value;
  const muted = (value: string): string => paint("2;38;2;130;148;165", value);
  const accent = (value: string): string => paint("38;2;145;200;240", value);
  const selectedPaint = (value: string): string => paint("1;38;2;225;242;255;48;2;43;75;106", value);
  const status = options.status === undefined ? undefined : {
    ...options.status,
    text: options.status.text.replace(/\s+/g, " ").trim(),
  };

  const render = (): void => {
    const columns = Math.max(32, output.columns || 80);
    const labelWidth = Math.max(...rows.flatMap((row) => row.kind === "action" ? [row.label.length] : [0]));
    const contentWidth = Math.max(...rows.map((row) => row.kind === "rule"
      ? 24
      : labelWidth + (row.hint?.length ?? 0) + 7));
    const innerWidth = Math.min(contentWidth, columns - 4);
    menuWidth = innerWidth + 2;
    const lines = [accent(`╭─ Actions ${"─".repeat(Math.max(0, innerWidth - 10))}╮`)];

    rows.forEach((row, rowIndex) => {
      if (row.kind === "rule") {
        lines.push(muted(`│ ${"─".repeat(Math.max(0, innerWidth - 4))} │`));
        return;
      }
      const hintWidth = Math.max(0, innerWidth - labelWidth - 7);
      const hint = plainText(row.hint ?? "", hintWidth).padEnd(hintWidth);
      const isSelected = actionRows[selected] === rowIndex;
      const pointer = isSelected ? "❯" : " ";
      const text = ` ${pointer} ${row.label.padEnd(labelWidth)}  ${hint} `;
      const content = plainText(text, innerWidth).padEnd(innerWidth);
      lines.push(isSelected ? `│${selectedPaint(content)}│` : `│${content}│`);
    });
    lines.push(accent(`╰${"─".repeat(innerWidth)}╯`));
    if (status !== undefined) {
      const prefix = status.tone === "success" ? "✓ " : "✗ ";
      const text = plainText(`${prefix}${status.text}`, columns - 2);
      lines.push(paint(status.tone === "success" ? "38;2;135;205;160" : "38;2;240;145;145", text));
    }
    lines.push(muted("  ↑ ↓ navigate · Enter select · Click to open · Esc cancel"));

    const cursor = `\u001b[${frameTop};1H`;
    output.write(`${cursor}${lines.map((line) => `${CLEAR_LINE}${line}`).join("\n")}`);
  };

  const actionAtScreenPosition = (column: number, screenRow: number): number | null => {
    if (column < 1 || column > menuWidth) return null;
    const rowIndex = screenRow - frameTop - 1;
    if (rowIndex < 0 || rowIndex >= rows.length) return null;
    const actionIndex = actionRows.indexOf(rowIndex);
    return actionIndex < 0 ? null : actionIndex;
  };

  const headerLines = typeof header === "string" ? [header] : header;
  output.write(`${CLEAR_SCREEN}${CURSOR_HOME}`);
  for (const line of headerLines) output.write(`${line}\n`);
  output.write("\n");
  frameTop = headerLines.length + 2;
  output.write(HIDE_CURSOR + ENABLE_MOUSE);
  render();

  const wasRaw = input.isRaw;
  input.setEncoding("utf8");
  if (input.isTTY) input.setRawMode(true);
  input.resume();

  const onKeypress = (_sequence: string, key: { readonly name: string | undefined }): void => {
    if (key.name === "\u0003" || key.name === "escape") {
      finish(-1);
      return;
    }
    if (key.name === "up" || key.name === "k") move(-1);
    else if (key.name === "down" || key.name === "j") move(1);
    else if (key.name === "home") { selected = 0; render(); }
    else if (key.name === "end") { selected = actionRows.length - 1; render(); }
    else if (key.name === "return" || key.name === "enter" || key.name === "space") finish(selected);
  };
  const onMouseSequence = (sequence: string): void => {
    for (const mouse of parseMouseEvents(sequence)) {
      if ((mouse.button & 32) !== 0) continue;
      if ((mouse.button & 64) !== 0) {
        move((mouse.button & 1) === 0 ? -1 : 1);
        continue;
      }
      if ((mouse.button & 3) !== 0) continue;
      const actionIndex = actionAtScreenPosition(mouse.column, mouse.row);
      if (mouse.release) {
        if (pressedAction !== null && pressedAction === actionIndex) finish(actionIndex);
        pressedAction = null;
        continue;
      }
      pressedAction = actionIndex;
      if (actionIndex !== null && actionIndex !== selected) {
        selected = actionIndex;
        render();
      }
    }
  };
  let resolveMenu: (actionIndex: number) => void = () => undefined;
  const finish = (actionIndex: number): void => {
    if (settled) return;
    settled = true;
    resolveMenu(actionIndex);
  };
  const move = (delta: number): void => {
    selected = (selected + delta + actionRows.length) % actionRows.length;
    pressedAction = null;
    render();
  };
  // Keypress parsing also consumes mouse sequences, so mouse reporting owns
  // the data stream while this menu is active. Keyboard escape sequences are
  // decoded here as well instead of relying on two competing data listeners.
  let pendingInput = "";
  const onRawData = (chunk: Buffer | string): void => {
    pendingInput += String(chunk);
    const names: Record<string, string> = {
      "\u001b[A": "up", "\u001b[B": "down", "\u001b[H": "home", "\u001b[F": "end",
      "\u001bOA": "up", "\u001bOB": "down", "\u001bOH": "home", "\u001bOF": "end",
    };
    while (pendingInput.length > 0 && !settled) {
      if (pendingInput.startsWith("\u001b[<")) {
        const mouse = /^\u001b\[<\d+;\d+;\d+[Mm]/.exec(pendingInput);
        if (mouse === null) {
          if (pendingInput.length < 32) return;
          pendingInput = pendingInput.slice(1);
          continue;
        }
        onMouseSequence(mouse[0]);
        pendingInput = pendingInput.slice(mouse[0].length);
        continue;
      }
      if (pendingInput.startsWith("\u001b[") || pendingInput.startsWith("\u001bO")) {
        const sequence = Object.keys(names).find((candidate) => pendingInput.startsWith(candidate));
        if (sequence === undefined) {
          if (pendingInput.length < 3) return;
          pendingInput = pendingInput.slice(1);
          continue;
        }
        onKeypress(sequence, { name: names[sequence] });
        pendingInput = pendingInput.slice(sequence.length);
        continue;
      }
      if (pendingInput.startsWith("\r\n")) pendingInput = pendingInput.slice(1);
      const character = pendingInput[0]!;
      const name = character === "\r" || character === "\n" ? "return" : character === "\u001b" ? "escape" : character;
      onKeypress(character, { name });
      pendingInput = pendingInput.slice(1);
    }
  };

  try {
    input.on("data", onRawData);
    return await new Promise<number>((resolve) => {
      resolveMenu = resolve;
    });
  } finally {
    input.removeListener("data", onRawData);
    if (input.isTTY) input.setRawMode(wasRaw);
    // Always release the resumed stdin. A listener-less but flowing TTY keeps
    // the CLI alive after Hide to Tray or another terminal action completes.
    // The next menu resumes it explicitly, so preserving a flowing state here
    // provides no benefit and leaves the terminal looking stuck.
    input.pause();
    if (settled) output.write(`\n${DISABLE_MOUSE}${SHOW_CURSOR}${RESET}`);
    else output.write(`${CLEAR_SCREEN}${CURSOR_HOME}${DISABLE_MOUSE}${SHOW_CURSOR}${RESET}`);
  }
}

/** Asks the operator to type an exact word before a destructive action runs. */
export async function confirmByTyping(word: string, message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  try {
    const answer = await Enquirer.prompt<{ confirmation: string }>({
      type: "input",
      name: "confirmation",
      message: `${message} (type ${word})`,
      validate: (value: string) =>
        value.trim() === word ? true : `type ${word} exactly to confirm, or Ctrl-C to cancel`,
    });
    return answer.confirmation.trim() === word;
  } catch {
    return false;
  }
}

/** A yes/no gate for the step before the typed confirmation. */
export async function confirmStep(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  try {
    const answer = await Enquirer.prompt<{ proceed: boolean }>({
      type: "confirm",
      name: "proceed",
      message,
      initial: false,
    });
    return answer.proceed;
  } catch {
    return false;
  }
}
