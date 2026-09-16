import { ZipReader, decodeEntities, htmlText } from "./document-text.js";
import { closingTag, gridText, type ReadStructure } from "./document-office.js";
import type { ReadTable } from "./document-readers.js";

/**
 * The open formats: the OpenDocument text and spreadsheet files a free office suite writes, the
 * e-book format, and rich text. All but rich text are zips of XML, read the same careful way as the
 * Microsoft formats — only entries inside the file itself, never an address the file points at.
 */
const clean = (text: string): string => decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/[ \t]+/g, " ").trim();
const heading = (level: number, text: string): string => `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`;

/** An OpenDocument text file: headings at the level it gives them, paragraphs, and tables. */
export function readOdt(bytes: Buffer): ReadStructure {
  const content = new ZipReader(bytes).text("content.xml");
  if (!content) throw new Error("This document has no readable content part");
  const body = /<office:body\b[^>]*>([\s\S]*)<\/office:body>/.exec(content)?.[1] ?? content;
  const lines: string[] = [], tables: ReadTable[] = [];
  const opener = /<(text:h|text:p|table:table)(?=[\s/>])([^>]*?)(\/?)>/g;
  for (let match = opener.exec(body); match && lines.length < 20000; match = opener.exec(body)) {
    if (match[3] === "/") continue;
    const end = closingTag(body, match[1]!, match.index + match[0].length);
    if (end < 0) continue;
    const xml = body.slice(match.index, end);
    opener.lastIndex = end;
    if (match[1] === "table:table") {
      const grid = odfRows(xml);
      if (!grid.length) continue;
      tables.push({ name: decodeEntities(/table:name="([^"]*)"/.exec(match[2] ?? "")?.[1] ?? `Table ${tables.length + 1}`), grid });
      lines.push(gridText(grid));
      continue;
    }
    const text = clean(xml);
    if (!text) continue;
    lines.push(match[1] === "text:h" ? heading(Number(/text:outline-level="(\d)"/.exec(match[2] ?? "")?.[1] ?? 1), text) : text);
  }
  return { text: lines.join("\n\n"), tables, limits: [] };
}
/** The rows of one OpenDocument table; a repeated cell is written out as many times as it repeats. */
export function odfRows(xml: string): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? "").matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
      const repeat = Math.min(Number(/number-columns-repeated="(\d+)"/.exec(cell[1] ?? "")?.[1] ?? 1), 64);
      for (let at = 0; at < repeat; at++) cells.push(clean(cell[2] ?? ""));
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}
/** An OpenDocument spreadsheet: every sheet under its own heading, one line per row. */
export function readOds(bytes: Buffer): ReadStructure {
  const content = new ZipReader(bytes).text("content.xml");
  if (!content) throw new Error("This spreadsheet has no readable content part");
  const parts: string[] = [], tables: ReadTable[] = [];
  for (const sheet of content.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const grid = odfRows(sheet[2] ?? "");
    if (!grid.length) continue;
    const name = decodeEntities(/table:name="([^"]*)"/.exec(sheet[1] ?? "")?.[1] ?? `Sheet ${tables.length + 1}`);
    tables.push({ name, grid });
    parts.push(`${heading(2, `Sheet: ${name}`)}\n\n${gridText(grid)}`);
  }
  if (!parts.length) throw new Error("This spreadsheet has no readable cells");
  return { text: parts.join("\n\n"), tables, limits: [] };
}

/** A path inside the book, resolved against the folder its list lives in and kept inside the file. */
export function insideBook(base: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const parts = [...base.split("/").slice(0, -1), ...decodeURIComponent(href.split("#")[0] ?? "").split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!resolved.pop()) return null; continue; }
    resolved.push(part);
  }
  return resolved.length ? resolved.join("/") : null;
}
/** An e-book: its chapters in reading order, each under a heading taken from the chapter itself. */
export function readEpub(bytes: Buffer): ReadStructure {
  const zip = new ZipReader(bytes);
  const opfPath = /full-path="([^"]+)"/.exec(zip.text("META-INF/container.xml"))?.[1]
    ?? zip.names().find((name) => name.endsWith(".opf"));
  if (!opfPath) throw new Error("This e-book has no list of its chapters");
  const opf = zip.text(opfPath);
  const items = new Map([...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)].map((row) => [row[1]!, row[2]!]));
  const order = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((row) => items.get(row[1]!) ?? "");
  const hrefs = (order.filter(Boolean).length ? order : [...items.values()]).slice(0, 400);
  const parts: string[] = [];
  for (const href of hrefs) {
    const path = insideBook(opfPath, href);
    const html = path ? zip.text(path) : "";
    if (!html) continue;
    const text = htmlText(html);
    if (!text.trim()) continue;
    parts.push(`${heading(2, chapterTitle(html, parts.length + 1))}\n\n${text}`);
  }
  if (!parts.length) throw new Error("This e-book has no readable chapters");
  return { text: parts.join("\n\n"), tables: [], limits: [] };
}
const chapterTitle = (html: string, number: number): string =>
  clean(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/.exec(html)?.[1] ?? /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "")
    || `Chapter ${number}`;

/** Rich text: the words, with the instructions that set the type dropped. */
export function readRtf(bytes: Buffer): ReadStructure {
  const source = bytes.toString("latin1");
  if (!source.startsWith("{\\rt")) throw new Error("That file is not rich text");
  // Groups marked `\*` hold things the reader is meant to ignore when it does not understand them.
  const body = source.replace(/\{\\\*[\s\S]*?\}/g, " ");
  const text = body
    .replace(/\\'([0-9a-fA-F]{2})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_whole, code: string) => String.fromCodePoint((Number(code) + 65536) % 65536))
    .replace(/\\(par|line)\b\s?/g, "\n").replace(/\\tab\b\s?/g, "\t")
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "").replace(/[{}]/g, "")
    .replace(/\\([\\{}])/g, "$1");
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  if (!lines.length) throw new Error("This rich text file has no words in it");
  return { text: lines.join("\n\n"), tables: [], limits: [] };
}
