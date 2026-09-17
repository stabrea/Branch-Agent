import type { ToolDescription } from "./contracts.js";
import { estimateTokens } from "./contracts.js";
import { expandToolName, inferToolGroup, unrecognisedOpenUpTo, type CatalogGroup, type CatalogStats } from "./catalog.js";
import { ToolIndex, expandQuery, indexLine, type ToolEmbedder, type ToolEntry, type ToolIndexOptions } from "./tool-index.js";

/**
 * Deciding, every round, which tools travel with the request. Three tiers:
 *
 *   loaded    the whole description and its inputs, ready to call
 *   indexed   one line — name and eight words — so the model knows the tool exists
 *   deferred  not in the request at all, and found only by searching for it
 *
 * The tools the task is always allowed (core), the ones it has just used, the ones it asked for
 * and the ones this computer has learned it needs are loaded; everything else is scored on the
 * words of the request. A hard ceiling on the whole tool section is then applied by moving the
 * weakest loaded tools down, so a thousand installed tools cost no more than a dozen.
 */
export const toolSearchName = "tools.search";
export const toolDescribeName = "tools.describe";
export const toolNoteName = "tools.note";
/** The whole tool section of one request, in estimated tokens. */
export const defaultToolBudgetTokens = 2500;
/** How many one-line tools the index may advertise. */
export const defaultIndexLines = 40;
/**
 * How many tools may travel in full at once, on top of the core ones. A task works on a handful
 * of tools at a time; the rest are a line in the index or a search away, so opening a large
 * toolbox no longer means carrying all of it.
 */
export const defaultMaxLoaded = 12;
/** Tools loaded by name never fall below this many rounds of stickiness. */
const searchedBonus = 400, expandedBonus = 60, recentBonus = 90, preloadBonus = 220, staleePenalty = 5;

/**
 * Finding tools by meaning as well as by words is off until the owner turns it on, because it
 * sends something out of this computer. This is the sentence they are shown before they decide.
 */
export const meaningSearchExplanation = (
  /** Who receives it, named: the connection that compares writing, as the owner set it up. */
  receiver = "the model you have connected for comparing writing",
): string =>
  "Branch finds a tool by the words in your request. Turn this on and it will also compare "
  + "what you asked for against what each tool says it does, which means sending your request, "
  + `and one line about each tool, to ${receiver}. `
  + "Nothing else about the request, and nothing you have saved, goes with it.";
/** Where the choice is kept. False, and nothing about a request is ever sent for this. */
export const meaningSearchSetting = "tool-meaning-search";
/** Whether the owner has turned it on. Read fresh, so turning it off takes effect at once. */
export function meaningSearchOn(
  store: { get(kind: string, owner: string, id: string): { data: unknown } | undefined }, owner: string,
): boolean {
  return (store.get("settings", owner, meaningSearchSetting)?.data as { enabled?: unknown } | undefined)?.enabled === true;
}

export interface PreloadedTool { name: string; reason: string }
export interface ToolLoaderOptions {
  /** Toolboxes open from the first round; their tools are strongly preferred. */
  expanded?: readonly string[];
  /** A tool used within this many rounds stays loaded. */
  recentRounds?: number;
  groupOf?: (name: string) => string;
  external?: (name: string) => boolean;
  noteOf?: (name: string) => string;
  budgetTokens?: number;
  indexLines?: number;
  /** The most tools that may travel in full at once, besides the core ones. */
  maxLoaded?: number;
  /** What past tasks say this one will need, loaded before the first round. */
  preload?: readonly PreloadedTool[];
  /** Tools nobody has used for a long time: not advertised unless the task asks for them. */
  demoted?: readonly string[];
  /** The words of the task, used to score what is worth listing. */
  signals?: { prompt?: string; recent?: readonly string[]; project?: string };
  /** Set only when the owner has switched meaning search on; otherwise searching is by words. */
  embedder?: ToolEmbedder;
}
export interface LoaderStats extends CatalogStats {
  loaded: number;
  indexed: number;
  deferred: number;
  budgetTokens: number;
  preloadedFromHistory: string[];
}
interface Plan {
  loaded: ToolEntry[];
  indexed: ToolEntry[];
  deferred: number;
  descriptions: ToolDescription[];
}

export class ToolLoader {
  private index: ToolIndex;
  private readonly byName = new Map<string, ToolDescription>();
  /**
   * Where each tool sits in the registry. The tool section is sent in this order rather than in
   * score order, so the part of a request a provider can cache does not shuffle when the
   * assistant simply uses one of the tools it already had.
   */
  private readonly order = new Map<string, number>();
  private readonly expandedGroups = new Set<string>(["core"]);
  /** Toolboxes the assistant opened itself: an explicit ask, preferred over a guess. */
  private readonly openedGroups = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly usedAt = new Map<string, number>();
  private readonly asked = new Set<string>();
  private readonly preloaded: PreloadedTool[];
  private readonly demoted: Set<string>;
  private readonly recentRounds: number;
  private readonly budgetTokens: number;
  private readonly indexLines: number;
  private readonly maxLoaded: number;
  private readonly groupOf: (name: string) => string;
  private readonly signals: { prompt?: string; recent?: readonly string[]; project?: string };
  private round = 0;
  private version = 0;
  private cached: { at: number; plan: Plan } | undefined;
  constructor(private all: readonly ToolDescription[], options: ToolLoaderOptions = {}) {
    this.groupOf = options.groupOf ?? inferToolGroup;
    this.recentRounds = options.recentRounds ?? 3;
    this.budgetTokens = options.budgetTokens ?? defaultToolBudgetTokens;
    this.indexLines = options.indexLines ?? defaultIndexLines;
    this.maxLoaded = options.maxLoaded ?? defaultMaxLoaded;
    this.signals = options.signals ?? {};
    this.demoted = new Set(options.demoted ?? []);
    this.index = new ToolIndex(all, options);
    if (options.embedder) this.index.embedder = options.embedder;
    this.take(all);
    for (const group of options.expanded ?? []) this.expandedGroups.add(group);
    this.preloaded = (options.preload ?? []).filter((entry) => this.byName.has(entry.name));
    for (const entry of this.preloaded) this.asked.add(entry.name);
  }
  /** What history said to load before the first round, and why. */
  preloadedFromHistory(): PreloadedTool[] { return [...this.preloaded]; }
  /**
   * Takes in tools that arrived while the task was working — a server that has just connected, a
   * plugin the owner switched on — so they are searchable from the next round. Everything the task
   * has already opened, found or used is kept.
   */
  refresh(tools: readonly ToolDescription[], options: ToolIndexOptions = {}): void {
    this.all = tools;
    const embedder = this.index.embedder;
    this.index = new ToolIndex(tools, { groupOf: this.groupOf, ...options });
    if (embedder) this.index.embedder = embedder;
    this.take(tools);
    this.version++;
  }
  /** Files every tool by name, by toolbox and by the place it holds in the registry. */
  private take(tools: readonly ToolDescription[]): void {
    this.byName.clear(); this.counts.clear(); this.order.clear();
    for (const [at, tool] of tools.entries()) {
      this.byName.set(tool.name, tool);
      this.order.set(tool.name, at);
      const group = this.groupOf(tool.name);
      this.counts.set(group, (this.counts.get(group) ?? 0) + 1);
    }
  }
  nextRound(): void { this.round++; this.version++; }
  noteUse(name: string): void { this.usedAt.set(name, this.round); this.version++; }
  groups(): CatalogGroup[] {
    return [...this.counts].map(([group, tools]) => ({ group, tools, expanded: this.isOpen(group) }));
  }
  /**
   * Whether a toolbox is open. "other" holds tools whose names the product does not recognise — an
   * installed skill, a connected server — so nothing in the words of a request can point at them
   * and nothing would bring them back. A handful stay in view; once there are enough of them to be
   * worth hiding, they close and are reached by searching like everything else.
   */
  private isOpen(group: string): boolean {
    return this.expandedGroups.has(group) || this.smallUnknownBox(group);
  }
  private smallUnknownBox(group: string): boolean {
    return group === "other" && (this.counts.get(group) ?? 0) <= unrecognisedOpenUpTo;
  }
  /** Opens toolboxes, the older way of finding tools, now a shortcut over the same index. */
  expand(names: readonly string[]): { opened: string[]; unknown: string[]; tools: { name: string; description: string }[] } {
    const known = new Set(this.counts.keys());
    const opened: string[] = [], unknown: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim().toLowerCase();
      if (!known.has(name)) unknown.push(name);
      else if (!this.openedGroups.has(name)) { this.expandedGroups.add(name); this.openedGroups.add(name); opened.push(name); }
    }
    this.version++;
    const inOpened = new Set(opened);
    return { opened, unknown, tools: this.index.entries.filter((entry) => inOpened.has(entry.group))
      .map((entry) => ({ name: entry.name, description: entry.purpose })) };
  }
  /**
   * Finds tools by what the person wants to do. Only tools this task is already allowed to use are
   * in the index at all, so a narrowed task can never find one it is not permitted; every match
   * stays loaded for the rest of the conversation, as far as the budget allows.
   */
  async search(query: string, limit = 8): Promise<{ matches: { name: string; purpose: string; use: string }[]; searched: string }> {
    const wanted = Math.min(Math.max(1, limit), 20);
    const hits = this.index.embedder
      ? await this.index.searchByMeaning(query, wanted) : this.index.search(query, wanted);
    for (const hit of hits) this.asked.add(hit.entry.name);
    this.version++;
    return { searched: String(query).slice(0, 200), matches: hits.map((hit) => ({
      name: hit.entry.name, purpose: hit.entry.purpose,
      use: hit.entry.note || `Call ${hit.entry.name}; its inputs are in the tool list from your next step.`,
    })) };
  }
  /** Loads named tools. A name this task may not use is unknown here, exactly like a misspelling. */
  describe(names: readonly string[]): { loaded: { name: string; purpose: string }[]; unknown: string[] } {
    const loaded: { name: string; purpose: string }[] = [], unknown: string[] = [];
    for (const raw of names.slice(0, 16)) {
      const name = String(raw).trim();
      const entry = this.index.entry(name);
      if (!entry) { unknown.push(name); continue; }
      this.asked.add(name);
      loaded.push({ name, purpose: entry.purpose });
    }
    this.version++;
    return { loaded, unknown };
  }
  /** What this task has done counts on top of the words: asked for, opened, or used just now. */
  private bonusFor(entry: ToolEntry): number {
    let score = 0;
    if (this.asked.has(entry.name)) score += this.preloaded.some((p) => p.name === entry.name) ? preloadBonus : searchedBonus;
    // A tool nothing in a request can point at has to be carried or it is lost, so a small box of
    // unrecognised names counts as strongly as a toolbox the assistant opened on purpose.
    if (this.openedGroups.has(entry.group) || this.smallUnknownBox(entry.group)) score += searchedBonus;
    else if (this.expandedGroups.has(entry.group)) score += expandedBonus;
    if (this.justUsed(entry)) score += recentBonus;
    if (this.demoted.has(entry.name)) score -= staleePenalty;
    return score;
  }
  /**
   * A tool the assistant has called in the last few rounds. It is in the middle of using it, so it
   * keeps its place whatever else is competing for one: a tool that vanishes between the call and
   * the follow-up call leaves the task stuck.
   */
  private justUsed(entry: ToolEntry): boolean {
    const at = this.usedAt.get(entry.name);
    return at !== undefined && this.round - at <= this.recentRounds;
  }
  descriptions(): ToolDescription[] { return this.plan().descriptions; }
  stats(): LoaderStats {
    const plan = this.plan();
    const characters = JSON.stringify(plan.descriptions).length;
    return {
      tools: this.all.length, shown: plan.descriptions.length, groups: this.counts.size,
      collapsed: this.groups().filter((group) => !group.expanded).length,
      characters, estimatedTokens: Math.ceil(characters / 4),
      loaded: plan.loaded.length, indexed: plan.indexed.length, deferred: plan.deferred,
      budgetTokens: this.budgetTokens, preloadedFromHistory: this.preloaded.map((entry) => entry.name),
    };
  }
  /** What is loaded, listed and left out this round. Worked out once and reused within the round. */
  private plan(): Plan {
    if (this.cached && this.cached.at === this.version) return this.cached.plan;
    const terms = queryTerms(this.signals);
    // Ties are broken by the order tools were registered in, never by their names. Opening a large
    // toolbox scores most of its tools the same, so the cap below decides which of them travel; when
    // that decision went alphabetically, registering one new tool whose name happened to sort early
    // silently pushed an existing one out, and the test that noticed was in another area entirely.
    // Registration order keeps what is already there in place and puts anything new at the back.
    const scored = this.index.entries.map((entry, at) => {
      const lexical = this.index.score(terms, entry);
      return { entry, at, lexical, score: lexical + this.bonusFor(entry) };
    }).sort((a, b) => b.score - a.score || a.at - b.at);
    const core = scored.filter((hit) => hit.entry.group === "core").map((hit) => hit.entry);
    const rest = scored.filter((hit) => hit.entry.group !== "core");
    const candidates = rest.filter((hit) => hit.score > 0 && (this.asked.has(hit.entry.name)
      || this.isOpen(hit.entry.group) || this.usedAt.has(hit.entry.name)));
    // Tools in use come first and are never squeezed out by the cap; the rest fill what is left,
    // best first, and are the ones the ceiling takes back if the section is still too heavy.
    const inUse = candidates.filter((hit) => this.justUsed(hit.entry));
    const others = candidates.filter((hit) => !this.justUsed(hit.entry));
    const wanted = [...inUse, ...others.slice(0, Math.max(0, this.maxLoaded - inUse.length))];
    // Only tools the words of the request actually point at are worth a line; the rest are a
    // search away, and saying so once costs less than naming forty tools nobody asked about.
    const listable = rest.filter((hit) => hit.lexical > 0 && !this.demoted.has(hit.entry.name)).map((hit) => hit.entry);
    const plan = this.fit(core, wanted.map((hit) => hit.entry), listable, rest.length);
    this.cached = { at: this.version, plan };
    return plan;
  }
  /**
   * Brings the tool section under its ceiling. The weakest loaded tool is moved down to a line in
   * the index first, and only when nothing but the core is left is the index itself trimmed; each
   * step is strictly smaller than the one before, so this always terminates under the budget.
   */
  private fit(core: ToolEntry[], wanted: ToolEntry[], listable: ToolEntry[], total: number): Plan {
    let loaded = [...wanted];
    let lines = this.indexLines;
    for (let step = 0; step <= wanted.length + this.indexLines; step++) {
      const shown = new Set(loaded.map((entry) => entry.name));
      const indexed = listable.filter((entry) => !shown.has(entry.name)).slice(0, lines);
      const deferred = total - loaded.length - indexed.length;
      const descriptions = this.render([...core, ...loaded], indexed, deferred);
      if (estimateTokens(descriptions) < this.budgetTokens || (!loaded.length && !lines))
        return { loaded: [...core, ...loaded], indexed, deferred, descriptions };
      if (loaded.length) loaded = loaded.slice(0, -1);
      else lines = Math.max(0, lines - 4);
    }
    return { loaded: core, indexed: [], deferred: total, descriptions: this.render(core, [], total) };
  }
  /** The tool list as the model receives it: full tools, then the index, then the toolbox opener. */
  private render(loaded: readonly ToolEntry[], indexed: readonly ToolEntry[], deferred: number): ToolDescription[] {
    const full = [...loaded].sort((a, b) => Number(a.group !== "core") - Number(b.group !== "core")
      || (this.order.get(a.name) ?? 0) - (this.order.get(b.name) ?? 0)).map((entry) => {
      const base = this.byName.get(entry.name)!;
      return { name: base.name, parameters: base.parameters,
        description: entry.note ? `${entry.description} Remembered: ${entry.note}` : entry.description };
    });
    const closed = this.groups().filter((group) => !group.expanded && group.tools);
    return [...full, searchTool(indexed, deferred, this.index.size), describeTool(), noteTool(),
      ...(closed.length ? [opener(closed)] : [])];
  }
}

const queryTerms = (signals: { prompt?: string; recent?: readonly string[]; project?: string }): string[] =>
  [...new Set(expandQuery([signals.prompt ?? "", (signals.recent ?? []).join(" "), signals.project ?? ""].join(" ")))];

/** The searcher, carrying the short index of tools that are not loaded this round. */
function searchTool(indexed: readonly ToolEntry[], deferred: number, total: number): ToolDescription {
  const listed = indexed.length ? `\nSome of what is here:\n${indexed.map(indexLine).join("\n")}` : "";
  return {
    name: toolSearchName,
    description: `Find a tool by saying what you want to do, in your own words. There are ${total} tools on this computer and ${deferred} of them are not described in this message at all; searching is how you reach them, and anything you find stays available afterwards. Search before saying a task cannot be done.${listed}`,
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  };
}
const describeTool = (): ToolDescription => ({
  name: toolDescribeName,
  description: "Load tools you already know the exact names of, so you can call them. A name that is not here is unknown.",
  parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
});
const noteTool = (): ToolDescription => ({
  name: toolNoteName,
  description: "Remember one short thing about a tool for next time, such as a value it always needs. The person can read and delete these.",
  parameters: { type: "object", properties: { tool: { type: "string" }, note: { type: "string" } }, required: ["tool", "note"] },
});
function opener(closed: CatalogGroup[]): ToolDescription {
  const list = closed.map((group) => `${group.group}: ${group.tools}`).join("; ");
  return {
    name: expandToolName,
    description: `Open a whole toolbox at once when a task clearly belongs to one. Still closed — ${list}. Searching by what you want to do is usually quicker.`,
    parameters: { type: "object", properties: { groups: { type: "array", items: { type: "string", enum: closed.map((group) => group.group) } } }, required: ["groups"] },
  };
}
