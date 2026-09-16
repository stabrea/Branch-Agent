import { createHash } from "node:crypto";

/**
 * Cutting a document into passages small enough to put in front of a model and big enough to make
 * sense on their own. Markdown is cut at its headings, so a passage never straddles two sections
 * and each one remembers which section it came from; anything else is cut into overlapping windows
 * of whole paragraphs. The same document always produces the same passages with the same names, so
 * reading a library again only re-reads what actually changed.
 */
export interface Chunk {
  /** Stable across re-reads: the document, its place in the document, and its wording. */
  id: string;
  index: number;
  text: string;
  /** The document's own name, for the citation. */
  title: string;
  /** The headings above this passage, outermost first; empty for plain text. */
  headingPath: string[];
  /** The page it came from where the reader knew, otherwise null. */
  page: number | null;
}
export interface ChunkOptions {
  /** About how many characters a passage should hold. */
  size?: number;
  /** How much of the previous passage the next one repeats, so a sentence is never cut in half. */
  overlap?: number;
}
export const defaultChunkSize = 1500;
export const defaultChunkOverlap = 200;
const headingLine = /^(#{1,6})\s+(.+?)\s*#*$/;
/** Some readers mark where a page ended; that mark is kept as the page number and dropped from the text. */
const pageBreak = /^\s*(?:\f|\[\[page (\d+)\]\])\s*$/i;

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
/** The name one passage answers to. The same document and wording always gives the same name. */
export const chunkId = (documentKey: string, index: number, text: string): string =>
  `${fingerprint(documentKey)}-${String(index).padStart(4, "0")}-${fingerprint(text)}`;

interface Section { headingPath: string[]; lines: string[]; page: number | null }

/** The document split at its headings, each section keeping the headings above it. */
export function markdownSections(text: string): Section[] {
  const sections: Section[] = [];
  let path: string[] = [];
  let page: number | null = null;
  let current: Section = { headingPath: [], lines: [], page: null };
  for (const line of text.split(/\r?\n/)) {
    const broke = pageBreak.exec(line);
    if (broke) { page = broke[1] ? Number(broke[1]) : (page ?? 1) + 1; continue; }
    const heading = headingLine.exec(line);
    if (!heading) {
      if (!current.lines.length) current.page = page;
      current.lines.push(line);
      continue;
    }
    if (current.lines.some((entry) => entry.trim())) sections.push(current);
    path = [...path.slice(0, heading[1]!.length - 1), heading[2]!.trim()];
    current = { headingPath: path, lines: [], page };
  }
  if (current.lines.some((entry) => entry.trim())) sections.push(current);
  return sections;
}

/**
 * Overlapping windows of whole paragraphs. A paragraph longer than one window on its own is cut at
 * a sentence, so a very long block still becomes passages rather than one unusable lump.
 */
export function paragraphWindows(text: string, size = defaultChunkSize, overlap = defaultChunkOverlap): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).flatMap((part) => split(part, size));
  const windows: string[] = [];
  let held: string[] = [], length = 0;
  for (const paragraph of paragraphs) {
    if (length && length + paragraph.length + 2 > size) {
      windows.push(held.join("\n\n"));
      held = tail(held, overlap); length = held.join("\n\n").length;
    }
    held.push(paragraph); length += paragraph.length + 2;
  }
  if (held.length) windows.push(held.join("\n\n"));
  return windows.filter(Boolean);
}
/** One over-long paragraph cut at sentence ends, never mid-word. */
function split(paragraph: string, size: number): string[] {
  if (paragraph.length <= size) return [paragraph];
  const pieces: string[] = [];
  let held = "";
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    if (held && held.length + sentence.length + 1 > size) { pieces.push(held); held = ""; }
    held = held ? `${held} ${sentence}` : sentence.slice(0, size);
  }
  if (held) pieces.push(held);
  return pieces;
}
/** The last few paragraphs of a window, up to the overlap, repeated at the start of the next one. */
function tail(paragraphs: string[], overlap: number): string[] {
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of [...paragraphs].reverse()) {
    if (length + paragraph.length > overlap && kept.length) break;
    kept.unshift(paragraph); length += paragraph.length + 2;
  }
  return kept;
}

/**
 * The passages of one document. Markdown keeps its heading path; everything else — including the
 * text the existing readers pull out of Word, spreadsheet, web and PDF files — becomes overlapping
 * paragraph windows. No new reader is added here; this only cuts what those readers already give.
 */
export function chunkDocument(
  document: { key: string; title: string; text: string; markdown?: boolean },
  options: ChunkOptions = {},
): Chunk[] {
  const size = options.size ?? defaultChunkSize, overlap = options.overlap ?? defaultChunkOverlap;
  const clean = document.text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const sections = (document.markdown ?? looksLikeMarkdown(clean))
    ? markdownSections(clean)
    : [{ headingPath: [] as string[], lines: clean.split("\n"), page: null }];
  const chunks: Chunk[] = [];
  for (const section of sections)
    for (const window of paragraphWindows(section.lines.join("\n"), size, overlap)) {
      const heading = section.headingPath.length ? `${section.headingPath.join(" › ")}\n\n` : "";
      const text = `${heading}${window}`.trim();
      const index = chunks.length;
      chunks.push({
        id: chunkId(document.key, index, text), index, text,
        title: document.title, headingPath: section.headingPath, page: section.page,
      });
    }
  return chunks;
}
/** Whether a file is worth cutting at headings: it has at least one real Markdown heading. */
export const looksLikeMarkdown = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => headingLine.test(line));
