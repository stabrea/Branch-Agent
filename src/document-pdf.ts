import { inflateSync } from "node:zlib";

/**
 * Reading the words out of a PDF without asking anything else to help. A PDF is a bag of numbered
 * objects; the pages point at streams of drawing instructions, and the instructions that draw text
 * say which piece of text goes where. This finds the objects, unpacks the compressed ones, follows
 * the page tree, and turns each page's drawing instructions back into lines by where they sat on
 * the page. Nothing in the file is executed and no address inside it is ever fetched.
 *
 * What it cannot do is said plainly rather than guessed at: a PDF locked with a password is
 * refused, a PDF that is pictures of text reports that it is pictures, and a stream packed in a way
 * this reader does not unpack is listed as a part that could not be read.
 */
export class PdfLocked extends Error {}
export interface PdfPage { page: number; text: string }
export interface PdfText {
  pages: PdfPage[];
  /** True when the file has pages but none of them draw any text: it is pictures of text. */
  pictures: boolean;
  /** Parts that could not be read, in plain language, for the "what could not be read" list. */
  limits: string[];
}
/** How much of one PDF is worth walking; a larger file is read this far and says it was cut short. */
export const pdfByteLimit = 24 * 1024 * 1024;
const maxPages = 500;
const maxObjects = 20000;

interface RawObject { number: number; body: Buffer; stream: Buffer | null }

/** Latin-1 view of a slice, which is how PDF names and keywords are written. */
const latin = (bytes: Buffer): string => bytes.toString("latin1");

/**
 * Every `N G obj … endobj` in the file, found by scanning rather than by trusting the cross
 * reference table, so a file whose table is damaged or written in the newer packed form still
 * reads. Objects held inside a packed object stream are unpacked afterwards.
 */
function scanObjects(data: Buffer): Map<number, RawObject> {
  const found = new Map<number, RawObject>();
  const text = latin(data);
  const header = /(\d{1,9})\s+(\d{1,5})\s+obj\b/g;
  for (let match = header.exec(text); match && found.size < maxObjects; match = header.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) continue;
    const body = data.subarray(start, end);
    found.set(Number(match[1]), { number: Number(match[1]), body, stream: streamOf(data, text, start, end) });
  }
  return found;
}
/** The bytes between `stream` and `endstream`, kept raw; unpacking happens when they are used. */
function streamOf(data: Buffer, text: string, start: number, end: number): Buffer | null {
  const at = text.indexOf("stream", start);
  if (at < 0 || at > end) return null;
  let from = at + 6;
  if (text[from] === "\r") from++;
  if (text[from] === "\n") from++;
  const stop = text.indexOf("endstream", from);
  return stop < 0 || stop > end + 16 ? null : data.subarray(from, stop);
}

/** A dictionary entry's raw text, for simple values: `/Key value` up to the next key or bracket. */
export function dictValue(dictionary: string, key: string): string | null {
  const at = dictionary.indexOf(`/${key}`);
  if (at < 0) return null;
  const rest = dictionary.slice(at + key.length + 1);
  const value = /^\s*(\[[^\]]*\]|<<[\s\S]*?>>|\/[^\s/<>[\]()]+|[-\d.]+\s+\d+\s+R|[-\d.]+|\([^)]*\))/.exec(rest);
  return value ? value[1]!.trim() : null;
}
/** The object number a `12 0 R` reference points at, or null when the value is not a reference. */
const referenceNumber = (value: string | null): number | null => {
  const match = value ? /^(\d+)\s+\d+\s+R$/.exec(value) : null;
  return match ? Number(match[1]) : null;
};

/** Unpacks one stream. Only the packing this reader understands is unpacked; the rest is refused. */
function unpack(object: RawObject): { bytes: Buffer | null; limit: string } {
  if (!object.stream) return { bytes: null, limit: "" };
  const filter = dictValue(latin(object.body), "Filter") ?? "";
  if (!filter || filter === "[]") return { bytes: object.stream, limit: "" };
  if (!filter.includes("FlateDecode"))
    return { bytes: null, limit: `Part of this PDF is packed as ${filter.replace(/[/[\]]/g, "")}, which this reader does not unpack.` };
  try { return { bytes: inflateSync(object.stream), limit: "" }; }
  catch { return { bytes: null, limit: "Part of this PDF is packed in a way that would not unpack." }; }
}

/** Objects that were packed inside another object, added to the set under their own numbers. */
function expandPacked(objects: Map<number, RawObject>): string[] {
  const limits: string[] = [];
  for (const object of [...objects.values()]) {
    const dictionary = latin(object.body);
    if (!dictionary.includes("/ObjStm")) continue;
    const { bytes, limit } = unpack(object);
    if (limit) limits.push(limit);
    if (!bytes) continue;
    const count = Number(dictValue(dictionary, "N") ?? 0), first = Number(dictValue(dictionary, "First") ?? 0);
    const header = latin(bytes.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let index = 0; index < Math.min(count, 5000); index++) {
      const number = header[index * 2], offset = header[index * 2 + 1];
      if (number === undefined || offset === undefined || objects.has(number)) continue;
      const next = header[index * 2 + 3];
      objects.set(number, { number, body: bytes.subarray(first + offset, first + (next ?? bytes.length - first)), stream: null });
    }
  }
  return [...new Set(limits)];
}

/** The page objects in reading order, walked down from the catalogue's page tree. */
function pagesInOrder(objects: Map<number, RawObject>): RawObject[] {
  const root = [...objects.values()].find((object) => latin(object.body).includes("/Type") && latin(object.body).includes("/Catalog"));
  const top = root ? referenceNumber(dictValue(latin(root.body), "Pages")) : null;
  const ordered: RawObject[] = [];
  if (top !== null) walkPages(objects, top, ordered, new Set(), 0);
  if (ordered.length) return ordered.slice(0, maxPages);
  return [...objects.values()]
    .filter((object) => /\/Type\s*\/Page[^s]/.test(latin(object.body)))
    .sort((a, b) => a.number - b.number).slice(0, maxPages);
}
function walkPages(objects: Map<number, RawObject>, number: number, into: RawObject[], seen: Set<number>, depth: number): void {
  if (depth > 32 || seen.has(number) || into.length >= maxPages) return;
  seen.add(number);
  const object = objects.get(number);
  if (!object) return;
  const dictionary = latin(object.body);
  if (/\/Type\s*\/Page[^s]/.test(dictionary)) { into.push(object); return; }
  for (const kid of (dictValue(dictionary, "Kids") ?? "").matchAll(/(\d+)\s+\d+\s+R/g))
    walkPages(objects, Number(kid[1]), into, seen, depth + 1);
}

/** Every content stream of one page, joined, so the drawing instructions can be read in order. */
function pageContent(objects: Map<number, RawObject>, page: RawObject, limits: string[]): string {
  const value = dictValue(latin(page.body), "Contents") ?? "";
  const parts: string[] = [];
  for (const reference of value.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const target = objects.get(Number(reference[1]));
    if (!target) continue;
    const { bytes, limit } = unpack(target);
    if (limit && !limits.includes(limit)) limits.push(limit);
    if (bytes) parts.push(latin(bytes));
  }
  return parts.join("\n");
}

/**
 * A page's fonts and, for each, the table that turns the numbers in a drawn string back into
 * letters. Only the tables written into the file itself are used; nothing is looked up elsewhere.
 */
function pageFonts(objects: Map<number, RawObject>, page: RawObject): Map<string, Map<number, string>> {
  const fonts = new Map<string, Map<number, string>>();
  const resources = resourceDictionary(objects, page);
  const fontBlock = dictValue(resources, "Font") ?? "";
  const inline = fontBlock.startsWith("<<") ? fontBlock : latin(objects.get(referenceNumber(fontBlock) ?? -1)?.body ?? Buffer.alloc(0));
  for (const entry of inline.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objects.get(Number(entry[2]));
    if (!font) continue;
    const unicode = referenceNumber(dictValue(latin(font.body), "ToUnicode"));
    const source = unicode === null ? null : objects.get(unicode);
    fonts.set(entry[1]!, source ? parseCmap(latin(unpack(source).bytes ?? Buffer.alloc(0))) : new Map());
  }
  return fonts;
}
function resourceDictionary(objects: Map<number, RawObject>, page: RawObject): string {
  const value = dictValue(latin(page.body), "Resources") ?? "";
  if (value.startsWith("<<")) return value;
  const reference = referenceNumber(value);
  return reference === null ? "" : latin(objects.get(reference)?.body ?? Buffer.alloc(0));
}

/** The `bfchar` and `bfrange` entries of a ToUnicode table: which number means which letter. */
export function parseCmap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g))
      map.set(parseInt(pair[1]!, 16), hexToText(pair[2]!));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const row of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = parseInt(row[1]!, 16), to = parseInt(row[2]!, 16), start = parseInt(row[3]!, 16);
      for (let code = from; code <= to && code - from < 1024; code++) map.set(code, String.fromCodePoint(start + (code - from)));
    }
  return map;
}
const hexToText = (hex: string): string => {
  let out = "";
  for (let at = 0; at + 3 < hex.length + 1; at += 4) out += String.fromCharCode(parseInt(hex.slice(at, at + 4), 16));
  return out;
};

interface Piece { y: number; x: number; text: string }
/**
 * The drawing instructions of one page turned back into lines. Text is placed by the position the
 * instructions set, so pieces that share a line come back on one line, in the order they sit.
 */
export function readContent(content: string, fonts: Map<string, Map<number, string>>): string {
  const pieces: Piece[] = [];
  let x = 0, y = 0, lineX = 0, lineY = 0, font = new Map<number, string>();
  const token = /\/([^\s/<>[\]()]+)\s+[\d.]+\s+Tf|BT|ET|([-\d.]+)\s+([-\d.]+)\s+(Td|TD)|([-\d.]+(?:\s+[-\d.]+){5})\s+Tm|T\*|((?:\([^]*?(?<!\\)\)|<[0-9a-fA-F\s]*>|[-\d.]+|\s)+)\s*(TJ|Tj|'|")/g;
  for (let match = token.exec(content); match; match = token.exec(content)) {
    if (match[1] !== undefined) { font = fonts.get(match[1]) ?? new Map(); continue; }
    if (match[0] === "BT") { x = y = lineX = lineY = 0; continue; }
    if (match[4] !== undefined) { lineX += Number(match[2]); lineY += Number(match[3]); x = lineX; y = lineY; continue; }
    if (match[5] !== undefined) {
      const numbers = match[5].trim().split(/\s+/).map(Number);
      lineX = numbers[4] ?? 0; lineY = numbers[5] ?? 0; x = lineX; y = lineY; continue;
    }
    if (match[0] === "T*") { lineY -= 12; x = lineX; y = lineY; continue; }
    if (match[6] === undefined) continue;
    if (match[7] === "'" || match[7] === '"') { lineY -= 12; x = lineX; y = lineY; }
    const text = drawnText(match[6], font);
    if (text) { pieces.push({ y, x, text }); x += text.length; }
  }
  return joinLines(pieces);
}
/** The letters one drawing instruction puts on the page, from its literal and hex strings. */
function drawnText(argument: string, font: Map<number, string>): string {
  let out = "";
  for (const part of argument.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]*)>/g)) {
    if (part[1] !== undefined) out += font.size ? mapCodes([...unescapeLiteral(part[1])].map((c) => c.charCodeAt(0)), font) : unescapeLiteral(part[1]);
    else out += mapCodes(hexCodes(part[2] ?? "", font), font);
  }
  return out;
}
const hexCodes = (hex: string, font: Map<number, string>): number[] => {
  const clean = hex.replace(/\s+/g, "");
  const width = font.size && [...font.keys()].some((code) => code > 255) ? 4 : 2;
  const codes: number[] = [];
  for (let at = 0; at < clean.length; at += width) codes.push(parseInt(clean.slice(at, at + width).padEnd(width, "0"), 16));
  return codes;
};
/** A table entry where the file gave one, otherwise the number read as ordinary Latin text. */
const mapCodes = (codes: number[], font: Map<number, string>): string =>
  codes.map((code) => font.get(code) ?? (code >= 32 ? String.fromCharCode(code) : "")).join("");
/** `\n`, `\(` and `\101` inside a literal string, turned back into what they stand for. */
export function unescapeLiteral(value: string): string {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return value.replace(/\\(\d{1,3}|.)/gs, (_whole, body: string) =>
    /^\d+$/.test(body) ? String.fromCharCode(parseInt(body, 8)) : escapes[body] ?? body);
}
/** Pieces that sit at the same height become one line, top of the page first. */
function joinLines(pieces: Piece[]): string {
  const rows = new Map<number, Piece[]>();
  for (const piece of pieces) {
    const key = Math.round(piece.y);
    rows.set(key, [...(rows.get(key) ?? []), piece]);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((piece) => piece.text).join("").replace(/\s+$/, ""))
    .filter((line) => line.trim()).join("\n");
}

/**
 * The words of a PDF, page by page. A file locked with a password is refused outright; a file whose
 * pages draw no text at all comes back marked as pictures so the caller can offer to look at it.
 */
export function pdfText(bytes: Buffer): PdfText {
  if (bytes.length > pdfByteLimit) throw new Error(`PDFs up to ${pdfByteLimit / 1048576} MB can be read`);
  if (!latin(bytes.subarray(0, 1024)).includes("%PDF")) throw new Error("That file is not a PDF");
  const objects = scanObjects(bytes);
  const limits = expandPacked(objects);
  if ([...objects.values()].some((object) => latin(object.body).includes("/Encrypt"))
    || /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin(bytes.subarray(-4096))))
    throw new PdfLocked("This PDF is locked with a password, so its words cannot be read. Open it with the password and save an unlocked copy first.");
  const pages = pagesInOrder(objects).map((page, index) => ({
    page: index + 1, text: readContent(pageContent(objects, page, limits), pageFonts(objects, page)),
  }));
  return { pages, pictures: pages.length > 0 && pages.every((page) => !page.text.trim()), limits };
}
/** The whole file as text, with the page markers the passage-cutter already understands. */
export function pdfMarkedText(result: PdfText): string {
  return result.pages.map((page) => `[[page ${page.page}]]\n${page.text}`).join("\n\n").trim();
}
