import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { codeOverlap, Expansion, type KenyonCode } from "../fly-core/encode.js";
import { redactLeaks } from "../leak-guard.js";
import type { Store } from "../store.js";

/**
 * R17-056: learning from evaluation tasks that failed — tasks with a known right answer — and
 * keeping only the lessons that pay off later. After a suite run, each failed task leaves a
 * "trial" lesson in words (what went wrong, from the grader). Later tasks that look like it are
 * shown the lesson (the part "on": at the start of the task; "when needed": through
 * `lessons.list`), and each evaluation result for a task that was shown a lesson is credited to it.
 * A lesson that goes on to pass at least `keepAfter` times, and mostly, is offered to the owner as a
 * fact to remember; one that keeps failing is dropped. Nothing is remembered without the owner's yes.
 *
 * "Looks like it" is the learning core's own situation code (src/fly-core/encode.ts): the same
 * sparse Kenyon-cell code the core learns on, compared by overlap, so no model is asked. A lesson
 * keeps the code, and its own text quotes at most 120 characters of the request, with key-like
 * values hidden.
 *
 * The idea is AutoGen's task-centric memory (MIT): insights from failures on tasks with known
 * answers, kept only when they help. The code is Branch's own; see THIRD_PARTY_NOTICES.md.
 */
export const keepAfter = 2;
export const dropAfter = 2;
export const matchOverlap = 0.3;
export const lessonsShown = 3;
export const lessonEvent = "learning-more.lessons";
export interface Lesson {
  id: string; taskId: string; text: string; status: "trial" | "kept" | "dropped";
  shown: number; passes: number; failures: number; proposalId: string | null; createdAt: string; updatedAt: string;
}
interface Outcome { id: string; runId: string | null; passed: boolean; skipped: boolean; problem?: string | null; reason?: string | null }
export const ListLessonsSchema = z.object({ query: z.string().trim().max(2000).default("") }).strict();

const expansions = new Map<string, Expansion>();
function expansionFor(owner: string): Expansion {
  const seed = `lessons:${owner}`;
  let found = expansions.get(seed);
  if (!found) { found = new Expansion(seed); expansions.set(seed, found); }
  return found;
}
export const situationOf = (owner: string, prompt: string): KenyonCode => expansionFor(owner).code({ prompt, source: "evaluation" });

export class EvaluationLessons {
  constructor(private readonly store: Store, private readonly db: DatabaseSync = store.sqlite) {
    db.exec(`CREATE TABLE IF NOT EXISTS lm_lessons(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, code TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, shown INTEGER NOT NULL, passes INTEGER NOT NULL, failures INTEGER NOT NULL,
      proposal_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lm_lessons_read(owner TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(owner, outcome))`);
  }

  list(owner: string): Lesson[] {
    return this.db.prepare("SELECT * FROM lm_lessons WHERE owner=? ORDER BY updated_at DESC LIMIT 200").all(owner).map(toLesson);
  }

  /**
   * Lessons for a task that looks like this one, best match first: those on trial, and kept ones,
   * which go on being shown (and are no longer counted) while the owner decides whether to remember them.
   */
  matching(owner: string, prompt: string): Lesson[] {
    const code = situationOf(owner, prompt);
    return this.db.prepare("SELECT * FROM lm_lessons WHERE owner=? AND status IN ('trial','kept')").all(owner)
      .map((row) => ({ lesson: toLesson(row), overlap: codeOverlap(code, JSON.parse(String(row.code)) as number[]) }))
      .filter((entry) => entry.overlap >= matchOverlap)
      .sort((a, b) => b.overlap - a.overlap).slice(0, lessonsShown).map((entry) => entry.lesson);
  }

  /** Marks the lessons a task was shown, so its result is credited to them. */
  shownTo(runId: string, lessons: readonly Lesson[]): void {
    if (!lessons.length) return;
    this.store.event(runId, lessonEvent, { ids: lessons.map((lesson) => lesson.id) });
  }

  openingText(lessons: readonly Lesson[]): string {
    return lessons.map((lesson) => `- ${lesson.text}`).join("\n");
  }

  /** Reads every suite run not read yet: credits lessons, keeps or drops them, and writes new ones. */
  ingest(owner: string): { read: number; created: number; kept: number; dropped: number } {
    const report = { read: 0, created: 0, kept: 0, dropped: 0 };
    const runs = this.store.list("governance", owner).filter((record) => record.id.startsWith("evaluation-run:"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const record of runs)
      for (const outcome of ((record.data.tasks ?? []) as Outcome[])) {
        const key = `${record.id}:${outcome.id}`;
        if (outcome.skipped || !outcome.runId || this.wasRead(owner, key)) continue;
        this.db.prepare("INSERT INTO lm_lessons_read VALUES(?,?)").run(owner, key);
        report.read += 1;
        const shown = this.shownIn(outcome.runId);
        for (const id of shown) {
          const verdict = this.credit(owner, id, outcome.passed);
          if (verdict === "kept") report.kept += 1;
          if (verdict === "dropped") report.dropped += 1;
        }
        if (!outcome.passed && !shown.length && this.write(owner, outcome)) report.created += 1;
      }
    return report;
  }

  forget(owner: string): number {
    this.db.prepare("DELETE FROM lm_lessons_read WHERE owner=?").run(owner);
    return Number(this.db.prepare("DELETE FROM lm_lessons WHERE owner=?").run(owner).changes);
  }

  private wasRead(owner: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM lm_lessons_read WHERE owner=? AND outcome=?").get(owner, key);
  }
  private shownIn(runId: string): string[] {
    return this.store.events(runId).filter((event) => event.kind === lessonEvent)
      .flatMap((event) => ((event.data as { ids?: string[] }).ids ?? []));
  }
  private credit(owner: string, id: string, passed: boolean): Lesson["status"] | null {
    const row = this.db.prepare("SELECT * FROM lm_lessons WHERE owner=? AND id=?").get(owner, id);
    if (!row) return null;
    const lesson = toLesson(row);
    if (lesson.status !== "trial") return null;
    const passes = lesson.passes + (passed ? 1 : 0), failures = lesson.failures + (passed ? 0 : 1);
    const rate = passes / (passes + failures);
    const status: Lesson["status"] = passes >= keepAfter && rate >= 2 / 3 ? "kept" : failures >= dropAfter && rate < 0.5 ? "dropped" : "trial";
    const proposalId = status === "kept" ? this.store.review.propose(owner, { kind: "put", text: lesson.text,
      source: `A lesson from a failed evaluation task that then helped ${passes} of ${passes + failures} times` }).id : null;
    this.db.prepare("UPDATE lm_lessons SET shown=shown+1, passes=?, failures=?, status=?, proposal_id=COALESCE(?, proposal_id), updated_at=? WHERE id=?")
      .run(passes, failures, status, proposalId, new Date().toISOString(), id);
    return status;
  }
  private write(owner: string, outcome: Outcome): boolean {
    if (this.db.prepare("SELECT 1 AS found FROM lm_lessons WHERE owner=? AND task_id=? AND status='trial'").get(owner, outcome.id)) return false;
    const prompt = this.store.run(outcome.runId!)?.prompt ?? "";
    const why = String(outcome.problem || outcome.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!prompt || !why) return false;
    const { text } = redactLeaks(`For a request like "${prompt.replace(/\s+/g, " ").slice(0, 120)}", an earlier answer failed its check: ${why}. Make sure the answer avoids that.`);
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO lm_lessons VALUES(?,?,?,?,?,'trial',0,0,0,NULL,?,?)")
      .run(randomUUID(), owner, outcome.id, JSON.stringify(situationOf(owner, prompt)), text, now, now);
    return true;
  }
}

function toLesson(row: Record<string, unknown>): Lesson {
  return { id: String(row.id), taskId: String(row.task_id), text: String(row.text), status: String(row.status) as Lesson["status"],
    shown: Number(row.shown), passes: Number(row.passes), failures: Number(row.failures),
    proposalId: row.proposal_id === null ? null : String(row.proposal_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
