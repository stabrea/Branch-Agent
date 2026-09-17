import { z } from "zod";
import { entryText, packRaw, replaceEntry, unpackRaw, type RawEntry } from "./document-package.js";
import { closingTag, wordBlocks } from "./document-office.js";
import { docxBlock } from "./document-docx.js";
import { sheetXml, workbookRels, workbookXml } from "./document-xlsx.js";
import { BlockSchema, SheetSchema, xmlSafe, type DocBlock, type SheetSpec } from "./document-write.js";
import { decodeEntities } from "./document-text.js";

/**
 * Changing a document somebody else wrote. The promise this keeps is narrow and worth stating: the
 * parts of the file the change does not touch come back as the very same bytes, not as a re-saved
 * copy that happens to say the same thing. So a Word file with a picture, a footer and a company
 * template in it still has all of those, untouched, after one sentence in it is changed.
 *
 * Wording spread across several differently formatted pieces is the one case that cannot be changed
 * silently: the run is rewritten as one piece, and the answer says so, so the person can look.
 */
export const EditOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace-text"), find: z.string().min(1).max(2000),
    replaceWith: z.string().max(4000), all: z.boolean().default(true),
  }).strict(),
  z.object({ op: z.literal("append"), blocks: z.array(BlockSchema).min(1).max(200) }).strict(),
  z.object({
    op: z.literal("update-table"), table: z.number().int().min(1).max(200),
    grid: z.array(z.array(z.string().max(500)).max(64)).min(1).max(500),
  }).strict(),
  z.object({ op: z.literal("add-sheet"), sheet: SheetSchema }).strict(),
  z.object({ op: z.literal("update-sheet"), sheet: SheetSchema }).strict(),
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;
export interface EditResult { bytes: Buffer; changes: number; notes: string[]; partsTouched: string[] }

/** Runs every change in order over a Word or spreadsheet file, and says what each one did. */
export function editPackage(original: Buffer, kind: "docx" | "xlsx", operations: EditOperation[]): EditResult {
  let entries = unpackRaw(original);
  const notes: string[] = [], touched = new Set<string>();
  let changes = 0;
  for (const operation of operations) {
    const done = kind === "docx" ? editWord(entries, operation) : editSheet(entries, operation);
    entries = done.entries;
    changes += done.changes;
    for (const part of done.touched) touched.add(part);
    notes.push(...done.notes);
    if (!done.changes) notes.push(`Nothing matched for ${describe(operation)}, so that change was not made.`);
  }
  return { bytes: packRaw(entries), changes, notes, partsTouched: [...touched] };
}
const describe = (operation: EditOperation): string =>
  operation.op === "replace-text" ? `replacing "${operation.find.slice(0, 60)}"`
    : operation.op === "update-table" ? `updating table ${operation.table}`
    : operation.op === "append" ? "adding a section"
    : `the sheet "${operation.sheet.name}"`;

interface Step { entries: RawEntry[]; changes: number; notes: string[]; touched: string[] }
const unchanged = (entries: RawEntry[], note = ""): Step => ({ entries, changes: 0, notes: note ? [note] : [], touched: [] });

/** Changes inside a Word file: all of them land in `word/document.xml` and nothing else. */
function editWord(entries: RawEntry[], operation: EditOperation): Step {
  if (operation.op === "add-sheet" || operation.op === "update-sheet")
    return unchanged(entries, "Sheets belong to a spreadsheet, not a Word file.");
  const part = entries.find((entry) => entry.name === "word/document.xml");
  if (!part) return unchanged(entries, "That Word file has no document part to change.");
  const before = entryText(part);
  const done = operation.op === "replace-text" ? replaceInWord(before, operation.find, operation.replaceWith, operation.all)
    : operation.op === "append" ? { xml: appendToWord(before, operation.blocks), changes: operation.blocks.length, notes: [] }
    : updateWordTable(before, operation.table, operation.grid);
  if (!done.changes) return unchanged(entries, ...done.notes);
  return { entries: replaceEntry(entries, "word/document.xml", done.xml), changes: done.changes, notes: done.notes, touched: ["word/document.xml"] };
}

/**
 * The wording changed where it sits in one piece of text, which keeps every bit of formatting. A
 * phrase split across pieces — half of it bold, say — is rewritten as one piece and reported.
 */
export function replaceInWord(xml: string, find: string, replaceWith: string, all: boolean): { xml: string; changes: number; notes: string[] } {
  let changes = 0;
  const once = xml.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (whole, open: string, body: string, close: string) => {
    if ((!all && changes) || !decodeEntities(body).includes(find)) return whole;
    changes++;
    return `${open}${xmlSafe(swap(decodeEntities(body), find, replaceWith, all))}${close}`;
  });
  if (changes) return { xml: once, changes, notes: [] };
  return spreadAcrossRuns(xml, find, replaceWith, all);
}
const swap = (text: string, find: string, replaceWith: string, all: boolean): string =>
  all ? text.split(find).join(replaceWith) : text.replace(find, replaceWith);

/** The fallback: a paragraph whose words only read as the phrase once its pieces are joined up. */
function spreadAcrossRuns(xml: string, find: string, replaceWith: string, all: boolean): { xml: string; changes: number; notes: string[] } {
  let changes = 0;
  const out = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if ((!all && changes) || !decodeEntities(paragraph.replace(/<[^>]*>/g, "")).includes(find)) return paragraph;
    const joined = decodeEntities(paragraph.replace(/<[^>]*>/g, ""));
    const properties = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? "";
    changes++;
    return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xmlSafe(swap(joined, find, replaceWith, all))}</w:t></w:r></w:p>`;
  });
  if (!changes) return { xml, changes: 0, notes: [] };
  return { xml: out, changes,
    notes: [`The wording was spread across differently formatted pieces, so ${changes === 1 ? "that paragraph" : "those paragraphs"} now carry one style. Everything else in the file is untouched.`] };
}

/** New blocks added at the end of the body, just before the page settings that close it. */
export function appendToWord(xml: string, blocks: DocBlock[]): string {
  const added = blocks.map(docxBlock).join("");
  const section = xml.lastIndexOf("<w:sectPr");
  if (section < 0) return xml.replace("</w:body>", `${added}</w:body>`);
  return xml.slice(0, section) + added + xml.slice(section);
}

/** One table replaced with a new grid; every other table and paragraph in the file stays put. */
export function updateWordTable(xml: string, number: number, grid: string[][]): { xml: string; changes: number; notes: string[] } {
  const body = /<w:body\b[^>]*>/.exec(xml);
  if (!body) return { xml, changes: 0, notes: [] };
  const tables = wordBlocks(xml.slice(body.index + body[0].length)).filter((block) => block.kind === "tbl");
  const wanted = tables[number - 1];
  if (!wanted) return { xml, changes: 0, notes: [`This file has ${tables.length} table${tables.length === 1 ? "" : "s"}.`] };
  const replacement = docxBlock({ kind: "table", name: "", grid });
  return { xml: xml.replace(wanted.xml, replacement), changes: 1, notes: [] };
}

/** Changes inside a spreadsheet: a sheet replaced in place, or a new one added beside the others. */
function editSheet(entries: RawEntry[], operation: EditOperation): Step {
  if (operation.op === "append" || operation.op === "update-table")
    return unchanged(entries, "Sections and Word tables belong to a Word file, not a spreadsheet.");
  const workbookPart = entries.find((entry) => entry.name === "xl/workbook.xml");
  if (!workbookPart) return unchanged(entries, "That spreadsheet has no workbook part to change.");
  const names = sheetNames(entryText(workbookPart));
  if (operation.op === "replace-text") return replaceInSheets(entries, operation.find, operation.replaceWith, operation.all);
  const at = names.findIndex((name) => name.toLowerCase() === operation.sheet.name.toLowerCase());
  if (operation.op === "update-sheet" && at < 0) return unchanged(entries, `There is no sheet called "${operation.sheet.name}".`);
  if (operation.op === "add-sheet" && at >= 0) return unchanged(entries, `There is already a sheet called "${operation.sheet.name}".`);
  return at >= 0 ? writeSheet(entries, at + 1, operation.sheet) : addSheet(entries, names, operation.sheet);
}
/** The sheet names in the order the workbook lists them, which is the order of its sheet parts. */
export const sheetNames = (workbook: string): string[] =>
  [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? ""));

function writeSheet(entries: RawEntry[], number: number, sheet: SheetSpec): Step {
  const name = `xl/worksheets/sheet${number}.xml`;
  return { entries: replaceEntry(entries, name, sheetXml(sheet)), changes: 1, notes: [], touched: [name] };
}
/**
 * A new sheet needs three other parts told about it — the workbook, its relationship list and the
 * content list — so those three are rewritten and every other part of the file is copied across.
 */
function addSheet(entries: RawEntry[], names: string[], sheet: SheetSpec): Step {
  const count = names.length + 1, part = `xl/worksheets/sheet${count}.xml`;
  const listed = [...names.map((name) => ({ name })), { name: sheet.name }];
  let next = replaceEntry(entries, part, sheetXml(sheet));
  next = replaceEntry(next, "xl/workbook.xml", workbookXml(listed));
  next = replaceEntry(next, "xl/_rels/workbook.xml.rels", workbookRels(count));
  next = replaceEntry(next, "[Content_Types].xml", withSheetType(entryText(entries.find((entry) => entry.name === "[Content_Types].xml")!), count));
  return { entries: next, changes: 1, notes: [],
    touched: [part, "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml"] };
}
function withSheetType(contentTypes: string, number: number): string {
  const line = `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  return contentTypes.includes(line) ? contentTypes : contentTypes.replace("</Types>", `${line}</Types>`);
}

/** Wording changed in every place a spreadsheet keeps words: its shared list and its own cells. */
function replaceInSheets(entries: RawEntry[], find: string, replaceWith: string, all: boolean): Step {
  let next = entries, changes = 0;
  const touched: string[] = [];
  for (const entry of entries) {
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(entry.name)) continue;
    let here = 0;
    const out = entryText(entry).replace(/(<t\b[^>]*>)([\s\S]*?)(<\/t>)/g, (whole, open: string, body: string, close: string) => {
      if ((!all && (changes || here)) || !decodeEntities(body).includes(find)) return whole;
      here++;
      return `${open}${xmlSafe(swap(decodeEntities(body), find, replaceWith, all))}${close}`;
    });
    if (!here) continue;
    next = replaceEntry(next, entry.name, out);
    touched.push(entry.name);
    changes += here;
  }
  return { entries: next, changes, notes: [], touched };
}

/** How many parts of a file came through as the very same bytes, for the answer the owner sees. */
export function unchangedParts(before: Buffer, after: Buffer): string[] {
  const packed = new Map(unpackRaw(before).map((entry) => [entry.name, entry]));
  return unpackRaw(after)
    .filter((entry) => { const was = packed.get(entry.name); return was?.crc === entry.crc && was.packed.equals(entry.packed); })
    .map((entry) => entry.name);
}
export { closingTag };
