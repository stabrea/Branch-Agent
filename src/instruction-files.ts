import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { WorkspaceFiles } from "./files.js";
import { ignoreMatcher } from "./ignore.js";

/**
 * The folder's own instructions (audit A0689, A0111, A0042, A0219).
 *
 * Many folders carry a note for AI assistants: `AGENTS.md`, or `CLAUDE.md` / `GEMINI.md` from
 * other tools. Branch reads them from the top of the workspace down to the folder a task works
 * in, one file per folder (`AGENTS.md` first, the others only when it is missing). A deeper folder's
 * note is read the first time the task touches a file in that folder, and handed back beside that
 * tool's result, so a big workspace does not load every note it has up front.
 *
 * A note can pull in another with a line like `@docs/style.md`, up to five levels deep; a note that
 * would include itself again is left out. Everything goes through the same checks as the file
 * tools (no leaving the workspace, no links, no secret-looking names, `.branchignore` respected),
 * `.gitignore` is respected when there is no `.branchignore`, and every file and the whole set are
 * capped in size.
 *
 * Paths here are written relative to the workspace root, not to the active project's folder:
 * the notes above a project's folder apply to it too. The shape follows Gemini CLI's
 * `memoryDiscovery.ts` and `memoryImportProcessor.ts` and Goose's `hints/` (both Apache-2.0).
 */
export const instructionFileNames = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
export const instructionLimits = Object.freeze({
  /** Characters kept from one file. */
  perFile: 16_000,
  /** Characters kept from all the notes one task is given. */
  total: 48_000,
  /** How deep `@file.md` imports may nest. */
  importDepth: 5,
  /** How many folders deep the notes are looked for. */
  folderDepth: 16,
});

export interface InstructionFile { path: string; text: string }

/** "." and every folder on the way down to `folder`, root first. */
export function foldersDownTo(folder: string): string[] {
  const clean = posix.normalize(folder.replace(/\\/g, "/") || ".").replace(/\/+$/, "");
  if (clean === "." || clean === ".." || clean.startsWith("../") || posix.isAbsolute(clean)) return ["."];
  const parts = clean.split("/").filter(Boolean).slice(0, instructionLimits.folderDepth);
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Reads the workspace's notes the way the file tools would, with `.gitignore` as a fallback. */
export class InstructionReader {
  private readonly files: WorkspaceFiles;
  constructor(readonly root: string) {
    // A reader of its own over the whole workspace: paths are root-relative even when the active
    // project narrows the file tools to a subfolder.
    this.files = new WorkspaceFiles(root);
  }

  /** The note for one folder: `AGENTS.md`, or the first fallback that exists. */
  async folderNote(folder: string, budget: { left: number }): Promise<InstructionFile | null> {
    for (const name of instructionFileNames) {
      const path = folder === "." ? name : `${folder}/${name}`;
      const found = await this.expand(path, budget, [], 0);
      if (found !== null) return { path, text: found };
    }
    return null;
  }

  /** One file with its imports put in place, or null when it cannot or may not be read. */
  private async expand(path: string, budget: { left: number }, chain: string[], depth: number): Promise<string | null> {
    const loaded = await this.readOne(path);
    if (!loaded) return null;
    if (chain.includes(loaded.identity)) return `(left out: ${path} would include itself again)`;
    const room = Math.min(instructionLimits.perFile, budget.left);
    if (room <= 0) return `(left out: ${path}, the instructions are already at their size limit)`;
    const clipped = loaded.text.length > room ? `${loaded.text.slice(0, room)}\n(cut short: ${path} is longer than the limit)` : loaded.text;
    budget.left -= Math.min(loaded.text.length, room);
    return this.imports(clipped, posix.dirname(path), budget, [...chain, loaded.identity], depth);
  }

  /** Replaces each `@path.md` outside code blocks with that file's text. */
  private async imports(text: string, folder: string, budget: { left: number }, chain: string[], depth: number): Promise<string> {
    const lines = text.split("\n");
    let fenced = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const match = /^\s*@(\S+\.md)\s*$/i.exec(line);
      if (!match) continue;
      lines[index] = await this.importOne(match[1]!, folder, budget, chain, depth);
    }
    return lines.join("\n");
  }

  private async importOne(asked: string, folder: string, budget: { left: number }, chain: string[], depth: number): Promise<string> {
    const target = posix.normalize(posix.join(folder, asked.replace(/^\.\//, "")));
    if (asked.startsWith("/") || target.startsWith("..") || asked.includes("\\"))
      return `(left out: @${asked} is outside the workspace)`;
    if (depth + 1 > instructionLimits.importDepth) return `(left out: @${asked}, imports nest more than ${instructionLimits.importDepth} deep)`;
    const inner = await this.expand(target, budget, chain, depth + 1);
    if (inner === null) return `(left out: @${asked} could not be read)`;
    return `<!-- from ${target} -->\n${inner}\n<!-- end of ${target} -->`;
  }

  private async readOne(path: string): Promise<{ text: string; identity: string } | null> {
    try {
      if (await this.gitIgnored(path)) return null;
      const absolute = await this.files.checked(path);
      const { content } = await this.files.read(path);
      const info = await stat(absolute);
      // The same file under another spelling (a case-insensitive disk) is still the same file.
      return { text: content, identity: `${info.dev}:${info.ino}` };
    } catch {
      return null;
    }
  }

  /** `.gitignore` in the workspace root, used only when there is no `.branchignore`. */
  private async gitIgnored(path: string): Promise<boolean> {
    try { await stat(join(this.root, ".branchignore")); return false; } catch { /* no .branchignore */ }
    try {
      const matcher = ignoreMatcher(await readFile(join(this.root, ".gitignore"), "utf8"));
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++)
        if (matcher.ignores(parts.slice(0, index).join("/"), true)) return true;
      return matcher.ignores(path);
    } catch {
      return false;
    }
  }
}

/**
 * One task's notes: the ones it started with, and the ones it picked up as it went into deeper
 * folders. Each folder is read once per task. `allowed` says whether a folder's notes may be read
 * at all (see src/folder-trust.ts).
 */
export class TaskInstructions {
  private readonly seen = new Set<string>();
  private readonly budget = { left: instructionLimits.total };
  constructor(private readonly reader: InstructionReader, private readonly allowed: (folder: string) => boolean) {}

  /** The notes from the workspace top down to the folder the task starts in. */
  async opening(folder: string): Promise<InstructionFile[]> {
    return this.collect(foldersDownTo(folder));
  }

  /** The notes a file at `path` (root-relative) brings that this task has not had yet. */
  async touched(path: string): Promise<InstructionFile[]> {
    const folder = posix.dirname(path.replace(/\\/g, "/"));
    return this.collect(foldersDownTo(folder));
  }

  private async collect(folders: string[]): Promise<InstructionFile[]> {
    const found: InstructionFile[] = [];
    for (const folder of folders) {
      if (this.seen.has(folder)) continue;
      this.seen.add(folder);
      if (!this.allowed(folder)) continue;
      const note = await this.reader.folderNote(folder, this.budget);
      if (note) found.push(note);
    }
    return found;
  }
}

/** The notes as the text the model is given. */
export function instructionText(files: InstructionFile[], opening: boolean): string {
  if (!files.length) return "";
  const head = opening
    ? "Instructions the owner keeps in this workspace's folders (AGENTS.md and similar). Follow them for work in those folders unless the person asks otherwise:"
    : "This folder has its own instructions (AGENTS.md or similar). Follow them for work in this folder unless the person asks otherwise:";
  return [head, ...files.map((file) => `\n## ${file.path}\n${file.text.trim()}`)].join("\n");
}
