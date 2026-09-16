import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, crc32 } from "node:zlib";
import { ZipReader, sharedStrings, sheetText } from "./document-text.js";

/**
 * A spreadsheet or table held in memory for the length of one task: read from a comma, tab, JSON or
 * spreadsheet file, summarised in plain numbers, questioned with read-only SQL, drawn as a simple
 * picture, and written back out. Everything is bounded — rows, columns and cell length — so a very
 * large file is cut short and says so rather than filling the computer's memory.
 */
export type Cell = string | number | boolean | null;
export interface DataColumn { name: string; type: "number" | "text" | "boolean" }
export interface DataTable {
  name: string;
  columns: DataColumn[];
  rows: Cell[][];
  source: string;
  /** True when the file held more rows than the limit and the rest were left out. */
  truncated: boolean;
}
export const maxRows = 5000;
export const maxColumns = 64;
export const maxCellChars = 500;
/** Rows a tool result may carry back; anything more is summarised instead. */
export const previewRows = 20;

/** Splits comma or tab separated text, honouring "quoted" cells and doubled quotes inside them. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') { cell += char; continue; }
      if (text[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (char === '"' && cell === "") { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ""; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      continue;
    }
    cell += char;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((entry) => entry.some((value) => value !== ""));
}

const looksNumeric = (value: string): boolean => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim());
const looksBoolean = (value: string): boolean => /^(true|false|yes|no)$/i.test(value.trim());
/** The kind of a column, decided by the values actually present: numbers, yes/no, or words. */
function columnType(values: string[]): DataColumn["type"] {
  const filled = values.filter((value) => value.trim() !== "");
  if (!filled.length) return "text";
  if (filled.every(looksNumeric)) return "number";
  if (filled.every(looksBoolean)) return "boolean";
  return "text";
}
function toCell(value: string, type: DataColumn["type"]): Cell {
  const text = value.trim();
  if (text === "") return null;
  if (type === "number") return Number(text);
  if (type === "boolean") return /^(true|yes)$/i.test(text);
  return value.length > maxCellChars ? value.slice(0, maxCellChars) : value;
}
/** Column names that are always usable: blank headings are numbered, duplicates get a suffix. */
function headerNames(header: string[]): string[] {
  const used = new Set<string>();
  return header.slice(0, maxColumns).map((raw, index) => {
    const base = raw.trim().replace(/[^\p{L}\p{N}_ ]/gu, " ").replace(/\s+/g, "_").slice(0, 60) || `column_${index + 1}`;
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Builds a table from rows of raw text: the first row names the columns. */
export function tableFromGrid(name: string, source: string, grid: string[][]): DataTable {
  if (!grid.length) throw new Error("That file has no rows in it");
  const columns = headerNames(grid[0]!);
  const body = grid.slice(1, maxRows + 1).map((row) => row.slice(0, columns.length));
  const types = columns.map((_, index) => columnType(body.map((row) => row[index] ?? "")));
  return {
    name,
    columns: columns.map((column, index) => ({ name: column, type: types[index]! })),
    rows: body.map((row) => columns.map((_, index) => toCell(row[index] ?? "", types[index]!))),
    source,
    truncated: grid.length - 1 > maxRows,
  };
}
/** A table from JSON: either an array of objects, or an array of arrays with a heading row. */
export function tableFromJson(name: string, source: string, text: string): DataTable {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows
    : Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : null;
  if (!list?.length) throw new Error("That JSON does not hold a list of rows");
  if (Array.isArray(list[0])) return tableFromGrid(name, source, (list as unknown[][]).map((row) => row.map(asText)));
  const keys = [...new Set(list.flatMap((row) => Object.keys((row ?? {}) as object)))].slice(0, maxColumns);
  const grid = [keys, ...list.map((row) => keys.map((key) => asText((row as Record<string, unknown>)?.[key])))];
  return tableFromGrid(name, source, grid);
}
const asText = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** A table from the first sheet of a spreadsheet file, read with the library's own zip reader. */
export function tableFromXlsx(name: string, source: string, bytes: Buffer): DataTable {
  const zip = new ZipReader(bytes);
  const shared = zip.entry("xl/sharedStrings.xml");
  const sheet = zip.entry("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("That spreadsheet has no first sheet the assistant can read");
  const text = sheetText(sheet.toString("utf8"), shared ? sharedStrings(shared.toString("utf8")) : []);
  return tableFromGrid(name, source, parseDelimited(text, "\t"));
}
/** Reads a file of any supported kind into a table, choosing by the name it came from. */
export function tableFrom(name: string, source: string, bytes: Buffer): DataTable {
  const extension = source.toLowerCase().split("?")[0]!.split(".").pop() ?? "";
  if (extension === "xlsx" || extension === "xlsm") return tableFromXlsx(name, source, bytes);
  const text = bytes.toString("utf8");
  if (extension === "json") return tableFromJson(name, source, text);
  if (extension === "tsv") return tableFromGrid(name, source, parseDelimited(text, "\t"));
  if (extension === "csv") return tableFromGrid(name, source, parseDelimited(text, ","));
  return tableFromText(name, source, text);
}
/** When the name says nothing, the contents decide: JSON first, then tabs, then commas. */
export function tableFromText(name: string, source: string, text: string): DataTable {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return tableFromJson(name, source, trimmed);
  const firstLine = trimmed.split("\n")[0] ?? "";
  const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  return tableFromGrid(name, source, parseDelimited(text, delimiter));
}

export interface ColumnSummary {
  name: string; type: DataColumn["type"]; filled: number; missing: number; unique: number;
  min?: number; max?: number; mean?: number; median?: number; examples?: string[];
}
const round = (value: number): number => Number(value.toFixed(4));
/** Plain numbers about each column: how full it is, how varied, and the spread where it is numeric. */
export function describeTable(table: DataTable): { rows: number; columns: ColumnSummary[]; truncated: boolean } {
  const columns = table.columns.map((column, index) => {
    const values = table.rows.map((row) => row[index] ?? null);
    const filled = values.filter((value) => value !== null && value !== "");
    const unique = new Set(filled.map((value) => String(value))).size;
    const summary: ColumnSummary = { name: column.name, type: column.type, filled: filled.length, missing: values.length - filled.length, unique };
    if (column.type === "number") {
      const numbers = (filled as number[]).slice().sort((a, b) => a - b);
      if (numbers.length) Object.assign(summary, {
        min: round(numbers[0]!), max: round(numbers[numbers.length - 1]!),
        mean: round(numbers.reduce((total, value) => total + value, 0) / numbers.length),
        median: round(numbers[Math.floor((numbers.length - 1) / 2)]!),
      });
    } else summary.examples = [...new Set(filled.map((value) => String(value).slice(0, 60)))].slice(0, 3);
    return summary;
  });
  return { rows: table.rows.length, columns, truncated: table.truncated };
}

const escapeCell = (value: Cell): string => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120);
/** A Markdown table the message column already knows how to show, cut to the rows asked for. */
export function markdownTable(columns: string[], rows: Cell[][], limit = previewRows): string {
  const shown = rows.slice(0, limit);
  const head = `| ${columns.join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = shown.map((row) => `| ${columns.map((_, index) => escapeCell(row[index] ?? null)).join(" | ")} |`);
  const note = rows.length > shown.length ? `\n\n_Showing ${shown.length} of ${rows.length} rows._` : "";
  return [head, rule, ...body].join("\n") + note;
}

const readOnlySql = /^\s*(select|with)\b/i;
/** Answers a read-only question about loaded tables by running it against a private in-memory copy. */
export function queryTables(tables: DataTable[], sql: string, limit: number): { columns: string[]; rows: Cell[][]; truncated: boolean } {
  if (!readOnlySql.test(sql)) throw new Error("Only questions that start with SELECT or WITH can be run");
  if (sql.replace(/;\s*$/, "").includes(";")) throw new Error("Ask one question at a time (no semicolons in the middle)");
  const db = new DatabaseSync(":memory:");
  try {
    for (const table of tables) loadInto(db, table);
    const statement = db.prepare(sql);
    const results = statement.all() as Record<string, Cell>[];
    const columns = results.length ? Object.keys(results[0]!) : [];
    const rows = results.slice(0, limit).map((row) => columns.map((column) => normaliseCell(row[column])));
    return { columns, rows, truncated: results.length > rows.length };
  } finally {
    db.close();
  }
}
function loadInto(db: DatabaseSync, table: DataTable): void {
  const quoted = table.columns.map((column) => `"${column.name.replace(/"/g, "")}"`);
  // Yes/no columns are stored as 1 and 0, so SQL comparisons on them behave like numbers.
  const kinds = table.columns.map((column) => (column.type === "number" ? "REAL" : column.type === "boolean" ? "INTEGER" : "TEXT"));
  db.exec(`CREATE TABLE "${table.name.replace(/"/g, "")}"(${quoted.map((name, index) => `${name} ${kinds[index]}`).join(",")})`);
  const insert = db.prepare(`INSERT INTO "${table.name.replace(/"/g, "")}" VALUES(${quoted.map(() => "?").join(",")})`);
  for (const row of table.rows) insert.run(...row.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)));
}
const normaliseCell = (value: unknown): Cell =>
  value === null || value === undefined ? null
    : typeof value === "bigint" ? Number(value)
    : typeof value === "number" || typeof value === "string" ? value : String(value);

/** Writes a table back out as comma separated text, quoting anything that needs it. */
export function toCsv(table: DataTable): string {
  const cell = (value: Cell): string => {
    const text = value === null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [table.columns.map((column) => cell(column.name)).join(","), ...table.rows.map((row) => row.map(cell).join(","))].join("\n") + "\n";
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function sheetXml(table: DataTable): string {
  const cells = (row: Cell[]): string => row.map((value) =>
    value === null ? "<c/>"
      : typeof value === "number" ? `<c><v>${value}</v></c>`
      : `<c t="inlineStr"><is><t>${xmlEscape(String(value))}</t></is></c>`).join("");
  const header = `<row>${cells(table.columns.map((column) => column.name))}</row>`;
  const body = table.rows.map((row) => `<row>${cells(row)}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${body}</sheetData></worksheet>`;
}
/** A spreadsheet file the library's own reader opens, built from Node's own zip and deflate parts. */
export function toXlsx(table: DataTable): Buffer {
  return zipArchive([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      `<sheet name="${xmlEscape(table.name.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/worksheets/sheet1.xml", sheetXml(table)],
  ]);
}
/** The smallest zip container the reader in `document-text.ts` accepts: deflated entries, one directory. */
function zipArchive(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, "utf8"), body = deflateRawSync(raw), nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
