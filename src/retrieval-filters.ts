import { z } from "zod";
import { documentType, extensionsFor, type DocumentType } from "./document-text.js";

/**
 * Narrowing a search before anything is ranked, using only what a passage already carries: which
 * knowledge base it is in, which file it came from, what kind of file that is, and when Branch last
 * saw that file's contents change. A question about this year's invoices should not drag last
 * year's in behind it, and the cheapest way to make sure of that is to leave them out of the
 * comparison rather than to hope the ranking pushes them down.
 *
 * Two rules matter more than the mechanics. Filters combine: naming a kind and a date means both
 * have to be true, not either. And a filter that matches nothing says so in a sentence — it never
 * quietly widens back out and answers from everything, which is the failure that makes a filter
 * worse than no filter at all.
 */
export const documentKinds: DocumentType[] = [
  "txt", "md", "html", "csv", "json", "docx", "xlsx", "pdf", "pptx", "odt", "ods", "epub", "rtf", "org",
];
export const RetrievalFilterSchema = z.object({
  /** Knowledge bases, by name or by id. Empty or missing means all of them. */
  collections: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  /** Files, by workspace path or by the file's own name. A folder path matches everything under it. */
  files: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  /** Kinds of document, such as `pdf` or `xlsx`. */
  kinds: z.array(z.enum(documentKinds as [DocumentType, ...DocumentType[]])).max(14).optional(),
  /** Only files Branch last saw change on or after this date, written as `2026-01-01`. */
  changedAfter: z.string().trim().min(4).max(40).optional(),
  /** Only files Branch last saw change before this date. */
  changedBefore: z.string().trim().min(4).max(40).optional(),
}).strict();
export type RetrievalFilter = z.infer<typeof RetrievalFilterSchema>;

/** Whether anything at all was asked for, so an unfiltered search keeps behaving exactly as it did. */
export const filterIsSet = (filter: RetrievalFilter | undefined): boolean =>
  Boolean(filter && (filter.collections?.length || filter.files?.length || filter.kinds?.length
    || filter.changedAfter || filter.changedBefore));

/** A date the owner typed, turned into the shape the stored timestamps use, or nothing. */
export function asTimestamp(value: string | undefined, endOfDay: boolean): string | null {
  if (!value) return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface FilterSql {
  /** SQL to add to a `WHERE`, already beginning with `AND`, or the empty string. */
  clause: string;
  params: string[];
  /** True when the clause reads `kb_documents`, so the caller joins it in. */
  needsDocuments: boolean;
}

/**
 * The filter as a piece of SQL, so the narrowing happens in the database rather than afterwards on
 * a list that was already cut short. `collectionIds` is what the owner's names resolved to.
 */
export function filterSql(filter: RetrievalFilter, collectionIds: string[]): FilterSql {
  const parts: string[] = [], params: string[] = [];
  if (filter.collections?.length) {
    parts.push(`c.collection IN (${collectionIds.map(() => "?").join(",") || "''"})`);
    params.push(...collectionIds);
  }
  if (filter.files?.length) {
    parts.push(`(${filter.files.map(() => "(c.doc_id = ? OR c.doc_name = ? OR c.doc_id LIKE ?)").join(" OR ")})`);
    for (const file of filter.files) params.push(file, file, `${file.replace(/\/$/, "")}/%`);
  }
  if (filter.kinds?.length) {
    const endings = [...new Set(filter.kinds.flatMap((kind) => extensionsFor(kind)))];
    parts.push(`(${endings.map(() => "c.doc_id LIKE ?").join(" OR ") || "0"})`);
    params.push(...endings.map((ending) => `%.${ending}`));
  }
  const after = asTimestamp(filter.changedAfter, false), before = asTimestamp(filter.changedBefore, true);
  if (after) { parts.push("d.updated_at >= ?"); params.push(after); }
  if (before) { parts.push("d.updated_at <= ?"); params.push(before); }
  return {
    clause: parts.length ? ` AND ${parts.join(" AND ")}` : "",
    params,
    needsDocuments: Boolean(after || before),
  };
}

/** Whether one already-fetched row would survive the filter, for the lists held in memory. */
export function rowPasses(filter: RetrievalFilter, row: { docId: string; docName: string; changedAt: string }): boolean {
  if (filter.files?.length && !filter.files.some((file) =>
    row.docId === file || row.docName === file || row.docId.startsWith(`${file.replace(/\/$/, "")}/`))) return false;
  if (filter.kinds?.length && !filter.kinds.includes(documentType(row.docId))) return false;
  const after = asTimestamp(filter.changedAfter, false), before = asTimestamp(filter.changedBefore, true);
  if (after && row.changedAt < after) return false;
  if (before && row.changedAt > before) return false;
  return true;
}

/**
 * What to tell somebody when their filter left nothing to search. It names what they asked for, so
 * they can see which part was too narrow, and says plainly that nothing outside it was used.
 */
export function nothingMatchedNote(filter: RetrievalFilter, knownCollections: string[]): string {
  const said: string[] = [];
  if (filter.collections?.length) said.push(`in ${filter.collections.map((name) => `"${name}"`).join(" or ")}`);
  if (filter.files?.length) said.push(`from ${filter.files.join(" or ")}`);
  if (filter.kinds?.length) said.push(`of kind ${filter.kinds.join(" or ")}`);
  if (filter.changedAfter) said.push(`changed on or after ${filter.changedAfter}`);
  if (filter.changedBefore) said.push(`changed before ${filter.changedBefore}`);
  const missing = (filter.collections ?? []).filter((name) =>
    !knownCollections.some((known) => known.toLowerCase() === name.toLowerCase()));
  const unknown = missing.length
    ? ` You have no knowledge base called ${missing.map((name) => `"${name}"`).join(" or ")}.`
    : "";
  return `Nothing you have matches that filter (${said.join(", ")}), so this search found nothing.`
    + `${unknown} Branch did not widen the search: your filter was kept, and no answer was taken from outside it.`;
}
