/**
 * What this terminal can be asked to do, and the small pieces of screen drawing that go with it.
 * Everything is behind one switch: when the person sets NO_COLOR, or the terminal is a plain one
 * that does not understand escape sequences, nothing here writes a control character at all and
 * the terminal view prints ordinary lines.
 */
export interface TerminalStyle {
  /** Colour and bold. */
  color: boolean;
  /** Moving the cursor and clearing lines, which the sticky status line needs. */
  cursor: boolean;
  /** Setting the window title, and the Windows Terminal progress indicator. */
  decorations: boolean;
  columns: number;
  rows: number;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 1000 ? parsed : fallback;
};

/**
 * Whether stdout is a real terminal. `FORCE_TTY=1` is the way tests (and a person piping through
 * a pager on purpose) ask for the full view without a real terminal attached.
 */
export function looksInteractive(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.FORCE_TTY === "1") return true;
  if (env.FORCE_TTY === "0") return false;
  return isTTY === true;
}

/** What may be drawn on this terminal, from the environment alone. */
export function resolveStyle(
  env: NodeJS.ProcessEnv,
  size: { columns?: number | undefined; rows?: number | undefined } = {},
): TerminalStyle {
  const plain = env.NO_COLOR !== undefined || env.TERM === "dumb" || env.BRANCH_TUI_PLAIN === "1";
  return {
    color: !plain,
    cursor: !plain,
    decorations: !plain && env.BRANCH_TUI_DECORATIONS !== "0",
    columns: positiveInt(env.COLUMNS, size.columns ?? 80),
    rows: positiveInt(env.LINES, size.rows ?? 24),
  };
}

const codes: Record<string, string> = {
  dim: "\x1b[2m", bold: "\x1b[1m", reverse: "\x1b[7m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
/** Wraps text in one attribute, or returns it untouched when colour is off. */
export function paint(style: TerminalStyle, attribute: keyof typeof codes | string, text: string): string {
  const code = codes[attribute];
  return style.color && code ? `${code}${text}\x1b[0m` : text;
}

/** Sets the window title to the task in hand; nothing when decorations are off. */
export function windowTitle(style: TerminalStyle, title: string): string {
  if (!style.decorations) return "";
  return `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120)}\x07`;
}

/**
 * The Windows Terminal progress indicator (OSC 9;4): state 3 is an indeterminate spinner on the
 * taskbar, 2 is an error, 0 clears it. Terminals that do not know the sequence ignore it.
 */
export function progressIndicator(style: TerminalStyle, state: "working" | "error" | "none"): string {
  if (!style.decorations) return "";
  const value = state === "working" ? "3" : state === "error" ? "2" : "0";
  return `\x1b]9;4;${value};0\x07`;
}

/** Splits text into lines no wider than the terminal, breaking between words where it can. */
export function wrap(text: string, width: number): string[] {
  const limit = Math.max(4, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (!current.length) current = word;
      else if (current.length + 1 + word.length <= limit) current += " " + word;
      else { lines.push(current); current = word; }
      while (current.length > limit) { lines.push(current.slice(0, limit)); current = current.slice(limit); }
    }
    lines.push(current);
  }
  return lines;
}

/** Removes every escape sequence, so a test (or a log file) sees only the words. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
