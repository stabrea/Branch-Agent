import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { toolTerms } from "./tool-index.js";
import { detectInjection } from "./content-guard.js";
import type { PreloadedTool } from "./tool-loading.js";

/** A tool this computer decided to load before being asked, and the plain reason why. */
export type PreloadReason = PreloadedTool;

/**
 * What this computer has learned about its own tools. Every finished task leaves one row: the
 * shape of what was asked (hashed word pairs, never the words themselves), which tools were
 * searched for, which were actually called, whether it worked, and how many rounds it took.
 *
 * From that the assistant gets three habits: it loads the tools that requests like this one have
 * needed before, it loads tools that are nearly always used together, and it stops advertising
 * tools nobody has touched in a month. A fourth, notes, is written rather than inferred: when a
 * call fails and the next one works, or when the assistant is told something about a tool, a short
 * line is kept and shown with that tool from then on.
 *
 * All of it stays in the same database as everything else, travels with the backup, and can be
 * deleted in one move from the Developer card.
 */
export interface UsageInput {
  runId: string;
  prompt: string;
  searched: readonly string[];
  called: readonly string[];
  ok: boolean;
  rounds: number;
}
export interface ToolNote { id: string; tool: string; note: string; createdAt: string }
export interface CatalogHealth {
  /** One sentence a person can read. */
  summary: string;
  tools: { name: string; calls: number; lastUsed: string }[];
  runs: number;
  searches: number;
  /** How often a search was followed by calling something that was found. */
  searchHitRate: number;
  averageRoundTokens: number;
  at: string;
}
/** How long a tool may go unused before it stops being advertised. */
export const demoteAfterDays = 30;
/** A past task counts as "like this one" at this much word overlap. */
const similarEnough = 0.2;
/** How many past tasks are looked at; older ones are of little use and cost time. */
const recentRuns = 300;
export const NoteInputSchema = z.object({
  tool: z.string().trim().min(1).max(100),
  note: z.string().trim().min(1).max(160),
}).strict();

/** The shape of a request, as hashes of its words and word pairs. The words are not kept. */
export function promptShingles(prompt: string): string[] {
  const words = toolTerms(prompt).slice(0, 60);
  const pairs = words.slice(1).map((word, at) => `${words[at]} ${word}`);
  const hashed = [...words, ...pairs].map((gram) => createHash("sha256").update(gram).digest("hex").slice(0, 10));
  return [...new Set(hashed)].slice(0, 80);
}
const overlap = (a: readonly string[], b: ReadonlySet<string>): number => {
  if (!a.length || !b.size) return 0;
  const shared = a.filter((gram) => b.has(gram)).length;
  return shared / (a.length + b.size - shared);
};
const list = (value: unknown): string[] => {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};

interface UsageRow { shingles: string[]; called: string[]; searched: string[]; ok: boolean; createdAt: string }

export class ToolUsage {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_usage(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      run_id TEXT NOT NULL, shingles TEXT NOT NULL, searched TEXT NOT NULL, called TEXT NOT NULL,
      ok INTEGER NOT NULL, rounds INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_notes(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      tool TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  /** Keeps one finished task. Nothing is written for a task that called no tool at all. */
  record(owner: string, input: UsageInput, now = new Date()): void {
    if (!input.called.length && !input.searched.length) return;
    this.db.prepare("INSERT INTO tool_usage VALUES(?,?,?,?,?,?,?,?,?)").run(
      randomUUID(), owner, input.runId, JSON.stringify(promptShingles(input.prompt)),
      JSON.stringify([...new Set(input.searched)].slice(0, 40)), JSON.stringify([...new Set(input.called)].slice(0, 40)),
      input.ok ? 1 : 0, Math.max(0, Math.trunc(input.rounds)), now.toISOString());
  }
  private rows(owner: string, limit = recentRuns): UsageRow[] {
    return this.db.prepare("SELECT shingles,searched,called,ok,created_at FROM tool_usage WHERE owner=? ORDER BY rowid DESC LIMIT ?")
      .all(owner, limit).map((row) => ({
        shingles: list(row.shingles), searched: list(row.searched), called: list(row.called),
        ok: Number(row.ok) === 1, createdAt: String(row.created_at),
      }));
  }
  /**
   * The tools a request like this one has needed before, plus the ones that are nearly always used
   * alongside them, so an everyday request never has to spend a round looking for its own tools.
   */
  preload(owner: string, prompt: string, limit = 6): PreloadedTool[] {
    const want = new Set(promptShingles(prompt));
    const score = new Map<string, { score: number; runs: number }>();
    for (const row of this.rows(owner)) {
      const alike = overlap(row.shingles, want);
      if (!row.ok || alike < similarEnough) continue;
      for (const tool of row.called) {
        const seen = score.get(tool) ?? { score: 0, runs: 0 };
        score.set(tool, { score: seen.score + alike, runs: seen.runs + 1 });
      }
    }
    const chosen = [...score.entries()].filter(([, value]) => value.runs >= 2)
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, limit)
      .map(([name, value]) => ({ name, reason: `you asked for something like this ${value.runs} times before` }));
    return [...chosen, ...this.coUse(owner, chosen.map((entry) => entry.name), limit)].slice(0, limit * 2);
  }
  /** Tools that past tasks nearly always called together with these ones. */
  coUse(owner: string, names: readonly string[], limit = 4): PreloadedTool[] {
    if (!names.length) return [];
    const wanted = new Set(names);
    const together = new Map<string, number>();
    for (const row of this.rows(owner)) {
      if (!row.ok || !row.called.some((tool) => wanted.has(tool))) continue;
      for (const tool of row.called) if (!wanted.has(tool)) together.set(tool, (together.get(tool) ?? 0) + 1);
    }
    return [...together.entries()].filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
      .map(([name, count]) => ({ name, reason: `usually used together with ${names[0]} (${count} times)` }));
  }
  /** When each tool was last called. */
  lastUsed(owner: string): Map<string, string> {
    const last = new Map<string, string>();
    for (const row of this.rows(owner, 2000))
      for (const tool of row.called) if (!last.has(tool) || last.get(tool)! < row.createdAt) last.set(tool, row.createdAt);
    return last;
  }
  /** Tools that were used once but not for a long time: still findable, no longer advertised. */
  stale(owner: string, now = new Date(), days = demoteAfterDays): string[] {
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
    return [...this.lastUsed(owner)].filter(([, at]) => at < cutoff).map(([name]) => name).sort();
  }
  notes(owner: string): ToolNote[] {
    return this.db.prepare("SELECT id,tool,note,created_at FROM tool_notes WHERE owner=? ORDER BY created_at DESC LIMIT 200")
      .all(owner).map((row) => ({ id: String(row.id), tool: String(row.tool), note: String(row.note), createdAt: String(row.created_at) }));
  }
  /** The newest note for each tool, as the index and the descriptions show it. */
  noteMap(owner: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const note of this.notes(owner).reverse()) map.set(note.tool, note.note);
    return map;
  }
  /**
   * Keeps one short thing about a tool. The same note twice changes nothing.
   *
   * A note is shown with its tool in every later request, so it is read for instructions aimed at
   * the assistant first: otherwise a web page that talked the assistant into writing one could
   * leave words of its own sitting in the tool list for good.
   */
  addNote(owner: string, input: unknown, now = new Date()): ToolNote {
    const parsed = NoteInputSchema.parse(input);
    if (detectInjection(parsed.note).length)
      throw new Error("That note reads like instructions rather than something about the tool, so it was not kept");
    const existing = this.notes(owner).find((note) => note.tool === parsed.tool && note.note === parsed.note);
    if (existing) return existing;
    const note: ToolNote = { id: randomUUID(), ...parsed, createdAt: now.toISOString() };
    this.db.prepare("INSERT INTO tool_notes VALUES(?,?,?,?,?)").run(note.id, owner, note.tool, note.note, note.createdAt);
    return note;
  }
  removeNote(owner: string, id: string): { removed: boolean } {
    return { removed: this.db.prepare("DELETE FROM tool_notes WHERE owner=? AND id=?").run(owner, id).changes > 0 };
  }
  /** Forgets everything learned about tools. The tools themselves are untouched. */
  forget(owner: string, what: "history" | "notes" | "all" = "all"): { history: number; notes: number } {
    const history = what === "notes" ? 0 : Number(this.db.prepare("DELETE FROM tool_usage WHERE owner=?").run(owner).changes);
    const notes = what === "history" ? 0 : Number(this.db.prepare("DELETE FROM tool_notes WHERE owner=?").run(owner).changes);
    return { history, notes };
  }
  /** The nightly look at how the catalog is doing, in words the owner can read. */
  health(owner: string, now = new Date()): CatalogHealth {
    const rows = this.rows(owner, 1000);
    const calls = new Map<string, number>();
    for (const row of rows) for (const tool of row.called) calls.set(tool, (calls.get(tool) ?? 0) + 1);
    const last = this.lastUsed(owner);
    const searched = rows.filter((row) => row.searched.length);
    const hits = searched.filter((row) => row.searched.some((tool) => row.called.includes(tool))).length;
    const searchHitRate = searched.length ? hits / searched.length : 0;
    const tools = [...calls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
      .map(([name, count]) => ({ name, calls: count, lastUsed: last.get(name) ?? "" }));
    const averageRoundTokens = this.averageRoundTokens(owner);
    return { summary: healthLine(rows.length, tools.length, averageRoundTokens, searched.length, searchHitRate),
      tools, runs: rows.length, searches: searched.length, searchHitRate, averageRoundTokens, at: now.toISOString() };
  }
  /** What the tool list has actually weighed lately, from what each round recorded. */
  private averageRoundTokens(owner: string): number {
    const rows = this.db.prepare(`SELECT e.data AS data FROM events e JOIN tasks t ON t.id=e.run_id
      WHERE t.owner=? AND e.kind='catalog.size' ORDER BY e.id DESC LIMIT 200`).all(owner);
    const sizes = rows.map((row) => {
      try { return Number((JSON.parse(String(row.data)) as { estimatedTokens?: number }).estimatedTokens ?? 0); } catch { return 0; }
    }).filter((value) => value > 0);
    return sizes.length ? Math.round(sizes.reduce((sum, value) => sum + value, 0) / sizes.length) : 0;
  }
}

/** Where the nightly look at the catalog is kept, so the screens and the diagnostics agree. */
export const catalogHealthId = "tool_catalog_health";
/** Once a night is often enough; this is how long must pass before it is worked out again. */
const betweenHealthChecks = 20 * 3600 * 1000;

/**
 * The nightly pass, hung off the clock the schedules already use. It costs nothing on the ticks
 * in between: the saved answer says when it last ran, and it is only redone a day later.
 */
export function catalogHealthTick(
  store: { toolUsage: ToolUsage; get: (table: "settings", owner: string, id: string) => { data: Record<string, unknown> } | undefined;
    save: (table: "settings", owner: string, id: string, data: Record<string, unknown>) => unknown },
  owner: string,
  now = new Date(),
): CatalogHealth | null {
  const saved = store.get("settings", owner, catalogHealthId);
  const at = String(saved?.data?.at ?? "");
  if (at && now.getTime() - Date.parse(at) < betweenHealthChecks) return null;
  const health = store.toolUsage.health(owner, now);
  store.save("settings", owner, catalogHealthId, health as unknown as Record<string, unknown>);
  return health;
}

function healthLine(runs: number, tools: number, tokens: number, searches: number, rate: number): string {
  if (!runs) return "Nothing to report yet: no task on this computer has used a tool.";
  const weight = tokens ? ` The tool list weighed about ${tokens.toLocaleString()} tokens in each message` : " The tool list has not been measured yet";
  const finding = searches ? `, and ${Math.round(rate * 100)} out of every 100 searches found something that was then used.`
    : ", and nothing had to be searched for.";
  return `Across your last ${runs} tasks the assistant used ${tools} different tools.${weight}${finding}`;
}
