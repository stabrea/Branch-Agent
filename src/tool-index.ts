import { createHash } from "node:crypto";
import { detectInjection } from "./content-guard.js";
import { inferToolGroup, maxToolDescriptionChars } from "./catalog.js";
import type { ToolDescription } from "./contracts.js";

/**
 * Everything the assistant could possibly do, written down once so it can be searched instead of
 * carried. A registered tool costs nothing here until it is either listed in the short index or
 * loaded in full, so a computer with a thousand tools on it still sends a small request.
 *
 * Text from a connected server or a plugin is somebody else's writing. It is capped and read for
 * instructions aimed at the assistant on the way in, so no request can ever carry the raw words.
 */
export interface ToolEntry {
  name: string;
  group: string;
  /** Safe, capped description: what goes in a request when this tool is loaded. */
  description: string;
  /** Eight words at most, for the one-line index. */
  purpose: string;
  params: string[];
  /** What the owner or a past failure taught about this tool. */
  note: string;
  external: boolean;
  /** Words this tool is found by. */
  terms: string[];
  /** How often each of those words appears, so scoring never rescans the list. */
  counts: Map<string, number>;
  /** sha256 of the description: the key an embedding cache would use. */
  digest: string;
}

/** A tool from outside whose description read like instructions keeps its name and nothing else. */
export const withheldDescription =
  "From a connected server. Its own description was held back because it read like instructions to the assistant.";
const withheldPurpose = "description withheld";
/** Descriptions from outside get their own cap, so it can be tightened without touching the rest. */
export const maxExternalDescriptionChars = 200;

/**
 * A seam for searching by meaning as well as by words. Nothing implements it yet: the embeddings
 * service arrives with the document search work, and until it does every search here is lexical.
 */
export interface ToolEmbedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

const stop = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "it", "is", "my", "me", "that", "this", "with", "from", "by", "at", "as", "be", "can", "use", "used", "using"]);

/**
 * Cutting a word back to its stem so "schedule", "schedules" and "scheduled" are one word. Both the
 * tools and the query go through this, so the two sides always agree on what a word is.
 */
export function stemWord(word: string): string {
  let out = word;
  if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("es")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) out = out.slice(0, -1);
  return out.length > 3 && out.endsWith("e") ? out.slice(0, -1) : out;
}
const plainWords = (text: string): string[] =>
  (String(text).toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter((word) => word.length > 1 && !stop.has(word));
/** Words a piece of text is found by: lower case, split on anything that is not a letter or digit. */
export function toolTerms(text: string): string[] {
  return plainWords(text).map(stemWord);
}

/** Everyday words for the same thing, so "make a picture" finds the tool that says "image". */
const synonyms: Record<string, readonly string[]> = {
  picture: ["image", "photo"], photo: ["image", "picture"], image: ["picture", "photo"],
  screen: ["screenshot", "desktop", "display"], calendar: ["schedule", "reminder", "event"],
  pdf: ["document", "library"], discord: ["channel", "message", "chat"], telegram: ["channel", "message"],
  ollama: ["model", "local", "runtime"], download: ["fetch", "get", "save"], chart: ["plot", "graph", "data"],
  // "Save it somewhere" is how a person says "write a file"; without this the writing tools lose
  // to anything whose own description happens to use the word "save".
  save: ["write", "file", "store"], store: ["save", "write"], keep: ["save", "write"],
  spreadsheet: ["csv", "table", "data"], folder: ["directory", "file"], email: ["mail", "message"],
  remind: ["schedule", "reminder"], speak: ["voice", "speech", "audio"], transcribe: ["audio", "speech", "text"],
  webpage: ["web", "page", "browser"], repo: ["git", "repository"], commit: ["git"], password: ["secret", "locker"],
  remember: ["memory", "fact", "remembered"], decided: ["memory", "fact"], recall: ["memory", "fact"],
  message: ["channel", "chat", "send"], signin: ["browser", "account", "sign"], login: ["browser", "account", "sign"],
};

/** The query's own words plus the everyday words that mean the same thing. */
export function expandQuery(query: string): string[] {
  const words = plainWords(query);
  const extra = words.flatMap((word) => synonyms[word] ?? []);
  return [...new Set([...words, ...extra].map(stemWord))];
}

const firstWords = (text: string, count: number): string =>
  text.split(/\s+/).filter(Boolean).slice(0, count).join(" ").replace(/[,.;:]$/, "");

/** One tool's line in the index: its name, what it is for, and anything learned about it. */
export const indexLine = (entry: ToolEntry): string =>
  `${entry.name} — ${entry.purpose}${entry.note ? ` (${entry.note})` : ""}`;

/** Cleans a description that may have come from somewhere else before it can reach a request. */
export function safeDescription(text: string, external: boolean): { description: string; purpose: string } {
  const capped = String(text ?? "").slice(0, external ? maxExternalDescriptionChars : maxToolDescriptionChars).trim();
  if (external && detectInjection(capped).length) return { description: withheldDescription, purpose: withheldPurpose };
  return { description: capped, purpose: firstWords(capped, 8) || "no description" };
}

export interface ToolIndexOptions {
  groupOf?: (name: string) => string;
  external?: (name: string) => boolean;
  /** What has been learned about a tool, shown with its line and with its description. */
  noteOf?: (name: string) => string;
}

/** Every tool this run may use, ready to be searched by words. */
export class ToolIndex {
  readonly entries: ToolEntry[];
  private readonly byName = new Map<string, ToolEntry>();
  private readonly frequency = new Map<string, number>();
  private readonly averageLength: number;
  /** Declared but not used: search is lexical until the embeddings service is available. */
  embedder: ToolEmbedder | undefined;
  constructor(tools: readonly ToolDescription[], options: ToolIndexOptions = {}) {
    this.entries = tools.map((tool) => entryOf(tool, options));
    for (const entry of this.entries) {
      this.byName.set(entry.name, entry);
      for (const term of new Set(entry.terms)) this.frequency.set(term, (this.frequency.get(term) ?? 0) + 1);
    }
    const total = this.entries.reduce((sum, entry) => sum + entry.terms.length, 0);
    this.averageLength = this.entries.length ? total / this.entries.length : 1;
  }
  get size(): number { return this.entries.length; }
  entry(name: string): ToolEntry | undefined { return this.byName.get(name); }
  has(name: string): boolean { return this.byName.has(name); }
  /**
   * How well one tool answers a query, by the usual word-frequency measure: a word that few tools
   * use counts for more than one they all use, and an exact name match is worth a great deal.
   */
  score(terms: readonly string[], entry: ToolEntry): number {
    const k1 = 1.2, b = 0.75;
    let score = 0;
    for (const term of new Set(terms)) {
      const count = entry.counts.get(term) ?? 0;
      if (!count) continue;
      const documents = this.frequency.get(term) ?? 0;
      const rarity = Math.log(1 + (this.entries.length - documents + 0.5) / (documents + 0.5));
      score += rarity * (count * (k1 + 1)) / (count + k1 * (1 - b + b * (entry.terms.length / this.averageLength)));
    }
    return score;
  }
  /** The tools that best answer a query, best first. An exact tool name always comes back first. */
  search(query: string, limit = 8): { entry: ToolEntry; score: number }[] {
    const terms = expandQuery(query);
    const exact = this.byName.get(String(query).trim().toLowerCase());
    const ranked = this.entries
      .map((entry) => ({ entry, score: this.score(terms, entry) + (entry === exact ? 1000 : 0) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return ranked.slice(0, Math.max(1, limit));
  }
}

function entryOf(tool: ToolDescription, options: ToolIndexOptions): ToolEntry {
  const external = options.external?.(tool.name) ?? false;
  const { description, purpose } = safeDescription(tool.description, external);
  const group = options.groupOf?.(tool.name) ?? inferToolGroup(tool.name);
  const note = String(options.noteOf?.(tool.name) ?? "").slice(0, 120);
  const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  const params = properties && typeof properties === "object" ? Object.keys(properties).slice(0, 20) : [];
  const terms = [...toolTerms(tool.name), ...toolTerms(description), ...toolTerms(params.join(" ")), ...toolTerms(group), ...toolTerms(note)];
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return {
    name: tool.name, group, description, purpose, params, note, external, terms, counts,
    digest: createHash("sha256").update(description).digest("hex"),
  };
}
