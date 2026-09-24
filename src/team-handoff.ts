import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { TeamTasks, type TeamTaskClaim, type TeamTaskScope } from "./team-tasks.js";
import { dispatchHeld, holdDispatch, releaseDispatch } from "./team-reconcile.js";

/**
 * Team handoffs (Q62): passing a claimed team task to someone else, only once they say yes.
 *
 * The task's current claimant offers it to one named recipient: a member of the task's team
 * ("member:<specialist id>") or a household profile ("profile:<profile id>"). Until the recipient
 * accepts, nothing moves: the claimant stays responsible, its fenced writes still land, and the
 * recipient's are refused. Accepting is one conditional write that hands the task over and moves
 * its generation on, so exactly one accept can ever win and every write under the old claim is
 * refused from then on. Rejecting leaves the task where it was and keeps the reason. An offer that
 * is not answered in time expires; that is checked whenever an offer is read or answered, with no
 * timer. Everything lives in the store, so an open offer is still there after a restart.
 * While the task's turn is running (Teams.run holds it), it can be neither offered nor accepted,
 * and at accept the recipient must still be on the team or still exist, or the offer lapses.
 *
 * Who is answering is always decided by the caller from the signed-in context, never taken from a
 * request body. Conversation sharing (src/interop/handoff.ts) is a different thing and is untouched.
 */
export type TeamHandoffState = "offered" | "accepted" | "rejected" | "expired";
/** Someone who can answer an offer: the owner the task belongs to and who they are within it. */
export interface TeamHandoffActor { owner: string; id: string }
export interface TeamHandoff {
  offerId: string; taskId: string; teamId: string; offeredTo: string; fromGeneration: number; reason: string;
  state: TeamHandoffState; offeredAt: string; expiresAt: string; decidedAt: string | null; decisionReason: string | null;
}
export class TeamHandoffRefusedError extends Error {}

const defaultOfferMs = 24 * 60 * 60 * 1000;
const longestOfferMs = 7 * 24 * 60 * 60 * 1000;
const longestReason = 500;
type Row = Record<string, unknown>;
type Outcome<T> = { value: T } | { refusal: string };
const turnRunning = "The task's current turn is still running; wait until the current turn finishes. The offer stays open.";

/**
 * A team task's turn as running in this process. Teams.run holds the same list through `holdDispatch`
 * (src/team-reconcile.ts), so there is one record of running turns; the store is only ever open in one
 * process, so it is every running turn there is. Handing a task over mid-turn would strand it: the
 * turn's own completion would be refused and its result lost. Call the returned function when it ends.
 */
export function beginTeamTurn(store: Store, taskId: string): () => void {
  holdDispatch(store, taskId);
  return () => releaseDispatch(store, taskId);
}
/** Whether a team task's turn is running right now. */
export function teamTurnInFlight(store: Store, taskId: string): boolean {
  return dispatchHeld(store, taskId);
}

export class TeamHandoffs {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {
    new TeamTasks(store); // the offers point at team tasks, so make sure that table is there first
    this.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS team_task_handoffs(
      offer_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL, team_id TEXT NOT NULL,
      offered_by TEXT NOT NULL, offered_to TEXT NOT NULL, from_generation INTEGER NOT NULL, reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('offered','accepted','rejected','expired')),
      offered_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decision_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS team_task_handoffs_one_open ON team_task_handoffs(task_id) WHERE state='offered';
      CREATE INDEX IF NOT EXISTS team_task_handoffs_recipient ON team_task_handoffs(owner, offered_to, state);`);
  }

  /** The claimant offers its task to one recipient. Only the exact current claim can do this. */
  offer(claim: TeamTaskClaim, to: string, reason: string, forMs = defaultOfferMs): TeamHandoff {
    const why = reason.trim();
    if (!why || why.length > longestReason) throw new TeamHandoffRefusedError(`Say why the task is being handed over, in 1 to ${longestReason} characters.`);
    if (!(forMs >= 1000 && forMs <= longestOfferMs)) throw new TeamHandoffRefusedError("An offer must stay open for between one second and seven days.");
    const now = this.now();
    const outcome = this.transaction((): Outcome<string> => {
      this.expire("task_id=?", [claim.taskId], now);
      const task = this.heldTask(claim);
      if (!task) return { refusal: "Only the task's current claimant can offer it, and this claim no longer holds it." };
      if (teamTurnInFlight(this.store, claim.taskId)) return { refusal: turnRunning.replace(" The offer stays open.", "") };
      const refusal = to === String(task.claimant) ? "This recipient already holds the task." : this.recipientGone(claim.scope.owner, String(task.team_id), to);
      if (refusal) return { refusal };
      if (this.openOffer(claim.taskId)) return { refusal: "This task already has an open offer; wait for an answer or for it to expire." };
      const offerId = randomUUID();
      this.store.sqlite.prepare(`INSERT INTO team_task_handoffs(offer_id,task_id,owner,source,team_id,offered_by,offered_to,from_generation,reason,state,offered_at,expires_at)
        SELECT ?,task_id,owner,source,team_id,claimant,?,generation,?,'offered',?,? FROM team_tasks
        WHERE owner=? AND source=? AND task_id=? AND claimant=? AND generation=? AND state='claimed'`)
        .run(offerId, to, why, iso(now), iso(now + forMs), claim.scope.owner, claim.scope.source, claim.taskId, claim.claimant, claim.generation);
      return { value: offerId };
    });
    return this.get(claim.scope.owner, settle(outcome))!;
  }

  /**
   * The recipient takes the task. Two writes in one transaction: the offer goes from offered to
   * accepted only for its own recipient before it expires, and the task moves only if the offerer
   * still holds it at the generation it offered. The new holder gets the next generation.
   */
  accept(who: TeamHandoffActor, offerId: string): TeamTaskClaim {
    const now = this.now();
    return settle(this.transaction((): Outcome<TeamTaskClaim> => {
      this.expire("offer_id=?", [offerId], now);
      if (this.turnRunningFor(who, offerId)) return { refusal: turnRunning };
      const offer = this.store.sqlite.prepare(`UPDATE team_task_handoffs SET state='accepted', decided_at=?
        WHERE offer_id=? AND owner=? AND offered_to=? AND state='offered' AND expires_at>? RETURNING *`)
        .get(iso(now), offerId, who.owner, who.id, iso(now));
      if (!offer) return { refusal: this.whyNot(who, offerId) };
      const gone = this.recipientGone(who.owner, String(offer.team_id), who.id);
      if (gone) return this.lapse(offerId, now, `The recipient could no longer take the task: ${gone}`);
      // The new holder is a person, not this process, so the task no longer belongs to this opening of the store (no boot).
      const moved = this.store.sqlite.prepare(`UPDATE team_tasks SET claimant=?, boot_id=NULL, generation=generation+1, updated_at=?
        WHERE owner=? AND source=? AND task_id=? AND claimant=? AND generation=? AND state='claimed' RETURNING generation`)
        .get(who.id, iso(now), String(offer.owner), String(offer.source), String(offer.task_id), String(offer.offered_by), Number(offer.from_generation));
      if (!moved) return this.lapse(offerId, now, "The one who offered this task no longer holds it, so the offer lapsed and nothing moved.");
      const scope: TeamTaskScope = { owner: String(offer.owner), source: String(offer.source) };
      return { value: { scope, taskId: String(offer.task_id), claimant: who.id, generation: Number(moved.generation) } };
    }));
  }

  /** The recipient says no. The task stays exactly where it was; the reason is kept on the offer. */
  reject(who: TeamHandoffActor, offerId: string, reason: string): TeamHandoff {
    const why = reason.trim().slice(0, longestReason);
    const now = this.now();
    settle(this.transaction((): Outcome<true> => {
      this.expire("offer_id=?", [offerId], now);
      const row = this.store.sqlite.prepare(`UPDATE team_task_handoffs SET state='rejected', decided_at=?, decision_reason=?
        WHERE offer_id=? AND owner=? AND offered_to=? AND state='offered' AND expires_at>? RETURNING offer_id`)
        .get(iso(now), why || "No reason given", offerId, who.owner, who.id, iso(now));
      return row ? { value: true } : { refusal: this.whyNot(who, offerId) };
    }));
    return this.get(who.owner, offerId)!;
  }

  /** One offer as its owner sees it, with an overdue offer shown (and recorded) as expired. */
  get(owner: string, offerId: string): TeamHandoff | undefined {
    this.expire("offer_id=?", [offerId], this.now());
    const row = this.store.sqlite.prepare("SELECT * FROM team_task_handoffs WHERE offer_id=? AND owner=?").get(offerId, owner);
    return row ? toHandoff(row) : undefined;
  }

  /** The open offers waiting for this recipient, oldest first. */
  addressedTo(who: TeamHandoffActor): TeamHandoff[] {
    this.expire("owner=? AND offered_to=?", [who.owner, who.id], this.now());
    return this.store.sqlite.prepare("SELECT * FROM team_task_handoffs WHERE owner=? AND offered_to=? AND state='offered' ORDER BY offered_at")
      .all(who.owner, who.id).map(toHandoff);
  }

  /** Why a task is waiting, in words, or null when no offer is open for it. */
  waiting(scope: TeamTaskScope, taskId: string): string | null {
    const offer = this.pendingFor(scope, taskId);
    return offer ? `waiting for ${offer.offeredTo} to accept: ${offer.reason}` : null;
  }

  /** Q64: the offer open for a task right now (to whom, since when, why), or null; an overdue one is recorded as expired first. */
  pendingFor(scope: TeamTaskScope, taskId: string): TeamHandoff | null {
    this.expire("task_id=?", [taskId], this.now());
    const row = this.store.sqlite.prepare("SELECT * FROM team_task_handoffs WHERE owner=? AND source=? AND task_id=? AND state='offered'")
      .get(scope.owner, scope.source, taskId);
    return row ? toHandoff(row) : null;
  }

  /** The task row only if this exact claim still holds it. */
  private heldTask(claim: TeamTaskClaim): Row | undefined {
    return this.store.sqlite.prepare("SELECT team_id, claimant FROM team_tasks WHERE owner=? AND source=? AND task_id=? AND claimant=? AND generation=? AND state='claimed'")
      .get(claim.scope.owner, claim.scope.source, claim.taskId, claim.claimant, claim.generation);
  }

  /** Why a recipient cannot hold the task: its team must still exist, and it must be on that team or an existing household profile. */
  private recipientGone(owner: string, teamId: string, to: string): string | null {
    if (!this.store.get("governance", owner, `team:${teamId}`)) return "The task's team was removed.";
    const [kind, id] = [to.slice(0, to.indexOf(":")), to.slice(to.indexOf(":") + 1)];
    if (kind === "member") {
      const team = this.store.get("governance", owner, `team:${teamId}`)?.data as { members?: { specialistId: string }[] } | undefined;
      return team?.members?.some((m) => m.specialistId === id) ? null : "That specialist is not a member of this task's team.";
    }
    if (kind === "profile") return this.store.profiles.list().some((p) => p.id === id) ? null : "That household profile does not exist.";
    return "A task can be offered to a team member (member:<id>) or a household profile (profile:<id>).";
  }

  private openOffer(taskId: string): boolean {
    return !!this.store.sqlite.prepare("SELECT 1 FROM team_task_handoffs WHERE task_id=? AND state='offered'").get(taskId);
  }

  /** Why an answer was refused, for a caller whose conditional write matched nothing. */
  private whyNot(who: TeamHandoffActor, offerId: string): string {
    const row = this.store.sqlite.prepare("SELECT offered_to, state FROM team_task_handoffs WHERE offer_id=? AND owner=?").get(offerId, who.owner);
    if (!row) return "There is no such handoff offer.";
    if (row.offered_to !== who.id) return "This offer is addressed to someone else; only its recipient can accept or reject it.";
    if (row.state === "accepted") return "This offer was already accepted, so nothing changed.";
    if (row.state === "rejected") return "This offer was rejected, so it can no longer be answered.";
    return "This offer expired before it was accepted, so the task stays with the one who offered it.";
  }

  /** An open offer to this recipient whose task has a turn running right now. */
  private turnRunningFor(who: TeamHandoffActor, offerId: string): boolean {
    const row = this.store.sqlite.prepare("SELECT task_id FROM team_task_handoffs WHERE offer_id=? AND owner=? AND offered_to=? AND state='offered'")
      .get(offerId, who.owner, who.id);
    return !!row && teamTurnInFlight(this.store, String(row.task_id));
  }

  /**
   * The recipient said yes but the offer can no longer be carried out (the offerer finished or lost
   * the task, or the recipient left the team or was removed): the offer lapses and nothing moves.
   */
  private lapse(offerId: string, now: number, why: string): { refusal: string } {
    this.store.sqlite.prepare("UPDATE team_task_handoffs SET state='expired', decided_at=?, decision_reason=? WHERE offer_id=?")
      .run(iso(now), why, offerId);
    return { refusal: why };
  }

  /** Marks overdue open offers as expired. This is the only way an offer times out; there is no timer. */
  private expire(where: string, values: string[], now: number): void {
    this.store.sqlite.prepare(`UPDATE team_task_handoffs SET state='expired', decided_at=?, decision_reason='Nobody accepted it in time'
      WHERE state='offered' AND expires_at<=? AND ${where}`).run(iso(now), iso(now), ...values);
  }

  /** Runs `work` in one write transaction; a refusal still commits (an expiry it recorded is kept). */
  private transaction<T>(work: () => Outcome<T>): Outcome<T> {
    const db = this.store.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      const outcome = work();
      db.exec("COMMIT");
      return outcome;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function settle<T>(outcome: Outcome<T>): T {
  if ("refusal" in outcome) throw new TeamHandoffRefusedError(outcome.refusal);
  return outcome.value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toHandoff(row: Row): TeamHandoff {
  return {
    offerId: String(row.offer_id), taskId: String(row.task_id), teamId: String(row.team_id), offeredTo: String(row.offered_to),
    fromGeneration: Number(row.from_generation), reason: String(row.reason), state: row.state as TeamHandoffState,
    offeredAt: String(row.offered_at), expiresAt: String(row.expires_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at), decisionReason: row.decision_reason == null ? null : String(row.decision_reason),
  };
}
