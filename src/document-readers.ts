import { documentType, extractText, type DocumentType } from "./document-text.js";
import { readDocx, readPptx, readXlsx, type ReadStructure } from "./document-office.js";
import { readEpub, readOds, readOdt, readRtf } from "./document-open.js";
import { PdfLocked, pdfMarkedText, pdfText } from "./document-pdf.js";
import { errorText } from "./contracts.js";

/**
 * One door for every kind of file the assistant can read. The reader for a kind gives back the
 * words with the shape kept — headings, sheets, slides and pages — plus any tables it found and a
 * plain sentence for every part it could not read. Nothing here runs anything from a file and
 * nothing here follows an address inside one: a document is read, never obeyed.
 *
 * Every read is bounded. A file larger than the size cap is refused before a byte is parsed, and a
 * file that takes longer than the time cap to walk is cut short and says so, so a document that is
 * shaped to be slow cannot hold up the assistant.
 */
export interface ReadTable { name: string; grid: string[][] }
export interface ReadDocument {
  /** The kind of file it turned out to be. */
  type: DocumentType;
  /** The words, with Markdown headings for structure and `[[page N]]` where the reader knew pages. */
  text: string;
  /** The tables it found, each with the first row as its headings. */
  tables: ReadTable[];
  /** Parts that could not be read, in plain language; empty when everything came through. */
  limits: string[];
  /** True when the file holds pictures of text rather than text a reader can lift out. */
  pictures: boolean;
  /** How many pages or slides the reader saw, or zero when the kind has no pages. */
  pages: number;
}
/** How large a file one read may open. Bigger than this is refused rather than half-read. */
export const readerByteLimit = 20 * 1024 * 1024;
/** How long one read may take. A file still being walked after this is cut short with a note. */
export const readerTimeLimitMs = 20000;
/** What to say about a PDF that is pictures of text, so the owner knows what to ask for next. */
export const picturesMessage =
  "This PDF is pictures of text rather than text, so there are no words to lift out. Ask me to read it with a vision model and I will look at the pages instead.";
/** The kinds a reader exists for, which is also what a knowledge base will walk into a collection. */
export const readableTypes: DocumentType[] = [
  "txt", "md", "html", "csv", "json", "docx", "xlsx", "pptx", "odt", "ods", "epub", "rtf", "pdf",
];

const readers: Partial<Record<DocumentType, (bytes: Buffer) => ReadStructure>> = {
  docx: readDocx, xlsx: readXlsx, pptx: readPptx, odt: readOdt, ods: readOds, epub: readEpub, rtf: readRtf,
};

/**
 * Reads one file. `name` decides which reader is used, the way it always has. A file this build
 * cannot read at all throws with a sentence a person can act on; a file it can partly read comes
 * back with the rest listed under `limits`.
 */
export function readDocument(bytes: Buffer, name: string, options: { byteLimit?: number; timeLimitMs?: number } = {}): ReadDocument {
  const byteLimit = options.byteLimit ?? readerByteLimit;
  if (bytes.length > byteLimit)
    throw new Error(`Files up to ${Math.round(byteLimit / 1048576)} MB can be read; this one is larger.`);
  const type = documentType(name);
  const deadline = Date.now() + (options.timeLimitMs ?? readerTimeLimitMs);
  if (type === "pdf") return readPdf(bytes, deadline);
  const reader = readers[type];
  if (!reader) return plain(type, bytes);
  const result = reader(bytes);
  return { type, ...result, limits: [...result.limits, ...timeLimit(deadline)], pictures: false, pages: pageCount(result.text) };
}
/** The kinds the older reader already handled: plain text, Markdown, web pages, tables and JSON. */
function plain(type: DocumentType, bytes: Buffer): ReadDocument {
  const text = extractText(bytes, type);
  if (text === null) throw new Error("There is no reader in this build for that kind of file");
  return { type, text, tables: [], limits: [], pictures: false, pages: 0 };
}
function readPdf(bytes: Buffer, deadline: number): ReadDocument {
  try {
    const result = pdfText(bytes);
    return {
      type: "pdf", text: result.pictures ? "" : pdfMarkedText(result), tables: [],
      limits: [...result.limits, ...(result.pictures ? [picturesMessage] : []), ...timeLimit(deadline)],
      pictures: result.pictures, pages: result.pages.length,
    };
  } catch (error) {
    if (error instanceof PdfLocked) throw error;
    throw new Error(`This PDF could not be read: ${errorText(error).slice(0, 200)}`);
  }
}
const timeLimit = (deadline: number): string[] =>
  Date.now() > deadline ? ["This file took longer to read than the time allowed, so part of it may be missing."] : [];
/** How many pages or slides the reader marked, counted from the markers it left in the text. */
const pageCount = (text: string): number => (text.match(/\[\[page \d+\]\]/g) ?? []).length;

/**
 * The same read, but never throwing: the caller gets either the document or one plain sentence for
 * the "what could not be read" list. Ingestion uses this so one bad file never stops a folder.
 */
export function tryReadDocument(bytes: Buffer, name: string, options?: { byteLimit?: number; timeLimitMs?: number }):
  { document: ReadDocument; reason: "" } | { document: null; reason: string } {
  try { return { document: readDocument(bytes, name, options), reason: "" }; }
  catch (error) { return { document: null, reason: errorText(error).slice(0, 300) }; }
}
