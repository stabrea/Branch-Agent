import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceFiles } from "./files.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceSearch, searchLimits, type WalkEntry } from "./code-search.js";
import { mapLanguageOf, scanSource, type SourceSymbol } from "./code-scanners.js";

/**
 * A map of the project: every file the assistant may read, what kind of file it is, the names it
 * declares, and which other files it pulls in. It is built once and then kept up to date file by
 * file — a file whose size and time of last change have not moved is never read again — so asking
 * for the map a second time costs a folder listing.
 *
 * The names come from small regular expressions, one per language, not from a real parser. That is
 * said plainly in the documentation as well: the map is for finding your way around, not for
 * deciding what a program means.
 */
export interface MapFileEntry {
  path: string;
  bytes: number;
  language: string;
  symbols: SourceSymbol[];
  /** Workspace paths this file pulls in; anything from outside the workspace is left out. */
  imports: string[];
}
export interface ProjectMapResult {
  files: MapFileEntry[];
  /** How many files were read this time, and how many were answered from what was already known. */
  scanned: number;
  cached: number;
  truncated: boolean;
}
export interface RankedFile { path: string; language: string; score: number; why: string; symbols: string[] }

const maxFileBytes = 512 * 1024;
const scriptEndings = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface Cached { key: string; entry: MapFileEntry }

export class ProjectMap {
  private readonly cache = new Map<string, Cached>();
  private readonly search: WorkspaceSearch;
  constructor(private readonly files: WorkspaceFiles) {
    this.search = new WorkspaceSearch(files);
  }
  /** Forgets everything, so the next map reads every file again. */
  clear(): void { this.cache.clear(); }

  /** The whole map, reading only the files that have changed since last time. */
  async build(path = ".", limit = 400): Promise<ProjectMapResult> {
    const walk = await this.search.walk(path, limit);
    const entries: MapFileEntry[] = [];
    let scanned = 0, cached = 0;
    const live = new Set<string>();
    for (const file of walk.entries) {
      live.add(file.path);
      const hit = this.cache.get(file.path);
      const key = `${file.mtimeMs}:${file.bytes}`;
      if (hit?.key === key) { cached++; entries.push(hit.entry); continue; }
      scanned++;
      const entry = await this.read(file);
      this.cache.set(file.path, { key, entry });
      entries.push(entry);
    }
    for (const known of [...this.cache.keys()]) if (!live.has(known)) this.cache.delete(known);
    resolveImports(entries);
    return { files: entries, scanned, cached, truncated: walk.truncated };
  }

  private async read(file: WalkEntry): Promise<MapFileEntry> {
    const language = mapLanguageOf(file.path);
    const base = { path: file.path, bytes: file.bytes, language };
    if (language === "Other" || file.bytes > maxFileBytes) return { ...base, symbols: [], imports: [] };
    const text = await readFile(join(this.files.base, file.path), "utf8").catch(() => "");
    const scan = scanSource(file.path, text);
    return { ...base, symbols: scan.symbols, imports: scan.imports };
  }

  /**
   * The map ordered for one request: the files whose path and declared names match the words that
   * were asked about come first, and a file those files pull in (or that pulls them in) is lifted
   * with them, because the answer is very often next door.
   */
  async rank(request: string, limit = 20, path = "."): Promise<{ files: RankedFile[]; considered: number }> {
    const map = await this.build(path);
    const words = wordsOf(request);
    const direct = new Map<string, number>();
    for (const file of map.files) {
      const score = scoreFile(file, words);
      if (score > 0) direct.set(file.path, score);
    }
    const scores = spreadThroughImports(map.files, direct);
    const ranked = map.files
      .map((file) => ({ file, score: scores.get(file.path) ?? 0 }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, limit)
      .map(({ file, score }): RankedFile => ({
        path: file.path, language: file.language, score: Math.round(score * 10) / 10,
        why: direct.has(file.path) ? "the words you used appear here" : "it is connected to a file that matches",
        symbols: file.symbols.slice(0, 8).map((symbol) => symbol.name),
      }));
    return { files: ranked, considered: map.files.length };
  }
}

/**
 * Everyday English words carry no signal about which file to read, and a short one such as "the"
 * turns up inside longer names ("weather"), so they are dropped before anything is scored.
 */
const commonWords = new Set([
  "the", "and", "for", "with", "from", "that", "this", "where", "what", "when", "which", "who",
  "how", "why", "into", "out", "does", "did", "was", "were", "are", "is", "it", "its", "you",
  "your", "our", "not", "but", "can", "should", "would", "code", "file", "files", "please", "find",
  "show", "tell", "make", "add", "use", "using", "there", "here", "about", "all", "any", "one",
  "worked", "work", "works", "done", "new", "old", "get", "set", "run",
]);
/** The words worth matching on: three letters or more, and the parts of any dotted or slashed name. */
export function wordsOf(request: string): string[] {
  const parts = request.toLowerCase().split(/[^a-z0-9_$]+/).flatMap((word) => [word, ...word.split(/[_$]/)]);
  return [...new Set(parts.filter((word) => word.length >= 3 && !commonWords.has(word)))].slice(0, 20);
}

/**
 * How well one file answers to those words: its path counts once, each name it declares counts
 * more. A part-of-a-word match only counts for words of four letters or more, so a short word
 * hiding inside a longer name does not drag an unrelated file to the top.
 */
function scoreFile(file: MapFileEntry, words: string[]): number {
  const path = file.path.toLowerCase();
  let score = 0;
  for (const word of words) {
    const partial = word.length >= 4;
    if (partial && path.includes(word)) score += 4;
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase();
      if (name === word) score += 6;
      else if (partial && name.includes(word)) score += 2;
    }
  }
  return score;
}

/** Neighbours of a matching file get a share of its score, once, so the map stays shallow. */
function spreadThroughImports(files: MapFileEntry[], direct: Map<string, number>): Map<string, number> {
  const scores = new Map(direct);
  const importedBy = new Map<string, string[]>();
  for (const file of files)
    for (const target of file.imports) importedBy.set(target, [...(importedBy.get(target) ?? []), file.path]);
  const add = (path: string, value: number) => scores.set(path, (scores.get(path) ?? 0) + value);
  for (const [path, score] of direct) {
    const here = files.find((file) => file.path === path);
    for (const target of here?.imports ?? []) add(target, score * 0.3);
    for (const source of importedBy.get(path) ?? []) add(source, score * 0.3);
  }
  return scores;
}

/**
 * Turns what an import line said into a path inside the workspace, and drops anything that points
 * outside it (a package from the internet, a part of the standard library).
 */
function resolveImports(entries: MapFileEntry[]): void {
  const known = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    const resolved = entry.imports
      .map((target) => (entry.language === "Python" ? pythonTarget(entry.path, target, known) : scriptTarget(entry.path, target, known)))
      .filter((target): target is string => target !== null);
    entry.imports = [...new Set(resolved)];
  }
}

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
/** Joins a folder and a relative target, resolving "." and ".." without leaving the workspace. */
function joinRelative(folder: string, target: string): string | null {
  const parts = folder ? folder.split("/") : [];
  for (const step of target.split("/")) {
    if (step === "." || step === "") continue;
    if (step === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(step);
  }
  return parts.join("/");
}

/** A TypeScript or JavaScript import: relative only, with the usual endings tried in turn. */
function scriptTarget(from: string, target: string, known: Set<string>): string | null {
  if (!target.startsWith(".")) return null;
  const base = joinRelative(folderOf(from), target);
  if (base === null) return null;
  const withoutEnding = base.replace(/\.[cm]?jsx?$/, "");
  for (const ending of ["", ...scriptEndings]) {
    if (known.has(`${withoutEnding}${ending}`)) return `${withoutEnding}${ending}`;
    if (known.has(`${withoutEnding}/index${ending}`)) return `${withoutEnding}/index${ending}`;
  }
  return null;
}

/** A Python import: "pkg.mod" as a folder path, and leading dots as steps back up. */
function pythonTarget(from: string, target: string, known: Set<string>): string | null {
  const up = /^\.+/.exec(target)?.[0].length ?? 0;
  const rest = target.slice(up).split(".").filter(Boolean).join("/");
  const base = up
    ? joinRelative(folderOf(from), `${"../".repeat(Math.max(0, up - 1))}${rest}`)
    : rest;
  if (base === null || !base) return null;
  for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`])
    if (known.has(candidate)) return candidate;
  return null;
}

/** Trims the map to what fits comfortably in one tool answer. */
export function compactMap(result: ProjectMapResult, symbolsPerFile: number): ProjectMapResult {
  const files: MapFileEntry[] = [];
  let bytes = 0;
  let truncated = result.truncated;
  for (const file of result.files) {
    const trimmed = { ...file, symbols: file.symbols.slice(0, symbolsPerFile) };
    const size = JSON.stringify(trimmed).length + 2;
    if (bytes + size > searchLimits.answerBytes) { truncated = true; break; }
    bytes += size;
    files.push(trimmed);
  }
  return { ...result, files, truncated };
}

export function registerProjectMap(registry: ToolRegistry, map: ProjectMap): void {
  registry.register({
    name: "code.map", permission: "files.read", group: "code",
    description: "A map of the project: every file, what kind it is, the names it declares and which other files it pulls in. Give what you are looking for as \"request\" and the files most likely to hold the answer come first. The names are found by pattern, not by a real parser.",
    parameters: z.object({
      path: z.string().min(1).max(500).default("."),
      /** What you are looking for, in your own words; the answer is ordered around it. */
      request: z.string().trim().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(400).default(200),
      symbolsPerFile: z.number().int().min(0).max(40).default(12),
    }).strict(),
    execute: async (args) => {
      if (args.request) return map.rank(args.request, Math.min(args.limit, 50), args.path);
      return compactMap(await map.build(args.path, args.limit), args.symbolsPerFile);
    },
  });
}
