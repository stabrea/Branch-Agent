import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { RunArtifacts } from "./artifacts.js";
import type { ToolContext } from "./contracts.js";
import type { DataTables } from "./data-tools.js";
import type { WorkspaceFiles, WriteObserver } from "./files.js";
import type { ToolRegistry } from "./registry.js";
import { buildDocx } from "./document-docx.js";
import { buildPptx, pictureKinds } from "./document-pptx.js";
import { buildXlsx } from "./document-xlsx.js";
import { editPackage, EditOperationSchema, unchangedParts } from "./document-edit.js";
import {
  blocksToHtml, blocksToMarkdown, formatOf, mediaTypes, WriteDocumentSchema,
  type SheetCell, type SheetSpec, type WriteDocumentInput, type WriteFormat,
} from "./document-write.js";

/**
 * Making and changing the person's documents. Everything written lands in their own workspace,
 * under the same permission as any other change to their files, so a document the assistant wrote
 * can be opened, moved and deleted like anything else they own.
 *
 * What this is not, said plainly because the words are easy to oversell: there is no live document
 * that two people type in at once. Branch writes a file, or changes one, and hands it back. It does
 * not know what anybody else is doing in that file while it is open in front of them.
 *
 * FQ-workspace.office: the owner can still edit a Word or spreadsheet file alongside one other
 * person, turn by turn rather than keystroke by keystroke — a co-edit session, started from the
 * Documents panel, at src/document-coedit.ts.
 */
export const writtenBytesLimit = 20 * 1024 * 1024;
export const liveCoworkLimit =
  "Branch writes and changes document files; it does not type in a document alongside someone else while they have it open.";

export const EditDocumentSchema = z.object({
  path: z.string().trim().min(1).max(500),
  changes: z.array(EditOperationSchema).min(1).max(20),
  /** Where to put the result; the same file when left out. */
  saveAs: z.string().trim().max(500).default(""),
}).strict();

export class DocumentAuthoring {
  constructor(
    private readonly files: WorkspaceFiles,
    private readonly tables?: DataTables,
    private readonly artifacts?: RunArtifacts,
    private readonly observer?: WriteObserver,
  ) {}

  /** Writes one document and saves it in the workspace. */
  async write(input: unknown, context: ToolContext): Promise<Record<string, unknown>> {
    const value = WriteDocumentSchema.parse(input);
    const format = formatOf(value.path, value.format);
    const bytes = await this.build(value, format, context);
    if (bytes.byteLength > writtenBytesLimit)
      throw new Error(`Documents up to ${writtenBytesLimit / 1048576} MB can be written`);
    if (context.dryRun) return { wouldWrite: value.path, format, bytes: bytes.byteLength };
    await this.save(value.path, bytes, context);
    return {
      path: value.path, format, mediaType: mediaTypes[format], bytes: bytes.byteLength,
      ...counts(value, format), limits: [liveCoworkLimit],
    };
  }
  private async build(value: WriteDocumentInput, format: WriteFormat, context: ToolContext): Promise<Buffer> {
    if (format === "md") return Buffer.from(blocksToMarkdown(value.blocks, value.title), "utf8");
    if (format === "html") return Buffer.from(blocksToHtml(value.blocks, value.title), "utf8");
    if (format === "docx") return buildDocx(value.blocks, value.title);
    if (format === "xlsx") return buildXlsx(value.sheets.map((sheet) => this.filled(sheet, context)));
    return buildPptx(value.slides, await this.pictures(value, context));
  }
  /** A sheet that names a table the task already opened is filled from it, headings and all. */
  private filled(sheet: SheetSpec, context: ToolContext): SheetSpec {
    if (!sheet.table) return sheet;
    if (!this.tables) throw new Error("Tables are not available in this launch");
    const table = this.tables.get(context.runId, sheet.table);
    const rows: SheetCell[][] = [table.columns.map((column) => column.name), ...table.rows.map((row) => [...row])];
    return { ...sheet, rows, headings: true };
  }
  /** The pictures the slides ask for, read back from what this task made earlier. */
  private async pictures(value: WriteDocumentInput, context: ToolContext): Promise<Map<string, Buffer>> {
    const wanted = [...new Set(value.slides.map((slide) => slide.picture).filter(Boolean))];
    const found = new Map<string, Buffer>();
    if (!wanted.length) return found;
    if (!this.artifacts) throw new Error("Pictures made during a task are not available in this launch");
    for (const name of wanted.slice(0, 40)) {
      const kind = name.split(".").pop()?.toLowerCase() ?? "";
      if (!pictureKinds[kind]) throw new Error(`${name} is not a kind of picture that can go in a slide`);
      found.set(name, await this.artifacts.read(`${this.artifacts.root}/${context.runId}/${name}`)
        .catch(() => { throw new Error(`${name} was not made during this task, so it cannot go in a slide`); }));
    }
    return found;
  }

  /** Changes a Word or spreadsheet file, keeping every part the change did not touch as it was. */
  async edit(input: unknown, context: ToolContext): Promise<Record<string, unknown>> {
    const value = EditDocumentSchema.parse(input);
    const kind = value.path.toLowerCase().endsWith(".docx") ? "docx"
      : value.path.toLowerCase().endsWith(".xlsx") ? "xlsx" : null;
    if (!kind) throw new Error("Only Word (.docx) and spreadsheet (.xlsx) files can be changed in place");
    const before = await this.read(value.path);
    const done = editPackage(before, kind, value.changes);
    const target = value.saveAs || value.path;
    if (context.dryRun) return { wouldChange: target, changes: done.changes, notes: done.notes };
    if (done.changes) await this.save(target, done.bytes, context);
    return {
      path: target, changes: done.changes, notes: done.notes, partsChanged: done.partsTouched,
      partsKeptExactly: unchangedParts(before, done.bytes).length, limits: [liveCoworkLimit],
      ...(done.changes ? {} : { note: "Nothing matched, so the file was left alone." }),
    };
  }
  private async read(path: string): Promise<Buffer> {
    const handle = await open(await this.files.checked(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("That path is not a file");
      if (info.size > writtenBytesLimit) throw new Error(`Documents up to ${writtenBytesLimit / 1048576} MB can be changed`);
      return await readFile(handle);
    } finally { await handle.close(); }
  }
  /**
   * The same before-and-after the ordinary file tools use, so a document the assistant wrote can be
   * undone exactly like any other change it made to the person's files.
   */
  private async save(path: string, bytes: Buffer, context: ToolContext): Promise<void> {
    const target = await this.files.checkedForWrite(path);
    const token = this.observer ? await this.observer.before(path, context) : undefined;
    await mkdir(dirname(target), { recursive: true });
    await this.files.checkedForWrite(path);
    await writeFile(target, bytes, { mode: 0o600 });
    if (this.observer) await this.observer.after(path, context, token);
  }
}
/** What was written, in the words the panel shows: sections, sheets and rows, or slides. */
function counts(value: WriteDocumentInput, format: WriteFormat): Record<string, number> {
  if (format === "xlsx") return { sheets: value.sheets.length, rows: value.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) };
  if (format === "pptx") return { slides: value.slides.length };
  return { blocks: value.blocks.length };
}

export function registerDocumentAuthoring(registry: ToolRegistry, authoring: DocumentAuthoring): void {
  registry.register({
    name: "documents.write", group: "documents", permission: "files.write",
    description: "Write a Word (.docx), spreadsheet (.xlsx), slide (.pptx), Markdown or web-page file into the person's workspace from headings, paragraphs, lists, tables, sheets or slides.",
    parameters: WriteDocumentSchema,
    execute: async (input, context) => authoring.write(input, context),
  });
  registry.register({
    name: "documents.edit", group: "documents", permission: "files.write",
    description: "Change a Word or spreadsheet file in place: replace wording, add a section, update a table, add or replace a sheet. Every part the change does not touch is kept exactly as it was.",
    parameters: EditDocumentSchema,
    // hardening-3: the file written is `saveAs` when it is given, so that is what a folder rule is told.
    target: (input) => input.saveAs || input.path,
    // mac7/multi-target: with `saveAs` the source is read and the new file written; without it the file is changed.
    targets: (input) => (input.saveAs ? [{ kind: "read", path: input.path }, { kind: "write", path: input.saveAs }] : [{ kind: "write", path: input.path }]),
    execute: async (input, context) => authoring.edit(input, context),
  });
}
