import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { detectInjection } from "./content-guard.js";
import type { FactKind } from "./memory-layers.js";
import type { Proposal } from "./memory-review.js";
import type { Store } from "./store.js";

/**
 * What the assistant notices from what actually happened, rather than from what the owner typed.
 *
 * Three habits, all worked out on this computer with no model involved: the files a person keeps
 * coming back to, the names that keep turning up in what they ask for, and the corrections they
 * make in the middle of a task. Each one becomes a *suggestion* carrying the thing it was learned
 * from, so the owner can see why it is being offered before deciding.
 *
 * Nothing here ever writes, changes or removes a remembered fact. It proposes; the owner disposes.
 * Turning a suggestion down is itself something learned: the same noticing is never offered again,
 * because the rejected suggestion keeps the fingerprint of what was noticed.
 *
 * This follows the shape `src/tool-usage.ts` already uses for deferred tool loading: learn from the
 * record of finished work that is already kept, rather than starting a second record of its own.
 */
export type LearningSignal = "file-revisited" | "name-recurs" | "correction";
export interface LearnedCandidate {
  signal: LearningSignal;
  /** The fact as it would be saved, in the owner's own everyday words. */
  text: string;
  source: string;
  kind: FactKind;
  /** What it was learned from: one plain sentence per piece of evidence. */
  evidence: string[];
  /** The same noticing always hashes the same, so a rejection sticks. */
  fingerprint: string;
}
/** How many finished tasks are looked over, and how many suggestions one pass may make. */
export const learningWindow = 200;
export const maximumLearned = 6;
/** How many separate tasks must show the same thing before it is worth offering. */
export const repeatsNeeded = 3;
/** Openings that mark a person putting the assistant right; the learning core reads the same ones. */
export const correctionOpenings =
  /^(?:no[,.!\s]|not quite|actually[,\s]|that(?:'s| is) (?:wrong|not right|incorrect)|i meant|i said|wrong[,.!\s]|correction[:,\s])/i;
/** Capitals that are never a name however they are placed: the word for oneself, and this app. */
const neverNames = new Set(["I", "Branch"]);

const fingerprintOf = (signal: string, text: string): string =>
  createHash("sha256").update(`${signal}:${text.toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 24);
const day = (stamp: string): string => stamp.slice(0, 10);

interface FinishedRun { id: string; sessionId: string; prompt: string; createdAt: string }

export class MemoryLearning {
  private readonly db: DatabaseSync;
  constructor(private readonly store: Store) { this.db = store.sqlite; }

  private runs(owner: string): FinishedRun[] {
    return this.db.prepare(`SELECT id, session_id, prompt, created_at FROM tasks WHERE owner=? AND status='completed'
      ORDER BY created_at DESC LIMIT ?`).all(owner, learningWindow)
      .map((row) => ({ id: String(row.id), sessionId: String(row.session_id), prompt: String(row.prompt), createdAt: String(row.created_at) }));
  }

  /** Everything the three habits noticed, best supported first, with nothing yet written down. */
  notice(owner: string): LearnedCandidate[] {
    const runs = this.runs(owner);
    const found = [...this.revisitedFiles(runs), ...this.recurringNames(runs), ...this.corrections(runs)];
    const known = this.alreadyKnown(owner);
    return found
      .filter((candidate) => !detectInjection(candidate.text).length)
      .filter((candidate) => !known.has(candidate.fingerprint))
      .filter((candidate) => !this.alreadySaid(owner, candidate.text))
      .slice(0, maximumLearned);
  }

  /** Suggestions already made about the same noticing, accepted or turned down, so none is repeated. */
  private alreadyKnown(owner: string): Set<string> {
    return new Set(this.store.review.proposals(owner, "all")
      .flatMap((proposal) => (proposal.learned?.fingerprint ? [proposal.learned.fingerprint] : [])));
  }
  /** A fact already saved in these words is not offered again, however often it is noticed. */
  private alreadySaid(owner: string, text: string): boolean {
    const wanted = text.toLowerCase();
    return this.store.list("memory", owner).some((record) =>
      String((record.data as { text?: unknown }).text ?? "").toLowerCase() === wanted);
  }

  /** Files opened while doing several separate tasks: the ones a person keeps coming back to. */
  private revisitedFiles(runs: FinishedRun[]): LearnedCandidate[] {
    const byPath = new Map<string, { runs: Set<string>; last: string; prompts: string[] }>();
    const byId = new Map(runs.map((run) => [run.id, run]));
    for (const row of this.db.prepare(`SELECT run_id, data FROM events WHERE kind='tool.started' ORDER BY id DESC LIMIT 4000`).all()) {
      const run = byId.get(String(row.run_id));
      if (!run) continue;
      const path = String((JSON.parse(String(row.data)) as { path?: unknown }).path ?? "").slice(0, 200);
      if (!path) continue;
      const seen = byPath.get(path) ?? { runs: new Set<string>(), last: run.createdAt, prompts: [] };
      seen.runs.add(run.id);
      if (run.createdAt > seen.last) seen.last = run.createdAt;
      if (seen.prompts.length < 3) seen.prompts.push(run.prompt.slice(0, 120));
      byPath.set(path, seen);
    }
    return [...byPath.entries()].filter(([, seen]) => seen.runs.size >= repeatsNeeded)
      .sort((a, b) => b[1].runs.size - a[1].runs.size || a[0].localeCompare(b[0]))
      .map(([path, seen]) => ({
        signal: "file-revisited" as const, kind: "project-note" as FactKind,
        text: `You keep coming back to the file ${path}.`,
        source: "Noticed from what you have been doing",
        evidence: [`Opened while doing ${seen.runs.size} separate tasks, the last on ${day(seen.last)}.`,
          ...seen.prompts.map((prompt) => `One of those tasks: ${prompt}`)],
        fingerprint: fingerprintOf("file-revisited", path),
      }));
  }

  /** Names — people, projects, places — that keep turning up in what the owner asks for. */
  private recurringNames(runs: FinishedRun[]): LearnedCandidate[] {
    const byName = new Map<string, { runs: Set<string>; last: string }>();
    for (const run of runs)
      for (const name of new Set(namesIn(run.prompt))) {
        const seen = byName.get(name) ?? { runs: new Set<string>(), last: run.createdAt };
        seen.runs.add(run.id);
        if (run.createdAt > seen.last) seen.last = run.createdAt;
        byName.set(name, seen);
      }
    return [...byName.entries()].filter(([, seen]) => seen.runs.size >= repeatsNeeded)
      .sort((a, b) => b[1].runs.size - a[1].runs.size || a[0].localeCompare(b[0]))
      .map(([name, seen]) => ({
        signal: "name-recurs" as const, kind: "project-note" as FactKind,
        text: `${name} comes up often in what you ask for.`,
        source: "Noticed from what you have been doing",
        evidence: [`Named in ${seen.runs.size} separate tasks, the last on ${day(seen.last)}.`],
        fingerprint: fingerprintOf("name-recurs", name),
      }));
  }

  /** What the owner said when they were putting the assistant right in the middle of a task. */
  private corrections(runs: FinishedRun[]): LearnedCandidate[] {
    const found: LearnedCandidate[] = [];
    const seenSessions = new Set<string>();
    for (const run of runs.slice(0, 40)) {
      if (seenSessions.has(run.sessionId)) continue;
      seenSessions.add(run.sessionId);
      for (const message of this.store.messages(run.sessionId).slice(-40)) {
        if (message.role !== "user") continue;
        const text = String(message.content ?? "").trim();
        if (!correctionOpenings.test(text)) continue;
        const said = text.replace(/\s+/g, " ").slice(0, 300);
        found.push({
          signal: "correction", kind: "fact-about-world", text: `You corrected me: ${said}`,
          source: "A correction you made while we were working",
          evidence: [`You said this in a conversation on ${day(run.createdAt)}, after the assistant had it wrong.`],
          fingerprint: fingerprintOf("correction", said),
        });
      }
    }
    return found;
  }

  /**
   * Writes what was noticed into the same queue every other suggestion waits in. Nothing is saved:
   * each one sits under "What it learns" until the owner accepts or turns it down.
   */
  propose(owner: string): { proposals: Proposal[]; noticed: number } {
    const candidates = this.notice(owner);
    const proposals = candidates.map((candidate) => this.store.review.propose(owner, {
      kind: "put", text: candidate.text, source: candidate.source,
      note: candidate.evidence[0] ?? "", learned: candidate,
    }));
    return { proposals, noticed: candidates.length };
  }
}

/**
 * The names in a request: people, projects, places. A capital at the start of a sentence is there
 * because the sentence started, not because the word is a name — and a request is usually an
 * instruction, so its opening word is nearly always a verb. The first word of each sentence is
 * therefore dropped before anything is matched, which is what stops "Tidy up the figures" turning
 * into a note telling the owner that "Tidy" keeps coming up.
 */
export function namesIn(prompt: string): string[] {
  const found: string[] = [];
  for (const sentence of prompt.slice(0, 600).split(/[.!?;\n]+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const opener = trimmed.split(/\s+/)[0] ?? "";
    found.push(...(trimmed.slice(opener.length).match(/\b[A-Z][\p{L}]{2,29}\b/gu) ?? []));
  }
  return [...new Set(found)].filter((word) => !neverNames.has(word)).slice(0, 12);
}
