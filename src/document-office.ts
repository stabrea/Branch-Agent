import { ZipReader, decodeEntities } from "./document-text.js";
import type { ReadTable } from "./document-readers.js";

/**
 * Word, spreadsheet and slide files, which are all folders of XML inside a zip. The reader keeps the
 * shape the person sees — headings, tables, sheets, slides and notes — because that shape is what a
 * citation points at later. Only entries inside the file itself are opened; a link, a picture from
 * the web or an embedded object is left alone, so reading a document never reaches the network.
 */
export interface ReadStructure { text: string; tables: ReadTable[]; limits: string[] }

/** The words of one XML element, entities decoded, tabs and breaks kept. */
export function runText(xml: string, tag: string): string {
  return decodeEntities([...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) => match[1] ?? "").join(""));
}
const strip = (xml: string): string => decodeEntities(xml.replace(/<[^>]*>/g, ""));
/** A Markdown heading of the level a document style asked for. */
const heading = (level: number, text: string): string => `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`;

/**
 * The top-level blocks of a Word body in the order they appear: paragraphs and tables. Tables can
 * hold paragraphs, so a table is taken whole, counting its own nesting, before the walk carries on.
 */
export function wordBlocks(body: string): { kind: "p" | "tbl"; xml: string }[] {
  const blocks: { kind: "p" | "tbl"; xml: string }[] = [];
  const opener = /<w:(p|tbl)(?=[\s/>])[^>]*?(\/?)>/g;
  for (let match = opener.exec(body); match && blocks.length < 20000; match = opener.exec(body)) {
    const kind = match[1] as "p" | "tbl";
    if (match[2] === "/") continue;
    const end = closingTag(body, `w:${kind}`, match.index + match[0].length);
    if (end < 0) continue;
    blocks.push({ kind, xml: body.slice(match.index, end) });
    opener.lastIndex = end;
  }
  return blocks;
}
/**
 * Where the element opened at `from` closes, counting elements of the same name opened inside it.
 * The name must be followed by a space, a slash or the closing bracket, so `<table:table-row>` is
 * never mistaken for another `<table:table>`.
 */
export function closingTag(xml: string, name: string, from: number): number {
  const both = new RegExp(`<${name}(?=[\\s/>])[^>]*?(/?)>|</${name}>`, "g");
  both.lastIndex = from;
  let depth = 0;
  for (let match = both.exec(xml); match; match = both.exec(xml)) {
    if (match[0].startsWith("</")) {
      if (depth === 0) return match.index + match[0].length;
      depth--;
    } else if (match[1] !== "/") depth++;
  }
  return -1;
}

/** One Word paragraph as a line, promoted to a Markdown heading when its style says it is one. */
function wordParagraph(xml: string): string {
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1] ?? "";
  const body = decodeEntities(xml.replace(/<w:tab\b[^>]*\/?>/g, "\t").replace(/<w:br\b[^>]*\/?>/g, "\n").replace(/<[^>]*>/g, ""));
  const text = body.replace(/[ \t]+/g, " ").trim();
  if (!text) return "";
  const level = /^Heading(\d)$/i.exec(style)?.[1];
  if (level) return heading(Number(level), text);
  return /^(Title|Subtitle)$/i.test(style) ? heading(style.toLowerCase() === "title" ? 1 : 2, text) : text;
}
/** One Word table as a grid of cells, rows in order. */
function wordTable(xml: string): string[][] {
  return [...xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
      .map((cell) => runText(cell[1] ?? "", "w:t").replace(/\s+/g, " ").trim()));
}
/** A grid written the way the passage-cutter reads a table: one row per line, tabs between cells. */
export const gridText = (grid: string[][]): string => grid.map((row) => row.join("\t")).join("\n");

/** A Word file: headings, paragraphs, tables and footnotes, in the order they are written. */
export function readDocx(bytes: Buffer): ReadStructure {
  const zip = new ZipReader(bytes);
  const document = zip.text("word/document.xml");
  if (!document) throw new Error("This Word file has no readable document part");
  const lines: string[] = [], tables: ReadTable[] = [];
  for (const block of wordBlocks(document)) {
    if (block.kind === "p") { const line = wordParagraph(block.xml); if (line) lines.push(line); continue; }
    const grid = wordTable(block.xml).filter((row) => row.some(Boolean));
    if (!grid.length) continue;
    tables.push({ name: `Table ${tables.length + 1}`, grid });
    lines.push(gridText(grid));
  }
  const notes = footnotes(zip);
  if (notes.length) lines.push(heading(2, "Footnotes"), ...notes);
  return { text: lines.join("\n\n"), tables, limits: [] };
}
function footnotes(zip: ZipReader): string[] {
  const xml = zip.text("word/footnotes.xml");
  if (!xml) return [];
  return [...xml.matchAll(/<w:footnote\b([^>]*)>([\s\S]*?)<\/w:footnote>/g)]
    .filter((note) => !/w:type="(separator|continuationSeparator)"/.test(note[1] ?? ""))
    .map((note) => runText(note[2] ?? "", "w:t").replace(/\s+/g, " ").trim())
    .filter(Boolean).map((text, index) => `[${index + 1}] ${text}`);
}

/** Which XML file holds each named sheet, read from the workbook and its relationship list. */
export function sheetFiles(zip: ZipReader): { name: string; path: string }[] {
  const workbook = zip.text("xl/workbook.xml");
  const relations = new Map([...zip.text("xl/_rels/workbook.xml.rels")
    .matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((row) => [row[1]!, row[2]!.replace(/^\/?(xl\/)?/, "")]));
  const sheets: { name: string; path: string }[] = [];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = decodeEntities(/name="([^"]*)"/.exec(sheet[0])?.[1] ?? `Sheet ${sheets.length + 1}`);
    const target = relations.get(/r:id="([^"]+)"/.exec(sheet[0])?.[1] ?? "");
    sheets.push({ name, path: `xl/${target ?? `worksheets/sheet${sheets.length + 1}.xml`}` });
  }
  if (!sheets.length) for (const path of zip.names().filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort())
    sheets.push({ name: `Sheet ${sheets.length + 1}`, path });
  return sheets.slice(0, 40);
}

/** Every `<t>` run of one shared string, so rich text keeps all of its words. */
function sharedList(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => runText(item[1] ?? "", "t"));
}
/** One sheet as a grid. A cell holding a formula gives the value the spreadsheet last worked out. */
export function sheetGrid(xml: string, strings: string[]): string[][] {
  const grid: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [...(row[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => cellValue(cell[1] ?? "", cell[2] ?? "", strings));
    if (cells.some((cell) => cell !== "")) grid.push(cells);
  }
  return grid;
}
function cellValue(attributes: string, body: string, strings: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
  if (type === "inlineStr") return runText(body, "t").trim();
  // `<v>` is the value the spreadsheet last worked out, which is what a formula cell is worth here.
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (type === "s") return strings[Number(value)] ?? "";
  return decodeEntities(value);
}
/** A spreadsheet: every sheet under its own heading, each row a line of tab-separated cells. */
export function readXlsx(bytes: Buffer): ReadStructure {
  const zip = new ZipReader(bytes);
  const strings = sharedList(zip.text("xl/sharedStrings.xml"));
  const parts: string[] = [], tables: ReadTable[] = [];
  for (const sheet of sheetFiles(zip)) {
    const grid = sheetGrid(zip.text(sheet.path), strings);
    if (!grid.length) continue;
    tables.push({ name: sheet.name, grid });
    parts.push(`${heading(2, `Sheet: ${sheet.name}`)}\n\n${gridText(grid)}`);
  }
  if (!parts.length) throw new Error("This spreadsheet has no readable cells");
  return { text: parts.join("\n\n"), tables, limits: [] };
}

/** The slide files in the order they are shown. */
const slidePaths = (zip: ZipReader): string[] =>
  zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b)).slice(0, 300);
const slideNumber = (path: string): number => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

/** One slide: the title shape first where there is one, then the rest of its words. */
function slideText(xml: string): { title: string; body: string[] } {
  const shapes = [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)].map((shape) => shape[1] ?? "");
  let title = "";
  const body: string[] = [];
  for (const shape of shapes) {
    const words = paragraphLines(shape);
    if (!words.length) continue;
    if (!title && /<p:ph\b[^>]*type="(ctrTitle|title)"/.test(shape)) { title = words.join(" "); continue; }
    body.push(...words);
  }
  if (!title && !body.length) body.push(...paragraphLines(xml));
  return { title, body };
}
/** The lines of a shape: one per `<a:p>`, with every text run inside it joined. */
function paragraphLines(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((paragraph) => runText(paragraph[1] ?? "", "a:t").replace(/\s+/g, " ").trim()).filter(Boolean);
}
/** A slide deck: each slide a numbered section with its title, its words and the speaker's notes. */
export function readPptx(bytes: Buffer): ReadStructure {
  const zip = new ZipReader(bytes);
  const paths = slidePaths(zip);
  if (!paths.length) throw new Error("This slide file has no readable slides");
  const parts = paths.map((path, index) => {
    const number = index + 1;
    const { title, body } = slideText(zip.text(path));
    const notes = paragraphLines(zip.text(`ppt/notesSlides/notesSlide${slideNumber(path)}.xml`));
    const lines = [heading(2, `Slide ${number}${title ? `: ${title}` : ""}`), ...body];
    if (notes.length) lines.push(`Notes: ${notes.join(" ")}`);
    return `[[page ${number}]]\n${lines.join("\n\n")}`;
  });
  return { text: parts.join("\n\n"), tables: [], limits: [] };
}
export { strip };
