import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable } from "node:stream";

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
}

const printable = (str: string | undefined, key: Key): boolean =>
  typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta && str >= " " && str !== "\x7f";

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

  /** Starts reading keys. Raw mode is only asked for when the stream really is a terminal. */
  attach(input: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean }): void {
    emitKeypressEvents(input);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
    const listener = (str: string | undefined, key: Key | undefined) => this.press(str, key ?? {});
    input.on("keypress", listener);
    this.detached = () => {
      input.off("keypress", listener);
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

  private press(str: string | undefined, key: Key): void {
    if (key.ctrl && key.name === "c") return this.handlers.interrupt();
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
