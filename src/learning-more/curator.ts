import { z } from "zod";
import { noteAction } from "../reflection/skill-notes.js";
import type { Store } from "../store.js";

/**
 * R17-053: the curator's two missing halves. `usage` counts how many recent tasks used each skill
 * and when it was last used; `overlaps` finds skills that say much the same thing; a merge is shown
 * as a dry run first, and only on the owner's press becomes two suggestions in the review queue —
 * "work these lines into the skill that stays" and "set the other one aside". Accepting them runs
 * the existing reflection machinery (src/reflection/skill-notes.ts): the kept skill gets a new,
 * switched-off, tried version, and the other is switched off, never deleted. No model is asked here.
 *
 * The idea follows Hermes Agent's curator and skill usage counts (MIT); see THIRD_PARTY_NOTICES.md.
 */
export interface SkillUse { id: string; name: string; active: boolean; uses: number; lastUsedAt: string | null }
export interface UsageReport { examinedTasks: number; since: string | null; complete: boolean; skills: SkillUse[]; note: string }
export interface Overlap { a: { id: string; name: string }; b: { id: string; name: string }; similarity: number; shared: string[] }
export const overlapThreshold = 0.45;
export const MergeSchema = z.object({ keepId: z.string().min(1).max(200), foldId: z.string().min(1).max(200) }).strict();

const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "when", "then", "into", "use", "not", "any", "all", "each", "its", "it's", "was", "has", "have", "will", "can", "one", "two", "name", "description"]);
export function wordsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !stop.has(word)));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}
const lineKey = (line: string): string => line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export class Curator {
  constructor(private readonly store: Store) {}

  usage(owner: string): UsageReport {
    const runs = this.store.runs(owner), governance = this.store.governanceFor(owner);
    const counts = new Map<string, { uses: number; last: string | null }>();
    for (const run of runs) for (const id of governance.skillsUsed(run.id)) {
      const entry = counts.get(id) ?? { uses: 0, last: null };
      entry.uses += 1;
      if (!entry.last || run.createdAt > entry.last) entry.last = run.createdAt;
      counts.set(id, entry);
    }
    const skills = this.store.skills.list(owner).map((skill) => ({
      id: skill.id, name: skill.name, active: skill.activeVersion !== null,
      uses: counts.get(skill.id)?.uses ?? 0, lastUsedAt: counts.get(skill.id)?.last ?? null,
    })).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
    // `runs()` stops at 100, so a count is only over those; the report says so rather than implying all time.
    const complete = runs.length < 100;
    return { examinedTasks: runs.length, since: runs.at(-1)?.createdAt ?? null, complete, skills,
      note: complete ? "" : `Counted over the last ${runs.length} tasks only; older tasks are not kept to count.` };
  }

  overlaps(owner: string): Overlap[] {
    const skills = this.store.skills.list(owner).map((skill) => ({
      id: skill.id, name: skill.name, words: wordsOf(this.store.skills.view(owner, skill.id).document),
    }));
    const found: Overlap[] = [];
    for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!, b = skills[j]!, similarity = jaccard(a.words, b.words);
      if (similarity < overlapThreshold) continue;
      const shared = [...a.words].filter((word) => b.words.has(word)).slice(0, 12);
      found.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, similarity: Math.round(similarity * 100) / 100, shared });
    }
    return found.sort((x, y) => y.similarity - x.similarity).slice(0, 50);
  }

  /** What a merge would do, changing nothing: the lines only the other skill has. */
  dryRun(owner: string, input: unknown) {
    const { keepId, foldId } = MergeSchema.parse(input);
    if (keepId === foldId) throw new Error("Choose two different skills to merge.");
    const keep = this.store.skills.view(owner, keepId), fold = this.store.skills.view(owner, foldId);
    const known = new Set(keep.document.split("\n").map(lineKey).filter(Boolean));
    const onlyInFold = fold.document.split("\n").map((line) => line.trim())
      .filter((line) => line && !line.startsWith("---") && !line.startsWith("#") && !/^(name|description):/i.test(line) && !known.has(lineKey(line))).slice(0, 40);
    const uses = new Map(this.usage(owner).skills.map((skill) => [skill.id, skill.uses]));
    const note = onlyInFold.length
      ? `Merge ${fold.name} into ${keep.name}. Work in what only ${fold.name} says:\n${onlyInFold.map((line) => `- ${line}`).join("\n")}`
      : `Merge ${fold.name} into ${keep.name}. ${keep.name} already says everything ${fold.name} does.`;
    return {
      keep: { id: keep.id, name: keep.name, uses: uses.get(keep.id) ?? 0 },
      fold: { id: fold.id, name: fold.name, uses: uses.get(fold.id) ?? 0 },
      onlyInFold, note: note.slice(0, 3900), changed: false as const,
      next: `Suggesting this puts two items in the review queue: a new version of ${keep.name}, and setting ${fold.name} aside.`,
    };
  }

  /** The owner's yes to a dry run: two suggestions, nothing applied yet. */
  suggest(owner: string, input: unknown) {
    const plan = this.dryRun(owner, input);
    const revise = this.store.review.propose(owner, { kind: "skill-note", skillId: plan.keep.id, text: plan.note,
      source: "Merging skills that say the same thing", note: `Suggested by the curator after a dry run.` });
    noteAction(this.store, owner, revise.id, { action: "revise" });
    const retire = this.store.review.propose(owner, { kind: "skill-note", skillId: plan.fold.id,
      text: `Set aside the skill ${plan.fold.name}: it is being merged into ${plan.keep.name}.`,
      source: "Merging skills that say the same thing", note: "Setting it aside switches it off; it stays installed." });
    noteAction(this.store, owner, retire.id, { action: "retire" });
    return { ...plan, proposals: [revise.id, retire.id] };
  }
}
