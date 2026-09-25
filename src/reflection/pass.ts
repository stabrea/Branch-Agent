import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { checkResult } from "../delegation.js";
import { detectInjection } from "../content-guard.js";
import { asLines, ownerTurns, turnsOf } from "./evidence.js";
import { reflectionSettings } from "./settings.js";
import { noteAction } from "./skill-notes.js";
import { lookBackSource } from "../memory-review.js";

/**
 * Looking back over a conversation. It reads only the turns since the last look, together with what
 * is remembered and which skills are on, and asks the model once for corrections, merges, facts set
 * aside, notes on skills and (when allowed) ideas for new skills. Every answer becomes a suggestion
 * in the owner's review queue, grouped as one batch; nothing is written without a yes.
 *
 * The shape of the pass (new turns only; memory edits first, a skill only for a repeatable
 * procedure; stale facts corrected at the source rather than added beside) follows Letta Code's
 * reflection subagent (Apache-2.0) and Hermes Agent's background review (MIT). Unlike both, it
 * never writes; see THIRD_PARTY_NOTICES.md.
 */
export type Ask = (instructions: string, question: string) => Promise<string>;
export type LookTrigger = "turns" | "compaction" | "asked";
export interface Batch {
  id: string; sessionId: string; runId: string; trigger: LookTrigger;
  /** Which of the conversation's messages were read, counted from one. */
  fromMessage: number; toMessage: number;
  proposalIds: string[]; createdAt: string;
}
interface Cursor { read: number; turns: number; at: string }
const cursorKey = (sessionId: string) => `reflection-cursor:${sessionId}`;
const batchPrefix = "reflection-batch:";
const keptBatches = 30;

export const lookBackInstructions = [
  "You look back over the latest turns of a conversation to keep the assistant's memory and skills in shape.",
  "You are not in the conversation and you change nothing: everything you say is shown to the owner as a suggestion.",
  "Look first for mistakes and corrections, then preferences, then new lasting facts, then remembered facts the turns contradict.",
  "Leave out anything tied to this one session (a line number, an error message, a temporary path) and anything already remembered.",
  "Write dates as dates, not 'yesterday'. Correct a stale fact where it is rather than adding a second one.",
  "A skill note is only for a skill listed as on whose steps the turns showed to be wrong or missing.",
  "Reply with JSON only:",
  '{"remember":[{"text":"","why":""}],"correct":[{"id":"","text":"","why":""}],"merge":[{"keep":"","others":[""],"text":"","why":""}],',
  '"setAside":[{"ids":[""],"why":""}],"skillNotes":[{"skillId":"","note":""}],"newSkills":[{"idea":"","why":""}]}',
  "Empty lists are the normal answer.",
].join(" ");

const Item = <T extends z.ZodRawShape>(shape: T) => z.array(z.object(shape).passthrough()).max(20).catch([]);
const AnswerSchema = z.object({
  remember: Item({ text: z.string().min(1).max(4000), why: z.string().max(500).catch("") }).default([]),
  correct: Item({ id: z.string().max(200), text: z.string().min(1).max(4000), why: z.string().max(500).catch("") }).default([]),
  merge: Item({ keep: z.string().max(200), others: z.array(z.string().max(200)).max(20), text: z.string().min(1).max(4000), why: z.string().max(500).catch("") }).default([]),
  setAside: Item({ ids: z.array(z.string().max(200)).min(1).max(20), why: z.string().max(500).catch("") }).default([]),
  skillNotes: Item({ skillId: z.string().max(200), note: z.string().min(1).max(4000) }).default([]),
  newSkills: Item({ idea: z.string().min(1).max(2000), why: z.string().max(500).catch("") }).default([]),
}).passthrough();
type Answer = z.infer<typeof AnswerSchema>;

export function cursorOf(store: Store, owner: string, sessionId: string): Cursor {
  return (store.get("settings", owner, cursorKey(sessionId))?.data as Cursor | undefined) ?? { read: 0, turns: 0, at: "" };
}
/** Whether enough of the owner's turns have passed since the last look. */
export function turnsDue(store: Store, owner: string, sessionId: string): boolean {
  const cursor = cursorOf(store, owner, sessionId);
  return ownerTurns(turnsOf(store, sessionId)) - cursor.turns >= reflectionSettings(store, owner).everyTurns;
}

/**
 * The facts the look back is shown, and so the only ones it may merge or correct: the owner's own private ones. It
 * writes words of its own choosing onto a fact it keeps, so a Trunk's or a shared fact could have been given the
 * owner's words (NAS ea14643, c4840ce).
 */
function whatIsKnown(store: Store, owner: string): { memory: string; skills: string; memoryIds: Set<string>; skillIds: Set<string> } {
  const facts = store.list("memory", owner).filter((fact) => (fact.data.scope ?? "private") === "private").slice(0, 60);
  const skills = store.skills.list(owner).filter((skill) => skill.activeVersion !== null);
  return {
    memory: facts.map((fact) => `[${fact.id}] ${String(fact.data.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(nothing yet)",
    skills: skills.map((skill) => `[${skill.id}] ${skill.name}: ${skill.description.slice(0, 200)}`).join("\n") || "(none)",
    memoryIds: new Set(facts.map((fact) => fact.id)), skillIds: new Set(skills.map((skill) => skill.id)),
  };
}

/** One look back. Answers null when there was nothing new to read. */
export async function lookBack(store: Store, input: { owner: string; sessionId: string; runId: string; trigger: LookTrigger; ask: Ask }): Promise<Batch | null> {
  const { owner, sessionId } = input;
  const messages = turnsOf(store, sessionId);
  const cursor = cursorOf(store, owner, sessionId);
  const fresh = messages.slice(Math.min(cursor.read, messages.length));
  if (!ownerTurns(fresh)) return null;
  const known = whatIsKnown(store, owner);
  const newSkills = reflectionSettings(store, owner).newSkills === "on";
  const question = `What is remembered now:\n${known.memory}\n\nSkills that are on:\n${known.skills}\n\n` +
    `${newSkills ? "" : "Leave newSkills empty.\n\n"}The new turns:\n${asLines(fresh, 16000)}`;
  const reply = await input.ask(lookBackInstructions, question);
  const checked = checkResult(reply, { type: "object" });
  if (checked.status !== "resolved") throw new Error(`The look back could not be read (${checked.reason})`);
  const answer = AnswerSchema.parse(checked.value);
  const batch: Batch = { id: randomUUID(), sessionId, runId: input.runId, trigger: input.trigger,
    fromMessage: cursor.read + 1, toMessage: messages.length, proposalIds: [], createdAt: new Date().toISOString() };
  const source = `${lookBackSource} ${batch.fromMessage}–${batch.toMessage} of a conversation`;
  batch.proposalIds = stage(store, owner, answer, { source, runId: input.runId, known, newSkills });
  saveBatch(store, owner, batch);
  store.save("settings", owner, cursorKey(sessionId), { read: messages.length, turns: ownerTurns(messages), at: batch.createdAt });
  if (input.runId) store.event(input.runId, "learning.looked_back", { batch: batch.id, trigger: input.trigger, suggestions: batch.proposalIds.length });
  return batch;
}

interface StageContext { source: string; runId: string; known: ReturnType<typeof whatIsKnown>; newSkills: boolean }
const clean = (text: string): boolean => !detectInjection(text).length;

/** Turns the model's answer into queue entries, dropping anything that names a fact or skill it was not shown. */
function stage(store: Store, owner: string, answer: Answer, at: StageContext): string[] {
  const ids: string[] = [];
  const put = (input: Record<string, unknown>) => {
    if (ids.length >= 12) return;
    try { ids.push(store.review.propose(owner, { source: at.source, runId: at.runId, ...input }).id); } catch { /* a malformed item is dropped */ }
  };
  const fact = (id: string) => at.known.memoryIds.has(id);
  for (const item of answer.remember.slice(0, 5)) if (clean(item.text)) put({ kind: "put", text: item.text, note: item.why });
  for (const item of answer.correct.slice(0, 5)) if (fact(item.id) && clean(item.text)) put({ kind: "update", memoryId: item.id, text: item.text, note: item.why });
  for (const item of answer.merge.slice(0, 3)) {
    const others = item.others.filter((id) => fact(id) && id !== item.keep);
    if (fact(item.keep) && others.length && clean(item.text)) put({ kind: "merge", memoryId: item.keep, memoryIds: [item.keep, ...others], text: item.text, note: item.why });
  }
  for (const item of answer.setAside.slice(0, 3)) {
    const chosen = item.ids.filter(fact);
    if (chosen.length) put({ kind: "archive", memoryIds: chosen, note: item.why || "Set aside after a look back" });
  }
  for (const item of answer.skillNotes.slice(0, 3)) {
    const before = ids.length;
    if (at.known.skillIds.has(item.skillId) && clean(item.note)) put({ kind: "skill-note", skillId: item.skillId, text: item.note });
    if (ids.length > before) noteAction(store, owner, ids.at(-1)!, { action: "revise" });
  }
  for (const item of at.newSkills ? answer.newSkills.slice(0, 2) : []) {
    const before = ids.length;
    if (clean(item.idea)) put({ kind: "skill-note", skillId: null, text: item.idea, note: item.why });
    if (ids.length > before) noteAction(store, owner, ids.at(-1)!, { action: "new-skill" });
  }
  return ids;
}

function saveBatch(store: Store, owner: string, batch: Batch): void {
  store.save("settings", owner, batchPrefix + batch.id, { ...batch });
  const all = batchRecords(store, owner);
  for (const old of all.slice(keptBatches)) store.delete("settings", owner, batchPrefix + old.id);
}
export function batchRecords(store: Store, owner: string): Batch[] {
  return store.list("settings", owner).filter((row) => row.id.startsWith(batchPrefix))
    .map((row) => row.data as unknown as Batch).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
