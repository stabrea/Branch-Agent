import { colourCode, type ColorDepth, type PaletteRole, type Rgb, type TerminalPalette } from "./terminal-theme.js";

/**
 * A grid of character cells the terminal view draws into before anything is written out. Drawing
 * into a grid first keeps every frame exactly the window's size (nothing wraps, nothing scrolls),
 * lets the palette and Settings float over a place, and makes each frame a plain value a test can
 * compare. Colours are palette roles, or a colour worked out from the palette (the oak), never a
 * colour typed here.
 */
/** A colour between two palette colours, as the oak's shading needs; worked out when the frame is written. */
export interface Mix { from: PaletteRole; to: PaletteRole; amount: number }
export type Paint = PaletteRole | Rgb | Mix;
export interface CellStyle { fg?: Paint; bg?: Paint; bold?: boolean; underline?: boolean; dim?: boolean }
interface Cell { ch: string; width: number; fg: Paint; bg: Paint; bold: boolean; underline: boolean; dim: boolean }

/** How many columns one character takes: two for wide East Asian letters and most emoji, none for marks that join. */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}
/** The columns a piece of text takes. */
export const textWidth = (text: string): number => Array.from(text).reduce((sum, ch) => sum + charWidth(ch), 0);
/** Text cut to a number of columns, with the ellipsis given when something was cut. */
export function fitText(text: string, columns: number, ellipsis = "…"): string {
  if (columns <= 0) return "";
  if (textWidth(text) <= columns) return text;
  const room = columns - textWidth(ellipsis);
  let out = "", used = 0;
  for (const ch of text) {
    const width = charWidth(ch);
    if (used + width > room) break;
    out += ch;
    used += width;
  }
  return room > 0 ? out + ellipsis : out.slice(0, columns);
}

/** A place on the frame a click means something, and what it means ("place:2", "row:4"). */
export interface Hit { x: number; y: number; width: number; height: number; action: string }

export class Canvas {
  private readonly cells: Cell[][];
  readonly hits: Hit[] = [];
  hit(x: number, y: number, width: number, height: number, action: string): void {
    this.hits.push({ x, y, width, height, action });
  }
  constructor(readonly columns: number, readonly rows: number, ground: Paint = "ground") {
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => blank(ground, "text")));
  }
  /** Writes text from a column; returns the column after it. Nothing is drawn past `limit`. */
  text(x: number, y: number, text: string, style: CellStyle = {}, limit = this.columns): number {
    if (y < 0 || y >= this.rows) return x;
    let column = x;
    const end = Math.min(limit, this.columns);
    for (const ch of text.replace(/[\x00-\x1f\x7f]/g, " ")) {
      const width = charWidth(ch);
      if (width === 0) continue;
      if (column + width > end) break;
      if (column >= 0) this.put(column, y, ch, width, style);
      column += width;
    }
    return column;
  }
  private put(x: number, y: number, ch: string, width: number, style: CellStyle): void {
    const row = this.cells[y]!, under = row[x]!;
    row[x] = { ch, width, fg: style.fg ?? under.fg, bg: style.bg ?? under.bg, bold: !!style.bold, underline: !!style.underline, dim: !!style.dim };
    if (width === 2 && x + 1 < this.columns) row[x + 1] = { ...row[x]!, ch: "", width: 0 };
    if (x > 0 && row[x - 1]!.width === 2) row[x - 1] = blank(row[x - 1]!.bg, row[x - 1]!.fg);
  }
  /** Paints a rectangle's background and clears what was in it. */
  fill(x: number, y: number, width: number, height: number, bg: Paint): void {
    for (let row = Math.max(0, y); row < Math.min(this.rows, y + height); row++)
      for (let column = Math.max(0, x); column < Math.min(this.columns, x + width); column++)
        this.cells[row]![column] = blank(bg, "text");
  }
  /** Changes the look of cells already drawn, as a selection highlight does. */
  restyle(x: number, y: number, width: number, style: CellStyle): void {
    if (y < 0 || y >= this.rows) return;
    for (let column = Math.max(0, x); column < Math.min(this.columns, x + width); column++) {
      const cell = this.cells[y]![column]!;
      this.cells[y]![column] = { ...cell, ...(style.bg ? { bg: style.bg } : {}), ...(style.fg ? { fg: style.fg } : {}),
        ...(style.bold !== undefined ? { bold: style.bold } : {}) };
    }
  }
  /** One colour pair as two stacked half-cells, which is how the oak gets twice the height. */
  halfBlock(x: number, y: number, top: Paint, bottom: Paint, glyph: string): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows || !glyph) return;
    this.cells[y]![x] = { ch: glyph, width: 1, fg: top, bg: bottom, bold: false, underline: false, dim: false };
  }
  /** The frame as words only, one string per row, for tests and screen readers. */
  plain(): string[] {
    return this.cells.map((row) => row.map((cell) => cell.ch === "" ? "" : cell.ch).join("").replace(/\s+$/, ""));
  }
  /** The frame as a terminal draws it, one string per row, at this colour depth. */
  lines(palette: TerminalPalette, depth: ColorDepth): string[] {
    return this.cells.map((row) => serializeRow(row, palette, depth));
  }
}
const blank = (bg: Paint, fg: Paint): Cell => ({ ch: " ", width: 1, fg, bg, bold: false, underline: false, dim: false });

function rgbOf(palette: TerminalPalette, paint: Paint): Rgb {
  if (typeof paint === "string") return palette[paint];
  if (!("from" in paint)) return paint;
  const from = palette[paint.from], to = palette[paint.to];
  return from.map((value, index) => Math.round(value + (to[index]! - value) * paint.amount)) as unknown as Rgb;
}
/** On sixteen colours the terminal's own background stands in for the ground and the panes. */
const QUIET_GROUNDS = new Set<Paint>(["ground", "panel"]);
const RAISED = new Set<Paint>(["raised", "accentTint"]);
function sgr(cell: Cell, palette: TerminalPalette, depth: ColorDepth): string {
  if (depth === "none") return "";
  const parts = ["0"];
  if (cell.bold) parts.push("1");
  if (cell.dim) parts.push("2");
  if (cell.underline) parts.push("4");
  if (depth === "ansi16" && RAISED.has(cell.bg)) parts.push("7");
  else if (!(depth === "ansi16" && QUIET_GROUNDS.has(cell.bg))) parts.push(colourCode(depth, rgbOf(palette, cell.bg), "bg"));
  parts.push(depth === "ansi16" ? foreground16(cell, palette) : colourCode(depth, rgbOf(palette, cell.fg), "fg"));
  return `\x1b[${parts.join(";")}m`;
}
/**
 * On sixteen colours the terminal's own text colour is used for words, so a light theme on a dark
 * terminal (or the other way round) never writes dark words on a dark background.
 */
function foreground16(cell: Cell, palette: TerminalPalette): string {
  if (cell.fg === "text" || cell.fg === "muted") return cell.fg === "muted" ? "39;2" : "39";
  if (cell.fg === "faint" || cell.fg === "line") return "90";
  if (cell.fg === "ground" && QUIET_GROUNDS.has(cell.bg)) return "39";
  return colourCode("ansi16", rgbOf(palette, cell.fg), "fg");
}
function serializeRow(row: Cell[], palette: TerminalPalette, depth: ColorDepth): string {
  let out = "", last = "";
  for (const cell of row) {
    if (cell.width === 0) continue;
    const code = sgr(cell, palette, depth);
    if (code !== last) { out += code; last = code; }
    out += cell.ch;
  }
  return depth === "none" ? out : out + "\x1b[0m";
}
