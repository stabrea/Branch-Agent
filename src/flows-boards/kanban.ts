import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorText } from "../contracts.js";
import type { ProjectBoard, ProjectBoards } from "../asks/project-board.js";
import { askMode } from "../asks/settings.js";
import type { Runtime } from "../runtime.js";
import { Teams } from "../teams.js";
import { TrunkRecords } from "../trunks/record.js";
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

/** Who a card can be with: the owner, the assistant, a checked Trunk, or a checked team; never free text (R17-071 gap). */
export const assigneeTypes = ["owner", "assistant", "trunk", "team"] as const;
export type AssigneeType = (typeof assigneeTypes)[number];
/** A picked assignee: its kind, the record id it was checked against (none for owner/assistant), and the name to show. */
export interface Assignee { type: AssigneeType; id: string | null; name: string }
/** One line for a picker: `value` is what `assignee`/`to` takes, `label` is what the owner reads. */
export interface AssigneeOption { value: string; label: string }

export interface CardNote { at: string; by: Actor; what: string }
export interface Card {
  id: string; project: string; title: string; notes: string; lane: Lane; assignee: string;
  assigneeType: AssigneeType; assigneeId: string | null;
  failures: number; stuck: boolean; runId: string | null; history: CardNote[]; createdAt: string; updatedAt: string;
}

const maxCards = 200, maxHistory = 30;
export const BoardSettingsSchema = z.object({
  /** Failed tries in a row after which a card is stopped. */
  stopAfter: z.number().int().min(1).max(10).default(3),
}).strict();
const settingsKey = "flowboards-kanban-settings";

/** "owner", "assistant", `trunk:<id>` or `team:<id>` — one of the checked options `roster()` lists, never free text. */
const AssigneeRefSchema = z.string().trim().min(1).max(80)
  .describe("\"owner\", \"assistant\", or a `trunk:<id>`/`team:<id>` value from the board's roster. Never a free-text name.");
export const CardInputSchema = z.object({
  project: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).default(""),
  assignee: AssigneeRefSchema.default("assistant"),
}).strict();
export const MoveSchema = z.object({ lane: z.enum(lanes), note: z.string().max(500).optional() }).strict();
export const HandoffSchema = z.object({ to: AssigneeRefSchema, note: z.string().trim().min(1).max(500) }).strict();

export interface SharedBoard {
  project: { id: string; name: string; active: boolean };
  /** Bucket 23's view of the same project, while that part is on. */
  items: Omit<ProjectBoard, "project"> | null;
  lanes: Record<Lane, Card[]>;
  stopAfter: number;
  /** The checked Trunks and teams a card may be handed to, for the picker; owner and assistant are always first. */
  roster: AssigneeOption[];
}

export class KanbanBoard {
  private readonly working = new Map<string, Promise<void>>();
  private readonly trunks: TrunkRecords;
  private readonly teams: Teams;
  constructor(private readonly runtime: Runtime, private readonly boards: ProjectBoards) {
    runtime.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS board_cards(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      project TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', lane TEXT NOT NULL,
      assignee TEXT NOT NULL, assignee_type TEXT NOT NULL DEFAULT 'assistant', assignee_id TEXT,
      failures INTEGER NOT NULL DEFAULT 0, stuck INTEGER NOT NULL DEFAULT 0,
      run_id TEXT, history TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // Older boards were created before R17-071's checked assignee; add the columns a fresh table already has.
    const columns = new Set(runtime.store.sqlite.prepare("PRAGMA table_info(board_cards)").all().map((c) => String((c as { name: string }).name)));
    if (!columns.has("assignee_type")) runtime.store.sqlite.exec("ALTER TABLE board_cards ADD COLUMN assignee_type TEXT NOT NULL DEFAULT 'assistant'");
    if (!columns.has("assignee_id")) runtime.store.sqlite.exec("ALTER TABLE board_cards ADD COLUMN assignee_id TEXT");
    this.trunks = new TrunkRecords(runtime.store, runtime.owner);
    this.teams = new Teams(runtime.store, runtime.owner);
  }
  private get store() { return this.runtime.store; }
  private get owner() { return this.runtime.owner; }

  /** The owner and assistant, plus every checked Trunk and team, as picker options. */
  roster(): AssigneeOption[] {
    return [
      { value: "owner", label: "Owner" },
      { value: "assistant", label: "Assistant" },
      ...this.trunks.list().map((t) => ({ value: `trunk:${t.id}`, label: `Trunk: ${t.name}` })),
      ...this.teams.list().map((t) => ({ value: `team:${t.id}`, label: `Team: ${t.name}` })),
    ];
  }

  /** Checks a picker value (`owner`, `assistant`, `trunk:<id>` or `team:<id>`) against the real Trunks and teams; never free text. */
  private resolveAssignee(ref: string): Assignee {
    const value = ref.trim();
    if (value === "owner") return { type: "owner", id: null, name: "Owner" };
    if (value === "assistant") return { type: "assistant", id: null, name: "Assistant" };
    const at = value.indexOf(":"), kind = at < 0 ? value : value.slice(0, at), id = at < 0 ? "" : value.slice(at + 1);
    if (kind === "trunk" && id) {
      const trunk = this.trunks.find(id);
      if (!trunk) throw new Error("That Trunk no longer exists. Pick one from the list.");
      return { type: "trunk", id: trunk.id, name: trunk.name };
    }
    if (kind === "team" && id) {
      let team; try { team = this.teams.get(id); } catch { team = undefined; }
      if (!team) throw new Error("That team no longer exists. Pick one from the list.");
      return { type: "team", id: team.id, name: team.name };
    }
    throw new Error(`"${ref}" is not the owner, the assistant, a checked Trunk or a checked team. Pick one from the list.`);
  }

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
    return { project, items, lanes: byLane, stopAfter: this.settings().stopAfter, roster: this.roster() };
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
    const assignee = this.resolveAssignee(value.assignee);
    const project = this.project(value.project);
    const count = Number(this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM board_cards WHERE owner=? AND project=?").get(this.owner, project.id)?.n ?? 0);
    if (count >= maxCards) throw new Error(`A board holds at most ${maxCards} cards; remove some that are done first.`);
    const id = randomUUID(), now = new Date().toISOString();
    const history: CardNote[] = [{ at: now, by, what: `Added to "to do"` }];
    this.store.sqlite.prepare(`INSERT INTO board_cards(id,owner,project,title,notes,lane,assignee,assignee_type,assignee_id,failures,stuck,run_id,history,created_at,updated_at)
      VALUES(?,?,?,?,?,'todo',?,?,?,0,0,NULL,?,?,?)`).run(id, this.owner, project.id, oneLine(value.title, 200), value.notes,
      assignee.name, assignee.type, assignee.id, JSON.stringify(history), now, now);
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
    const assignee = this.resolveAssignee(to);
    const lane: Lane = card.lane === "doing" ? "todo" : card.lane;
    return this.write(card, { assignee: assignee.name, assigneeType: assignee.type, assigneeId: assignee.id, lane }, by,
      `Handed from ${card.assignee} to ${assignee.name}: ${oneLine(note, 500)}`);
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

  private write(card: Card, change: Partial<Pick<Card, "lane" | "assignee" | "assigneeType" | "assigneeId" | "failures" | "stuck">>, by: Actor, what: string): Card {
    const next = { ...card, ...change };
    const history = [...card.history, { at: new Date().toISOString(), by, what: oneLine(what, 600) }].slice(-maxHistory);
    this.store.sqlite.prepare(`UPDATE board_cards SET lane=?, assignee=?, assignee_type=?, assignee_id=?, failures=?, stuck=?, history=?, updated_at=? WHERE owner=? AND id=?`)
      .run(next.lane, next.assignee, next.assigneeType, next.assigneeId, next.failures, next.stuck ? 1 : 0, JSON.stringify(history), new Date().toISOString(), this.owner, card.id);
    return this.card(card.id);
  }
}

function toCard(row: Record<string, unknown>): Card {
  return {
    id: String(row.id), project: String(row.project), title: String(row.title), notes: String(row.notes),
    lane: String(row.lane) as Lane, assignee: String(row.assignee),
    assigneeType: (row.assignee_type ? String(row.assignee_type) : "assistant") as AssigneeType,
    assigneeId: row.assignee_id === null || row.assignee_id === undefined ? null : String(row.assignee_id),
    failures: Number(row.failures), stuck: Number(row.stuck) === 1,
    runId: row.run_id === null ? null : String(row.run_id), history: JSON.parse(String(row.history)) as CardNote[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
