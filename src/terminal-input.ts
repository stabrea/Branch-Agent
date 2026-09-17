import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * The line a person is typing in the terminal view: one buffer that may hold several lines, a
 * cursor inside it, and the messages sent before. Node's readline decodes the keys; what each key
 * means is decided here, so Alt+Enter can add a line while Enter sends, and Ctrl+C can stop the
 * task in hand rather than the whole program.
 */
export interface LineEditorHandlers {
  submit(text: string): void;
  /** Ctrl+C: stop what is working now. */
  interrupt(): void;
  /** Ctrl+D: leave. */
  quit(): void;
  /** A key the view itself acts on, such as ctrl+e to show or hide the details of each step. */
  shortcut(name: string): void;
  /** The line changed and should be drawn again. */
  changed(): void;
  /**
   * Every key first goes here, so the view can use arrows, digits and Escape for moving around
   * when the person is not typing. Returning true means the key was used and the line ignores it.
   */
  key?(str: string | undefined, key: Key): boolean;
}
/** A click or a turn of the wheel, reported by terminals that were asked for them (SGR 1006). */
export interface MouseEvent { kind: "press" | "release" | "wheel-up" | "wheel-down"; x: number; y: number; button: number }

const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** Takes mouse reports out of what was typed, so they never reach the line as letters. */
export function takeMouse(text: string): { rest: string; events: MouseEvent[] } {
  const events: MouseEvent[] = [];
  const rest = text.replace(MOUSE, (_whole, code: string, x: string, y: string, end: string) => {
    const button = Number(code);
    const kind = button & 64 ? (button & 1 ? "wheel-down" : "wheel-up") : end === "M" ? "press" : "release";
    events.push({ kind, x: Number(x) - 1, y: Number(y) - 1, button: button & 3 });
    return "";
  });
  return { rest, events };
}

const printable = (str: string | undefined, key: Key): boolean =>
  typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta && str >= " " && str !== "\x7f";

/**
 * Escape pressed just before a control key (Escape then Ctrl+D, within half a second) reaches
 * readline as one unnamed sequence; it is two keys, and both are meant.
 */
function escapedControl(key: Key): Key | undefined {
  const sequence = key.sequence ?? "";
  if (key.name || sequence.length !== 2 || sequence[0] !== "\x1b" || sequence.charCodeAt(1) < 1 || sequence.charCodeAt(1) > 26) return undefined;
  return { name: String.fromCharCode(sequence.charCodeAt(1) + 96), ctrl: true, meta: false, shift: false, sequence: sequence[1]! };
}

export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private readonly sent: string[] = [];
  /** Where in the sent messages the up arrow has walked to; the length means "the line I typed". */
  private recall = 0;
  private draft = "";
  private detached: (() => void) | undefined;
  constructor(private readonly handlers: LineEditorHandlers) {}

  /** The text as it stands, and where the cursor sits inside it. */
  get text(): string { return this.buffer; }
  get at(): number { return this.cursor; }
  /** Everything sent so far, oldest first. */
  get history(): string[] { return [...this.sent]; }

  /**
   * Starts reading keys. Raw mode is only asked for when the stream really is a terminal. What
   * arrives is decoded as UTF-8 and has any mouse reports taken out before the keys are read.
   */
  attach(input: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean }, onMouse?: (event: MouseEvent) => void): void {
    const keys = new PassThrough();
    const decoder = new StringDecoder("utf8");
    const data = (chunk: Buffer | string): void => {
      const { rest, events } = takeMouse(typeof chunk === "string" ? chunk : decoder.write(chunk));
      for (const event of events) onMouse?.(event);
      if (rest) keys.write(rest);
    };
    emitKeypressEvents(keys);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
    const listener = (str: string | undefined, key: Key | undefined) => this.press(str, key ?? {});
    keys.on("keypress", listener);
    input.on("data", data);
    this.detached = () => {
      keys.off("keypress", listener);
      input.off("data", data);
      keys.end();
      if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(false);
      // Reading keys keeps the stream flowing and the program alive; let go of it completely, or
      // Ctrl+D would print a goodbye and then sit there with the terminal's own pipe still open.
      input.pause();
      (input as unknown as { unref?: () => void }).unref?.();
    };
  }
  detach(): void {
    this.detached?.();
    this.detached = undefined;
  }
  /** Empties the line without sending it. */
  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.recall = this.sent.length;
  }
  /** Puts text into the line as if it had been typed, for pasted or replayed input. */
  insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.handlers.changed();
  }

  private pasting = false;
  private press(str: string | undefined, key: Key): void {
    if (key.name === "paste-start") { this.pasting = true; return; }
    if (key.name === "paste-end") { this.pasting = false; return; }
    if (this.pasting) return this.pasted(str, key);
    const split = escapedControl(key);
    if (split) { this.press(undefined, { name: "escape", sequence: "\x1b" }); return this.press(undefined, split); }
    if (key.ctrl && key.name === "c") return this.handlers.interrupt();
    if (this.handlers.key?.(str, key)) return;
    if (key.ctrl && key.name === "d") return this.handlers.quit();
    if (key.ctrl && ["e", "r", "l"].includes(key.name ?? "")) return this.handlers.shortcut(`ctrl+${key.name}`);
    if (key.name === "return" || key.name === "enter") return this.enter(key);
    if (key.name === "up" || key.name === "down") return this.walk(key.name);
    if (key.name === "backspace") return this.erase(-1);
    if (key.name === "delete") return this.erase(1);
    if (key.name === "left" || key.name === "right") return this.move(key.name === "left" ? -1 : 1);
    if (key.name === "home") { this.cursor = 0; return this.handlers.changed(); }
    if (key.name === "end") { this.cursor = this.buffer.length; return this.handlers.changed(); }
    if (printable(str, key)) this.insert(str!);
  }
  /** A paste arrives as it was copied: its line breaks stay in the line rather than sending it. */
  private pasted(str: string | undefined, key: Key): void {
    if (key.name === "return" || key.name === "enter") return this.insert("\n");
    if (key.name === "tab") return this.insert("  ");
    if (printable(str, key)) this.insert(str!);
  }
  /** Enter sends the line; Alt+Enter (and Shift+Enter, where the terminal sends it) adds one. */
  private enter(key: Key): void {
    if (key.meta || key.shift) return this.insert("\n");
    const text = this.buffer;
    this.clear();
    if (text.trim()) {
      this.sent.push(text);
      this.recall = this.sent.length;
    }
    this.handlers.submit(text);
  }
  private walk(direction: "up" | "down"): void {
    if (!this.sent.length) return;
    if (direction === "up" && this.recall === this.sent.length) this.draft = this.buffer;
    const next = direction === "up" ? this.recall - 1 : this.recall + 1;
    if (next < 0 || next > this.sent.length) return;
    this.recall = next;
    this.buffer = next === this.sent.length ? this.draft : this.sent[next]!;
    this.cursor = this.buffer.length;
    this.handlers.changed();
  }
  private erase(direction: -1 | 1): void {
    const at = direction === -1 ? this.cursor - 1 : this.cursor;
    if (at < 0 || at >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, at) + this.buffer.slice(at + 1);
    this.cursor = at;
    this.handlers.changed();
  }
  private move(step: -1 | 1): void {
    const next = this.cursor + step;
    if (next < 0 || next > this.buffer.length) return;
    this.cursor = next;
    this.handlers.changed();
  }
}
