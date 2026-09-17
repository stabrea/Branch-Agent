import type { CodeTag } from "./code-tags.js";

/**
 * Ranking a project's declarations the way Aider's repository map does (A0334), then fitting the
 * best of them into a token budget.
 *
 * Every file is a node. A file that uses a name another file declares gets an edge to it, weighted
 * by how telling the name is and how often it is used. A personalised PageRank over that graph,
 * started from the files the request is about, says which files matter; each file's rank is then
 * shared out over the names it points at, so the declarations come out in order of importance. The
 * outline is the longest prefix of that order that fits the budget, found by halving.
 *
 * Adapted from Aider's `aider/repomap.py` (Apache-2.0, Aider-AI and contributors;
 * see THIRD_PARTY_NOTICES.md). The weights are Aider's; the graph, PageRank and outline are written
 * here without networkx or tree-sitter.
 */
export interface RankInput {
  path: string;
  defs: CodeTag[];
  refs: ReadonlyMap<string, number>;
}
export interface RankOptions {
  /** Files already in front of the assistant: their uses count 50 times, and they are not outlined. */
  focus?: ReadonlySet<string>;
  /** Names the request spelled out. */
  mentioned?: ReadonlySet<string>;
  /** Extra starting weight per file (from words in the request that match its path or names). */
  personal?: ReadonlyMap<string, number>;
}
interface Edge { from: string; to: string; weight: number; name: string }

/** How much a name says about where to look: Aider's multipliers. */
function nameWeight(name: string, definers: number, mentioned: ReadonlySet<string> | undefined): number {
  let weight = 1;
  const snake = name.includes("_") && /[A-Za-z]/.test(name);
  const kebab = name.includes("-") && /[A-Za-z]/.test(name);
  const camel = /[A-Z]/.test(name) && /[a-z]/.test(name);
  if (mentioned?.has(name)) weight *= 10;
  if ((snake || kebab || camel) && name.length >= 8) weight *= 10;
  if (name.startsWith("_")) weight *= 0.1;
  if (definers > 5) weight *= 0.1;
  return weight;
}

/** The edges of the graph: user of a name → declarer of that name. */
export function referenceEdges(files: readonly RankInput[], options: RankOptions = {}): Edge[] {
  const definers = new Map<string, Set<string>>();
  for (const file of files)
    for (const def of file.defs) definers.set(def.name, (definers.get(def.name) ?? new Set()).add(file.path));
  const edges: Edge[] = [];
  for (const [name, where] of definers) {
    const users = files.filter((file) => file.refs.has(name));
    if (!users.length) {
      for (const definer of where) edges.push({ from: definer, to: definer, weight: 0.1, name });
      continue;
    }
    const base = nameWeight(name, where.size, options.mentioned);
    for (const user of users) {
      const weight = base * (options.focus?.has(user.path) ? 50 : 1) * Math.sqrt(user.refs.get(name)!);
      for (const definer of where) edges.push({ from: user.path, to: definer, weight, name });
    }
  }
  return edges;
}

/**
 * Personalised PageRank by power iteration, as networkx computes it: dangling nodes and the random
 * jump both return to the personal weights. Starting from those weights too means a file nothing
 * leads to stays at exactly zero.
 */
export function pageRank(nodes: readonly string[], edges: readonly Edge[], personal?: ReadonlyMap<string, number>, damping = 0.85): Map<string, number> {
  const jump = jumpWeights(nodes, personal);
  const outWeight = new Map<string, number>();
  for (const edge of edges) outWeight.set(edge.from, (outWeight.get(edge.from) ?? 0) + edge.weight);
  let rank = new Map(jump);
  for (let round = 0; round < 100; round++) {
    const next = new Map<string, number>(nodes.map((node) => [node, 0]));
    let dangling = 0;
    for (const node of nodes) if (!outWeight.get(node)) dangling += rank.get(node) ?? 0;
    for (const edge of edges)
      next.set(edge.to, next.get(edge.to)! + damping * (rank.get(edge.from) ?? 0) * edge.weight / outWeight.get(edge.from)!);
    let change = 0;
    for (const node of nodes) {
      const value = next.get(node)! + (damping * dangling + 1 - damping) * (jump.get(node) ?? 0);
      next.set(node, value);
      change += Math.abs(value - (rank.get(node) ?? 0));
    }
    rank = next;
    if (change < nodes.length * 1e-6) break;
  }
  return rank;
}
function jumpWeights(nodes: readonly string[], personal?: ReadonlyMap<string, number>): Map<string, number> {
  const total = [...(personal?.values() ?? [])].reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!personal || total <= 0) return new Map(nodes.map((node) => [node, 1 / Math.max(1, nodes.length)]));
  return new Map(nodes.map((node) => [node, Math.max(0, personal.get(node) ?? 0) / total]));
}

/** One line of the order: a declaration, or a file that is worth naming even with nothing to show. */
export type RankedEntry = { path: string; def: CodeTag; defs: readonly CodeTag[]; score: number } | { path: string; def?: undefined; score: number };
export interface Ranking { entries: RankedEntry[]; fileRank: Map<string, number>; edges: Edge[] }

/** Every declaration in order of importance, then the files that have none worth showing. */
export function rankDeclarations(files: readonly RankInput[], options: RankOptions = {}): Ranking {
  const nodes = files.map((file) => file.path);
  const edges = referenceEdges(files, options);
  const personal = new Map(options.personal ?? []);
  for (const path of options.focus ?? []) personal.set(path, (personal.get(path) ?? 0) + 100 / Math.max(1, nodes.length));
  const fileRank = pageRank(nodes, edges, personal.size ? personal : undefined);
  const shares = new Map<string, number>();
  const outWeight = new Map<string, number>();
  for (const edge of edges) outWeight.set(edge.from, (outWeight.get(edge.from) ?? 0) + edge.weight);
  for (const edge of edges) {
    const key = `${edge.to}\u0000${edge.name}`;
    shares.set(key, (shares.get(key) ?? 0) + (fileRank.get(edge.from) ?? 0) * edge.weight / outWeight.get(edge.from)!);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entries: RankedEntry[] = [];
  const named = new Set<string>();
  for (const [key, score] of [...shares].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const [path, name] = key.split("\u0000") as [string, string];
    if (options.focus?.has(path) || score <= 0) continue;
    const file = byPath.get(path)!;
    for (const def of file.defs.filter((item) => item.name === name)) entries.push({ path, def, defs: file.defs, score });
    named.add(path);
  }
  for (const path of [...nodes].sort((a, b) => (fileRank.get(b) ?? 0) - (fileRank.get(a) ?? 0) || a.localeCompare(b)))
    if (!named.has(path) && !options.focus?.has(path)) entries.push({ path, score: fileRank.get(path) ?? 0 });
  return { entries, fileRank, edges };
}

/**
 * The outline of the chosen entries: each file's name, then the lines of the chosen declarations
 * with the lines of whatever they sit inside, and "⋮" where lines were skipped — Aider's layout.
 */
export function renderOutline(entries: readonly RankedEntry[]): string {
  const byFile = new Map<string, { defs: readonly CodeTag[]; chosen: Set<number> } | null>();
  for (const entry of entries) {
    if (!entry.def) { if (!byFile.has(entry.path)) byFile.set(entry.path, null); continue; }
    const known = byFile.get(entry.path) ?? { defs: entry.defs, chosen: new Set<number>() };
    known.chosen.add(entry.defs.indexOf(entry.def));
    byFile.set(entry.path, known);
  }
  const parts: string[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const file = byFile.get(path);
    if (!file) { parts.push(`${path}\n`); continue; }
    parts.push(`${path}:\n${outlineLines(file.defs, file.chosen).join("\n")}\n`);
  }
  return parts.join("\n").split("\n").map((line) => line.slice(0, 100)).join("\n");
}
function outlineLines(defs: readonly CodeTag[], chosen: ReadonlySet<number>): string[] {
  const shown = new Set<number>();
  for (const index of chosen)
    for (let at = index; at >= 0 && !shown.has(at); at = defs[at]!.parent) shown.add(at);
  const lines: string[] = [];
  let last = 0;
  for (const index of [...shown].sort((a, b) => defs[a]!.line - defs[b]!.line)) {
    const def = defs[index]!;
    if (def.line > last + 1) lines.push("⋮");
    lines.push(`│${def.text}`);
    last = def.line;
  }
  lines.push("⋮");
  return lines;
}

/** A rough token count: about four characters to a token, the same rule used elsewhere in Branch. */
export const outlineTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * The longest prefix of the order whose outline fits the budget, found by halving, and accepted
 * early when it is within 15% of the budget (Aider's rule).
 */
export function fitOutline(entries: readonly RankedEntry[], budget: number): { text: string; tokens: number; used: number } {
  let low = 0, high = entries.length;
  let middle = Math.min(Math.floor(budget / 25), entries.length);
  let best = { text: "", tokens: 0, used: 0 };
  while (low <= high) {
    const text = renderOutline(entries.slice(0, middle));
    const tokens = outlineTokens(text);
    const off = Math.abs(tokens - budget) / budget;
    if ((tokens <= budget && tokens > best.tokens) || (off < 0.15 && tokens <= budget * 1.15)) {
      best = { text, tokens, used: middle };
      if (off < 0.15) break;
    }
    if (tokens < budget) low = middle + 1;
    else high = middle - 1;
    middle = Math.floor((low + high) / 2);
  }
  return best;
}
