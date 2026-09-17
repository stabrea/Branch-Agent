import type { Writable } from "node:stream";
import type { Frame } from "./terminal-screen.js";

/**
 * Writing frames to a terminal. The view is drawn on the terminal's second screen, so leaving puts
 * back exactly what was there before; only rows that changed are written again, each one whole,
 * so nothing wraps or scrolls on any terminal. The same escape sequences work in Windows Terminal,
 * the Windows console (PowerShell and cmd, which Node puts into VT mode), macOS Terminal, iTerm
 * and Linux terminals.
 */
export const ESC = {
  enter: "\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?2004h",
  leave: "\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l",
  mouseOn: "\x1b[?1000h\x1b[?1006h",
  mouseOff: "\x1b[?1006l\x1b[?1000l",
  clear: "\x1b[2J",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  at: (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`,
};

export class ScreenWriter {
  private last: string[] = [];
  private mouse = false;
  private entered = false;
  constructor(private readonly output: Writable) {}

  enter(title: string): void {
    this.entered = true;
    this.output.write(ESC.enter + title);
  }
  /** Asks for clicks and the wheel, or stops asking; a terminal that does not know the request ignores it. */
  setMouse(on: boolean): void {
    if (on === this.mouse || !this.entered) return;
    this.mouse = on;
    this.output.write(on ? ESC.mouseOn : ESC.mouseOff);
  }
  /** Forgets what is on screen, so the next frame is written whole (after a resize, or Ctrl+L). */
  invalidate(): void {
    this.last = [];
    if (this.entered) this.output.write(ESC.clear);
  }
  draw(frame: Frame): void {
    if (!this.entered) return;
    let out = ESC.hideCursor;
    frame.lines.forEach((line, row) => {
      if (this.last[row] === line) return;
      out += ESC.at(0, row) + line;
    });
    this.last = frame.lines;
    if (frame.cursor) out += ESC.at(frame.cursor.x, frame.cursor.y) + ESC.showCursor;
    this.output.write(out);
  }
  leave(extra = ""): void {
    if (!this.entered) return;
    this.entered = false;
    this.output.write((this.mouse ? ESC.mouseOff : "") + ESC.leave + extra);
    this.mouse = false;
  }
}
