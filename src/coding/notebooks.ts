import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";

/**
 * R17-042: a Jupyter notebook read as its cells — number, kind, source and what each cell printed —
 * instead of as one long JSON file the model has to pick apart. Pictures a cell drew are named, not
 * carried (the idea of replacing image data with a placeholder is Cline's, Apache-2.0,
 * `apps/vscode/src/integrations/misc/notebook-utils.ts`; this is written for Branch).
 */
export const maxNotebookBytes = 8 * 1024 * 1024;
const cellTextLimit = 6000;
const answerLimit = 48_000;
const pictureTypes = ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"];

export const NotebookReadSchema = z.object({
  path: z.string().min(1).max(500).refine((value) => value.toLowerCase().endsWith(".ipynb"), "A notebook file ends in .ipynb"),
  /** First and last cell to read, counting from 1. */
  from: z.number().int().min(1).max(100000).default(1),
  to: z.number().int().min(1).max(100000).optional(),
  outputs: z.boolean().default(true),
}).strict();

export interface NotebookCell { number: number; kind: string; language: string; source: string; outputs: string[]; clipped: boolean }
export interface NotebookView { path: string; language: string; cells: NotebookCell[]; totalCells: number; moreFrom: number | null }

const joined = (value: unknown): string => (Array.isArray(value) ? value.map(String).join("") : typeof value === "string" ? value : "");
const clip = (text: string): { text: string; clipped: boolean } =>
  text.length > cellTextLimit ? { text: `${text.slice(0, cellTextLimit)}\n… (cut here)`, clipped: true } : { text, clipped: false };

/** One output of a code cell in words: printed text, a result, an error, or a named picture. */
export function outputText(output: Record<string, unknown>): string {
  if (output.output_type === "stream") return joined(output.text);
  if (output.output_type === "error") return `${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`;
  const data = (output.data ?? {}) as Record<string, unknown>;
  const picture = pictureTypes.find((type) => type in data);
  if (typeof data["text/plain"] !== "undefined") return joined(data["text/plain"]) + (picture ? ` [picture: ${picture}]` : "");
  if (picture) return `[picture: ${picture}]`;
  const kinds = Object.keys(data);
  return kinds.length ? `[output of kind ${kinds.join(", ")}]` : "";
}

/** The cells of a notebook's text, in the range asked for. Throws a plain sentence on a file that is not one. */
export function notebookCells(text: string, input: { from: number; to?: number | undefined; outputs: boolean }): Omit<NotebookView, "path"> {
  let parsed: { cells?: unknown; metadata?: { language_info?: { name?: unknown }; kernelspec?: { language?: unknown } } };
  try { parsed = JSON.parse(text); } catch { throw new Error("This file is not a notebook: it is not JSON."); }
  if (!parsed || !Array.isArray(parsed.cells)) throw new Error("This file is not a notebook: it has no cells.");
  const language = String(parsed.metadata?.language_info?.name ?? parsed.metadata?.kernelspec?.language ?? "");
  const all = parsed.cells as Record<string, unknown>[];
  const last = Math.min(input.to ?? all.length, all.length);
  const cells: NotebookCell[] = [];
  let used = 0, moreFrom: number | null = null;
  for (let index = input.from - 1; index < last; index++) {
    const cell = all[index] ?? {};
    const source = clip(joined(cell.source));
    const outputs = input.outputs && Array.isArray(cell.outputs)
      ? (cell.outputs as Record<string, unknown>[]).map(outputText).filter(Boolean).map((line) => clip(line).text) : [];
    const size = source.text.length + outputs.join("").length;
    if (cells.length && used + size > answerLimit) { moreFrom = index + 1; break; }
    used += size;
    cells.push({ number: index + 1, kind: String(cell.cell_type ?? "unknown"), language: cell.cell_type === "code" ? language : "",
      source: source.text, outputs, clipped: source.clipped });
  }
  return { language, cells, totalCells: all.length, moreFrom };
}

export async function readNotebook(files: WorkspaceFiles, input: z.infer<typeof NotebookReadSchema>): Promise<NotebookView> {
  const path = await files.checked(input.path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("That notebook is not a file.");
  if (info.size > maxNotebookBytes) throw new Error("That notebook is larger than 8 MB, so it is not read whole. Clear its outputs first.");
  return { path: input.path, ...notebookCells(await readFile(path, "utf8"), input) };
}

export function registerNotebooks(registry: ToolRegistry, files: WorkspaceFiles): void {
  registry.register({
    name: "notebook.read", permission: "files.read", group: "code",
    description: "Read a Jupyter notebook (.ipynb) as numbered cells: kind, source and what each cell printed. Pictures are named, not included. Use from/to for a range; moreFrom says where to carry on.",
    parameters: NotebookReadSchema,
    // It reads one notebook, so the rules judge that file (its from/to are cell numbers, not places).
    target: (input) => input.path,
    targets: (input) => [{ kind: "read" as const, path: input.path }],
    execute: (input) => readNotebook(files, input),
  });
}
