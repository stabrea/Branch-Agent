import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceFiles } from "./files.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceSearch, searchLimits, type WalkEntry } from "./code-search.js";
import { mapLanguageOf, scanSource, type SourceSymbol } from "./code-scanners.js";
import { extraLanguageOf, hasTagRules, tagSource, type TagScan } from "./code-tags.js";
import { fitOutline, rankDeclarations, type RankInput, type RankedEntry } from "./code-rank.js";

/**
 * A map of the project: every file the assistant may read, what kind of file it is, the names it
 * declares, and which other files it pulls in. It is built once and then kept up to date file by
 * file — a file whose size and time of last change have not moved is never read again — so asking
 * for the map a second time costs a folder listing.
 *
 * The names come from a small comment- and string-aware reader per language (src/code-tags.ts), not
 * from a real parser. That is said plainly in the documentation as well: the map is for finding your
 * way around, not for deciding what a program means. Ranking follows Aider's repository map
 * (src/code-rank.ts): who uses whose names, a personalised PageRank, and a token budget.
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

interface Cached { key: string; entry: MapFileEntry; tags: TagScan }
/** The map as the ranking reads it: every file with its declarations and the names it uses. */
interface TaggedMap { result: ProjectMapResult; tagged: RankInput[] }
export interface OutlineResult { outline: string; tokens: number; budget: number; declarations: number; considered: number; truncated: boolean }

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
    return (await this.buildTagged(path, limit)).result;
  }

  private async buildTagged(path: string, limit: number): Promise<TaggedMap> {
    const walk = await this.search.walk(path, limit);
    const entries: MapFileEntry[] = [];
    let scanned = 0, cached = 0;
    const tagged: RankInput[] = [];
    const live = new Set<string>();
    for (const file of walk.entries) {
      live.add(file.path);
      const key = `${file.mtimeMs}:${file.bytes}`;
      let hit = this.cache.get(file.path);
      if (hit?.key === key) cached++;
      else {
        scanned++;
        hit = { key, ...(await this.read(file)) };
        this.cache.set(file.path, hit);
      }
      entries.push({ ...hit.entry, imports: [...hit.entry.imports] });
      tagged.push({ path: file.path, defs: hit.tags.defs, refs: hit.tags.refs });
    }
    for (const known of [...this.cache.keys()]) if (!live.has(known)) this.cache.delete(known);
    resolveImports(entries);
    return { result: { files: entries, scanned, cached, truncated: walk.truncated }, tagged };
  }

  private async read(file: WalkEntry): Promise<{ entry: MapFileEntry; tags: TagScan }> {
    const language = languageOf(file.path);
    const base = { path: file.path, bytes: file.bytes, language };
    const none: TagScan = { defs: [], refs: new Map() };
    if (language === "Other" || file.bytes > maxFileBytes) return { entry: { ...base, symbols: [], imports: [] }, tags: none };
    const text = await readFile(join(this.files.base, file.path), "utf8").catch(() => "");
    const scan = scanSource(file.path, text);
    const tags = hasTagRules(file.path) ? tagSource(file.path, text) : none;
    const symbols = hasTagRules(file.path)
      ? tags.defs.slice(0, maxMapSymbols).map((def): SourceSymbol => ({ name: def.name, kind: def.kind, line: def.line }))
      : scan.symbols;
    return { entry: { ...base, symbols, imports: scan.imports }, tags };
  }

  /**
   * The map ordered for one request: the files whose path and declared names match the words that
   * were asked about start the ranking, the graph of who uses whose names carries it on (Aider's
   * PageRank), and a file those files pull in, or that pulls them in, is lifted with them.
   */
  async rank(request: string, limit = 20, path = "."): Promise<{ files: RankedFile[]; considered: number }> {
    const { result, tagged } = await this.buildTagged(path, 400);
    const words = wordsOf(request);
    const direct = new Map<string, number>();
    for (const file of result.files) {
      const score = scoreFile(file, words);
      if (score > 0) direct.set(file.path, score);
    }
    if (!direct.size) return { files: [], considered: result.files.length };
    const ranking = rankDeclarations(tagged, { personal: direct, mentioned: mentionedNames(tagged, words) });
    const scores = combineScores(result.files, direct, ranking.fileRank, ranking.edges);
    const order = symbolOrder(ranking.entries);
    const ranked = result.files
      .map((file) => ({ file, score: scores.get(file.path) ?? 0 }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, limit)
      .map(({ file, score }): RankedFile => ({
        path: file.path, language: file.language, score: Math.round(score * 10) / 10,
        why: direct.has(file.path) ? "the words you used appear here" : "it is connected to a file that matches",
        symbols: (order.get(file.path) ?? file.symbols.map((symbol) => symbol.name)).slice(0, 8),
      }));
    return { files: ranked, considered: result.files.length };
  }

  /**
   * Aider's repository map: the most important declarations of the project, with the lines they sit
   * inside, as much as fits in `budget` tokens. `focus` names files already in front of the assistant;
   * they steer the ranking and are left out of the outline.
   */
  async outline(options: { budget: number; request?: string | undefined; focus?: string[] | undefined; path?: string | undefined; limit?: number | undefined }): Promise<OutlineResult> {
    const { result, tagged } = await this.buildTagged(options.path ?? ".", options.limit ?? 400);
    const words = options.request ? wordsOf(options.request) : [];
    const personal = new Map<string, number>();
    for (const file of result.files) {
      const score = scoreFile(file, words);
      if (score > 0) personal.set(file.path, score);
    }
    const ranking = rankDeclarations(tagged, {
      personal, focus: new Set(options.focus ?? []), mentioned: mentionedNames(tagged, words),
    });
    const entries = [...importantFiles(result.files, options.focus ?? []), ...ranking.entries];
    const fitted = fitOutline(entries, options.budget);
    return {
      outline: fitted.text, tokens: fitted.tokens, budget: options.budget,
      declarations: entries.slice(0, fitted.used).filter((entry) => entry.def).length,
      considered: result.files.length, truncated: result.truncated || fitted.used < entries.length,
    };
  }
}

const maxMapSymbols = 60;
const languageOf = (path: string): string => {
  const known = mapLanguageOf(path);
  return known === "Other" ? extraLanguageOf(path) ?? "Other" : known;
};

/** Files Aider always names first because they tell you what a project is. */
const importantNames = new Set(["readme.md", "package.json", "pyproject.toml", "setup.py", "cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "makefile", "dockerfile", "tsconfig.json", "requirements.txt", "gemfile", "composer.json"]);
function importantFiles(files: readonly MapFileEntry[], focus: readonly string[]): RankedEntry[] {
  return files
    .filter((file) => !file.path.includes("/") && importantNames.has(file.path.toLowerCase()) && !focus.includes(file.path))
    .map((file): RankedEntry => ({ path: file.path, score: 0 }));
}

/** Declared names the request spelled out, either as one word or as two neighbouring words run together. */
function mentionedNames(tagged: readonly RankInput[], words: readonly string[]): Set<string> {
  const wanted = new Set(words);
  for (let index = 0; index + 1 < words.length; index++) wanted.add(`${words[index]}${words[index + 1]}`);
  const found = new Set<string>();
  for (const file of tagged)
    for (const def of file.defs) if (wanted.has(def.name.toLowerCase().replace(/[_-]/g, ""))) found.add(def.name);
  return found;
}

/** Each file's declared names, most important first. */
function symbolOrder(entries: ReturnType<typeof rankDeclarations>["entries"]): Map<string, string[]> {
  const order = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.def) continue;
    const names = order.get(entry.path) ?? [];
    if (!names.includes(entry.def.name)) names.push(entry.def.name);
    order.set(entry.path, names);
  }
  return order;
}

/**
 * The final score: the words' own match, plus the PageRank share scaled to the same range, plus a
 * share for the neighbours (by import or by use) of each matching file, once, so the list stays shallow.
 */
function combineScores(files: readonly MapFileEntry[], direct: Map<string, number>, fileRank: Map<string, number>,
  edges: readonly { from: string; to: string }[]): Map<string, number> {
  const top = Math.max(...direct.values());
  const topRank = Math.max(0, ...fileRank.values());
  const scores = new Map(direct);
  const add = (path: string, value: number) => scores.set(path, (scores.get(path) ?? 0) + value);
  if (topRank > 0) for (const [path, rank] of fileRank) if (rank > 0 && scores.has(path)) add(path, top * rank / topRank);
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
  };
  for (const file of files) for (const target of file.imports) link(file.path, target);
  for (const edge of edges) link(edge.from, edge.to);
  for (const [path, score] of direct)
    for (const other of neighbours.get(path) ?? []) add(other, score * 0.3 + (topRank > 0 ? top * (fileRank.get(other) ?? 0) / topRank * 0.3 : 0));
  return scores;
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
    description: "A map of the project: every file, what kind it is, the names it declares and which other files it pulls in. Give what you are looking for as \"request\" and the files most likely to hold the answer come first. Give \"tokens\" (a budget) for an outline of the most important declarations, ranked by who uses whose names; \"focus\" names files you already have. The names are found by a light reader, not a real parser.",
    parameters: z.object({
      path: z.string().min(1).max(500).default("."),
      /** What you are looking for, in your own words; the answer is ordered around it. */
      request: z.string().trim().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(400).default(200),
      symbolsPerFile: z.number().int().min(0).max(40).default(12),
      /** Give a token budget to get Aider's outline instead: the most important declarations, with their surroundings. */
      tokens: z.number().int().min(100).max(16000).optional(),
      /** Files you already have open; they steer the outline and are left out of it. */
      focus: z.array(z.string().min(1).max(500)).max(50).optional(),
    }).strict(),
    execute: async (args) => {
      if (args.tokens) return map.outline({ budget: args.tokens, request: args.request, focus: args.focus, path: args.path });
      if (args.request) return map.rank(args.request, Math.min(args.limit, 50), args.path);
      return compactMap(await map.build(args.path, args.limit), args.symbolsPerFile);
    },
  });
}
