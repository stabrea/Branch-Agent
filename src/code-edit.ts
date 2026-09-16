import { rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { z } from "zod";
import { lineDiff } from "./workspace-history.js";
import { languageOf } from "./code-search.js";
import type { WorkspaceFiles, WriteObserver } from "./files.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { parsePatch, applyHunks } from "./patch.js";

/**
 * Changing code precisely: applying a unified diff to one or more files, replacing an exact piece
 * of text, and checking afterwards that the file still reads as valid. A patch is all-or-nothing —
 * if any part of it does not fit the file exactly, nothing is written at all.
 */
export interface ChangeSummary { path: string; created: boolean; added: number; removed: number; diff: string }
/** One file's whole new text, worked out before anything is written. */
export interface PlannedChange { path: string; before: string | null; after: string }
const diffBudget = 20000;

export class CodeEditor {
  constructor(private readonly files: WorkspaceFiles, private readonly observer?: WriteObserver) {}

  /** The file's current text, or null when it does not exist yet. */
  private async original(path: string): Promise<string | null> {
    try {
      return (await this.files.read(path)).content;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (error instanceof Error && error.message.includes("32 KiB"))
        throw new Error(`"${path}" is larger than 32 KiB, which these tools cannot change`);
      throw error;
    }
  }

  /** Applies a whole unified diff or nothing at all. */
  async patch(text: string, context: ToolContext): Promise<{ files: ChangeSummary[] }> {
    return { files: await this.writeAll(await this.planPatch(text), context) };
  }

  /**
   * Works out what a unified diff would do to every file it names, without writing anything. A
   * part that does not fit throws here, before a single file has been touched.
   */
  async planPatch(text: string): Promise<PlannedChange[]> {
    const planned: PlannedChange[] = [];
    for (const file of parsePatch(text)) {
      const before = await this.original(file.path);
      if (file.created && before !== null)
        throw new Error(`Patch refused: "${file.path}" already exists but the patch creates it`);
      planned.push({ path: file.path, before, after: applyHunks(file, before) });
    }
    return planned;
  }

  /** What a planned set of changes looks like written down, with nothing written. */
  preview(planned: PlannedChange[]): ChangeSummary[] {
    const summaries: ChangeSummary[] = [];
    for (const item of planned) summaries.push(summarise(item.path, item.before, item.after, summaries));
    return summaries;
  }

  /** Writes every planned file; a failure part-way puts the files already written back as they were. */
  async writeAll(
    planned: PlannedChange[],
    context: ToolContext,
  ): Promise<ChangeSummary[]> {
    const done: { path: string; before: string | null }[] = [];
    const summaries: ChangeSummary[] = [];
    try {
      for (const item of planned) {
        await this.save(item.path, item.after, context);
        done.push({ path: item.path, before: item.before });
        summaries.push(summarise(item.path, item.before, item.after, summaries));
      }
    } catch (error) {
      for (const item of done.reverse()) await this.undo(item.path, item.before);
      throw error;
    }
    return summaries;
  }

  private async undo(path: string, before: string | null): Promise<void> {
    try {
      if (before === null) await rm(await this.files.checked(path), { force: true });
      else await this.files.write(path, before, AbortSignal.timeout(10000));
    } catch { /* The rollback is best effort; the original failure is what the caller sees. */ }
  }

  private async save(path: string, content: string, context: ToolContext): Promise<void> {
    const token = this.observer ? await this.observer.before(path, context) : undefined;
    await this.files.write(path, content, context.signal);
    if (this.observer) await this.observer.after(path, context, token);
  }

  /** Replaces an exact piece of text; refuses when the number of matches is not what was expected. */
  async edit(
    input: { path: string; find: string; replace: string; expectedOccurrences: number },
    context: ToolContext,
  ): Promise<ChangeSummary> {
    const before = await this.original(input.path);
    if (before === null) throw new Error(`Edit refused: "${input.path}" does not exist`);
    const found = before.split(input.find).length - 1;
    if (found !== input.expectedOccurrences)
      throw new Error(
        `Edit refused: "${input.path}" contains that text ${found} time(s), but ${input.expectedOccurrences} was expected`,
      );
    const after = before.split(input.find).join(input.replace);
    await this.save(input.path, after, context);
    return summarise(input.path, before, after, []);
  }
}

function summarise(path: string, before: string | null, after: string, sofar: ChangeSummary[]): ChangeSummary {
  const { added, removed, diff } = lineDiff(before ?? "", after);
  const used = sofar.reduce((total, item) => total + item.diff.length, 0);
  return {
    path, created: before === null, added, removed,
    diff: used + diff.length > diffBudget ? "(change too large to show here)" : diff,
  };
}

export interface ValidationProblem { message: string; line?: number }
export interface Validation {
  path: string; language: string; checked: boolean; ok: boolean;
  problems: ValidationProblem[]; note?: string;
}

/** Reports whether a file still reads as valid. Problems come back as data, never as a failure. */
export async function validateFile(files: WorkspaceFiles, path: string): Promise<Validation> {
  const language = languageOf(path);
  const absolute = await files.checked(path);
  if (!(await stat(absolute)).isFile()) throw new Error(`"${path}" is not a file`);
  if (language === "JSON") return jsonValidation(path, (await files.read(path)).content);
  if (/\.(m|c)?js$/i.test(path)) return scriptValidation(path, absolute);
  const note = /\.(m|c)?tsx?$/i.test(path)
    ? "Checking TypeScript needs the TypeScript compiler, which this app does not carry at run time."
    : `There is no built-in check for ${language} files.`;
  return { path, language, checked: false, ok: true, problems: [], note };
}

function jsonValidation(path: string, content: string): Validation {
  try {
    JSON.parse(content);
    return { path, language: "JSON", checked: true, ok: true, problems: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = /line (\d+)/.exec(message)?.[1];
    return {
      path, language: "JSON", checked: true, ok: false,
      problems: [{ message, ...(line ? { line: Number(line) } : {}) }],
    };
  }
}

/**
 * Uses this app's own Node to check the file's syntax. `--check` parses the file and stops; it
 * never runs it. The host-command runner is not used: it needs a configured alias, refuses while
 * another command is running, and is meant for commands the owner chose.
 */
function scriptValidation(path: string, absolute: string): Promise<Validation> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--check", absolute], { timeout: 10000, windowsHide: true }, (error, _out, stderr) => {
      if (!error) { resolve({ path, language: "JavaScript", checked: true, ok: true, problems: [] }); return; }
      const text = String(stderr).trim();
      const message = /^(?:SyntaxError|.*Error):.*$/m.exec(text)?.[0] ?? "This file could not be parsed";
      const line = new RegExp(`${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(text)?.[1];
      resolve({
        path, language: "JavaScript", checked: true, ok: false,
        problems: [{ message: message.slice(0, 500), ...(line ? { line: Number(line) } : {}) }],
      });
    });
  });
}

const pathSchema = z.string().min(1).max(500);
export function registerCodeEdit(registry: ToolRegistry, files: WorkspaceFiles, editor: CodeEditor): void {
  registry.register({
    name: "files.patch", permission: "files.write",
    description: "Apply a set of changes to workspace files. Nothing changes unless every part fits exactly.",
    parameters: z.object({ patch: z.string().min(1).max(131072) }).strict(),
    execute: async (a, c: ToolContext) => editor.patch(a.patch, c),
  });
  registry.register({
    name: "files.edit", permission: "files.write",
    description: "Replace an exact piece of text in a workspace file, refusing when it appears a different number of times than expected.",
    parameters: z.object({
      path: pathSchema,
      find: z.string().min(1).max(32768),
      replace: z.string().max(32768),
      expectedOccurrences: z.number().int().min(1).max(100).default(1),
    }).strict(),
    execute: async (a, c: ToolContext) => editor.edit(a, c),
  });
  registry.register({
    name: "files.validate", permission: "files.read",
    description: "Check that a workspace file still reads as valid (JSON and JavaScript). Problems come back as a list to read, not as a failure.",
    parameters: z.object({ path: pathSchema }).strict(),
    execute: async (a) => validateFile(files, a.path),
  });
}
