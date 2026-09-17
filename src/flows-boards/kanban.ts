import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorText } from "../contracts.js";
import type { ProjectBoard, ProjectBoards } from "../asks/project-board.js";
import { askMode } from "../asks/settings.js";
import type { Runtime } from "../runtime.js";
import { oneLine, partRecord, requirePart } from "./settings.js";

/**
 * R17-071: the shared board. Bucket 23's project board (src/asks/project-board.ts) shows what sits
 * under a project — flows, schedules, triggers, and the tasks done there. This adds the cards the
 * owner and the assistant work from together, in lanes, on the same project; the board view is that
 * project board with the lanes laid over it, not a second board.
 *
 * The idea is Hermes' kanban (`hermes_cli/kanban*.py`, MIT), written for Branch:
 * - lanes: to do, doing, to check, done, stuck;
 * - handing a card to somebody else, with a note that stays on the card;
 * - a circuit breaker: a card whose work fails so many times in a row goes to "stuck" and is not
 *   worked on again until the owner looks at it and resets it.
 *
 * The assistant may add cards and move them between to do, doing and to check, and hand them on; only
 * the owner marks a card done, resets a stuck one, removes one, or presses Work on it — which starts an
 * ordinary task, held to every rule a task is.
 */
export const lanes = ["todo", "doing", "review", "done", "blocked"] as const;
export type Lane = (typeof lanes)[number];
const assistantLanes: readonly Lane[] = ["todo", "doing", "review"];
export type Actor = "owner" | "assistant";

export interface CardNote { at: string; by: Actor; what: string }
export interface Card {
  id: string; project: string; title: string; notes: string; lane: Lane; assignee: string;
  failures: number; stuck: boolean; runId: string | null; history: CardNote[]; createdAt: string; updatedAt: string;
}

const maxCards = 200, maxHistory = 30;
export const BoardSettingsSchema = z.object({
  /** Failed tries in a row after which a card is stopped. */
  stopAfter: z.number().int().min(1).max(10).default(3),
}).strict();
const settingsKey = "flowboards-kanban-settings";

export const CardInputSchema = z.object({
  project: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).default(""),
  /** "owner", "assistant", or a specialist's name. */
  assignee: z.string().trim().min(1).max(64).default("assistant"),
}).strict();
export const MoveSchema = z.object({ lane: z.enum(lanes), note: z.string().max(500).optional() }).strict();
export const HandoffSchema = z.object({ to: z.string().trim().min(1).max(64), note: z.string().trim().min(1).max(500) }).strict();

export interface SharedBoard {
  project: { id: string; name: string; active: boolean };
  /** Bucket 23's view of the same project, while that part is on. */
  items: Omit<ProjectBoard, "project"> | null;
  lanes: Record<Lane, Card[]>;
  stopAfter: number;
}

export class KanbanBoard {
  private readonly working = new Map<string, Promise<void>>();
  constructor(private readonly runtime: Runtime, private readonly boards: ProjectBoards) {
    runtime.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS board_cards(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      project TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', lane TEXT NOT NULL,
      assignee TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, stuck INTEGER NOT NULL DEFAULT 0,
      run_id TEXT, history TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  private get store() { return this.runtime.store; }
  private get owner() { return this.runtime.owner; }

  settings(): z.infer<typeof BoardSettingsSchema> {
    return partRecord(this.store, this.owner, settingsKey, BoardSettingsSchema);
  }
  saveSettings(input: unknown): z.infer<typeof BoardSettingsSchema> {
    requirePart(this.store, this.owner, "kanban");
    const value = BoardSettingsSchema.parse(input);
    this.store.save("settings", this.owner, settingsKey, value);
    return value;
  }

  private project(id?: string): { id: string; name: string; active: boolean } {
    const active = this.store.projects.active(this.owner);
    const found = id ? this.store.projects.list(this.owner).find((p) => p.id === id) : active;
    if (!found) throw new Error("Project not found");
    return { id: found.id, name: found.name, active: found.id === active.id };
  }

  view(projectId?: string): SharedBoard {
    requirePart(this.store, this.owner, "kanban");
    const project = this.project(projectId);
    let items: SharedBoard["items"] = null;
    if (askMode(this.store, this.owner, "project-board") !== "off") {
      const { project: _same, ...rest } = this.boards.board(project.id);
      items = rest;
    }
    const cards = this.cards(project.id);
    const byLane = Object.fromEntries(lanes.map((lane) => [lane, cards.filter((card) => card.lane === lane)])) as Record<Lane, Card[]>;
    return { project, items, lanes: byLane, stopAfter: this.settings().stopAfter };
  }

  cards(projectId: string): Card[] {
    return this.store.sqlite.prepare("SELECT * FROM board_cards WHERE owner=? AND project=? ORDER BY updated_at DESC")
      .all(this.owner, projectId).map(toCard);
  }
  card(id: string): Card {
    const row = this.store.sqlite.prepare("SELECT * FROM board_cards WHERE owner=? AND id=?").get(this.owner, id);
    if (!row) throw new Error("That card is not on the board");
    return toCard(row);
  }

  add(input: unknown, by: Actor): Card {
    requirePart(this.store, this.owner, "kanban");
    const value = CardInputSchema.parse(input);
    const project = this.project(value.project);
    const count = Number(this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM board_cards WHERE owner=? AND project=?").get(this.owner, project.id)?.n ?? 0);
    if (count >= maxCards) throw new Error(`A board holds at most ${maxCards} cards; remove some that are done first.`);
    const id = randomUUID(), now = new Date().toISOString();
    const history: CardNote[] = [{ at: now, by, what: `Added to "to do"` }];
    this.store.sqlite.prepare(`INSERT INTO board_cards(id,owner,project,title,notes,lane,assignee,failures,stuck,run_id,history,created_at,updated_at)
      VALUES(?,?,?,?,?,'todo',?,0,0,NULL,?,?,?)`).run(id, this.owner, project.id, oneLine(value.title, 200), value.notes,
      oneLine(value.assignee, 64), JSON.stringify(history), now, now);
    return this.card(id);
  }

  move(id: string, input: unknown, by: Actor): Card {
    requirePart(this.store, this.owner, "kanban");
    const { lane, note } = MoveSchema.parse(input);
    const card = this.card(id);
    if (by === "assistant" && (!assistantLanes.includes(lane) || card.stuck || !assistantLanes.includes(card.lane)))
      throw new Error("The assistant can only move a card between to do, doing and to check; done and stuck are the owner's.");
    if (card.stuck && lane !== "blocked") throw new Error("This card was stopped after failing too often. Reset it first.");
    return this.write(card, { lane }, by, `Moved from ${card.lane} to ${lane}${note ? `: ${oneLine(note, 500)}` : ""}`);
  }

  handoff(id: string, input: unknown, by: Actor): Card {
    requirePart(this.store, this.owner, "kanban");
    const { to, note } = HandoffSchema.parse(input);
    const card = this.card(id);
    if (by === "assistant" && (card.stuck || card.lane === "done")) throw new Error("A card that is done or stuck is the owner's to hand on.");
    const lane: Lane = card.lane === "doing" ? "todo" : card.lane;
    return this.write(card, { assignee: oneLine(to, 64), lane }, by, `Handed from ${card.assignee} to ${oneLine(to, 64)}: ${oneLine(note, 500)}`);
  }

  /** The owner looked at a stopped card: it goes back to "to do" with its count cleared. */
  reset(id: string): Card {
    requirePart(this.store, this.owner, "kanban");
    const card = this.card(id);
    return this.write(card, { lane: "todo", failures: 0, stuck: false }, "owner", "Reset by the owner");
  }

  remove(id: string): { removed: boolean } {
    const changes = this.store.sqlite.prepare("DELETE FROM board_cards WHERE owner=? AND id=?").run(this.owner, id).changes;
    return { removed: Number(changes ?? 0) > 0 };
  }

  /** Starts a task from the card, as the owner. It moves to "doing", and on to "to check" or back. */
  work(id: string): { card: Card } {
    requirePart(this.store, this.owner, "kanban");
    const card = this.card(id);
    if (card.stuck) throw new Error("This card was stopped after failing too often. Look at it, then reset it.");
    if (this.working.has(id)) throw new Error("This card is already being worked on.");
    if (card.lane === "done") throw new Error("This card is done.");
    const started = this.write(card, { lane: "doing" }, "owner", "Work started");
    const prompt = `Work on this card from the project board.\nTitle: ${card.title}\n${card.notes ? `Notes: ${card.notes}\n` : ""}`
      + `It is assigned to: ${card.assignee}. Say plainly what you did and what is left.`;
    const job = this.runtime.run({ prompt, source: "owner", onTextDelta: () => undefined,
      onStarted: (run) => { this.store.sqlite.prepare("UPDATE board_cards SET run_id=? WHERE id=?").run(run.id, id); } })
      .then((run) => this.finished(id, run.status === "completed", run.status), (error: unknown) => this.finished(id, false, errorText(error)))
      .finally(() => this.working.delete(id));
    this.working.set(id, job);
    return { card: started };
  }

  /** Waits for a card's task to settle. The page never needs this; a test does. */
  async settled(id: string): Promise<Card> { await this.working.get(id); return this.card(id); }

  private finished(id: string, ok: boolean, how: string): void {
    let card: Card;
    try { card = this.card(id); } catch { return; } // removed while it worked
    if (ok) { this.write(card, { lane: "review", failures: 0 }, "owner", "Work finished; waiting to be checked"); return; }
    const failures = card.failures + 1, stop = failures >= this.settings().stopAfter;
    this.write(card, { lane: stop ? "blocked" : "todo", failures, stuck: stop }, "owner",
      stop ? `Stopped after ${failures} failed tries in a row (${oneLine(how, 120)})` : `The work did not finish (${oneLine(how, 120)})`);
  }

  private write(card: Card, change: Partial<Pick<Card, "lane" | "assignee" | "failures" | "stuck">>, by: Actor, what: string): Card {
    const next = { ...card, ...change };
    const history = [...card.history, { at: new Date().toISOString(), by, what: oneLine(what, 600) }].slice(-maxHistory);
    this.store.sqlite.prepare(`UPDATE board_cards SET lane=?, assignee=?, failures=?, stuck=?, history=?, updated_at=? WHERE owner=? AND id=?`)
      .run(next.lane, next.assignee, next.failures, next.stuck ? 1 : 0, JSON.stringify(history), new Date().toISOString(), this.owner, card.id);
    return this.card(card.id);
  }
}

function toCard(row: Record<string, unknown>): Card {
  return {
    id: String(row.id), project: String(row.project), title: String(row.title), notes: String(row.notes),
    lane: String(row.lane) as Lane, assignee: String(row.assignee), failures: Number(row.failures), stuck: Number(row.stuck) === 1,
    runId: row.run_id === null ? null : String(row.run_id), history: JSON.parse(String(row.history)) as CardNote[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
