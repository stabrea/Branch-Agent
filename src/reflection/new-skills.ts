import { z } from "zod";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { TrialReport, TrialTask } from "../skill-revisions.js";
import { draftNewSkill, trialNewSkill } from "../skill-authoring.js";
import { lineDiff } from "../workspace-history.js";
import { audit } from "../audit.js";
import { similarTasks } from "./evidence.js";
import { reflectionSettings } from "./settings.js";

/**
 * Brand-new skills the assistant wrote. A draft is installed switched off, tried against having no
 * skill on the task it came from and up to two like it, and waits for the owner. Keeping it switches
 * it on; throwing it away removes it, since nothing ever used it.
 */
export type DraftOrigin = "asked" | "task" | "pattern" | "look-back";
export interface NewSkillDraft {
  skillId: string; name: string; description: string; origin: DraftOrigin;
  fromRunId: string; sessionId: string; createdAt: string;
  /** The whole file, drawn as lines added to nothing, the way a change to a skill is shown. */
  diff: string; lines: number;
  trial: TrialReport | null; trialTasks: TrialTask[]; trialProblem: string;
  decision: "accepted" | "rejected" | null; decidedAt: string | null;
}
export const DraftRequestSchema = z.object({
  evidence: z.string().trim().min(1).max(12000),
  notes: z.string().trim().max(2000).default(""),
  fromRunId: z.string().max(200).default(""),
  sessionId: z.string().max(200).default(""),
  /** The request the draft came from, tried again with and without the skill. */
  sourcePrompt: z.string().max(4000).default(""),
  origin: z.enum(["asked", "task", "pattern", "look-back"]),
}).strict();
const prefix = "skill-draft:";
type Saved = Omit<NewSkillDraft, "diff" | "lines"> & { document: string };

export class NewSkillDrafts {
  constructor(private readonly store: Store, private readonly owner: string, private readonly runtime: Runtime) {}
  private saved(skillId: string): Saved | undefined {
    return this.store.get("settings", this.owner, prefix + skillId)?.data as unknown as Saved | undefined;
  }
  private write(entry: Saved): void { this.store.save("settings", this.owner, prefix + entry.skillId, { ...entry }); }
  list(): NewSkillDraft[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith(prefix))
      .map((row) => row.data as unknown as Saved)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ document, ...entry }) => { const change = lineDiff("", document); return { ...entry, diff: change.diff, lines: change.added }; });
  }
  /** Refuses when the owner's switch does not allow a draft from this origin. */
  allowed(origin: DraftOrigin): void {
    const mode = reflectionSettings(this.store, this.owner).newSkills;
    if (mode === "off") throw new Error("Writing new skills is switched off. Turn it on in Customize, under Skills.");
    if (mode === "when-needed" && (origin === "task" || origin === "look-back"))
      throw new Error("Writing new skills is set to only when asked, so it does not draft one on its own.");
  }
  /** Drafts, installs switched off, then tries it. Null when the model found nothing worth a skill. */
  async draft(input: unknown): Promise<NewSkillDraft | null> {
    const spec = DraftRequestSchema.parse(input);
    this.allowed(spec.origin);
    const drafted = await draftNewSkill(this.store, this.owner, this.runtime, { evidence: spec.evidence, notes: spec.notes, fromRunId: spec.fromRunId });
    if (!drafted) return null;
    const trialTasks = [
      ...(spec.sourcePrompt.trim() ? [{ prompt: spec.sourcePrompt.slice(0, 4000), runId: spec.fromRunId }] : []),
      ...similarTasks(this.store, this.owner, `${drafted.name.replace(/-/g, " ")} ${drafted.description} ${spec.sourcePrompt}`, spec.fromRunId),
    ];
    this.write({ skillId: drafted.skillId, name: drafted.name, description: drafted.description, document: drafted.document,
      origin: spec.origin, fromRunId: spec.fromRunId, sessionId: spec.sessionId, createdAt: new Date().toISOString(),
      trial: null, trialTasks, trialProblem: "", decision: null, decidedAt: null });
    await this.tryOut(drafted.skillId).catch(() => undefined);
    return this.list().find((entry) => entry.skillId === drafted.skillId) ?? null;
  }
  async tryOut(skillId: string): Promise<TrialReport> {
    const entry = this.pending(skillId);
    try {
      const trial = await trialNewSkill(this.store, this.owner, this.runtime, skillId, entry.trialTasks);
      this.write({ ...this.pending(skillId), trial, trialProblem: "" });
      return trial;
    } catch (error) {
      this.write({ ...this.pending(skillId), trialProblem: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  private pending(skillId: string): Saved {
    const entry = this.saved(skillId);
    if (!entry) throw new Error("There is no new skill of that name waiting");
    if (entry.decision) throw new Error("That new skill was already decided");
    return entry;
  }
  /** Switches the skill on. Refused until it has been tried and did no worse than having none. */
  accept(skillId: string, options: { force?: boolean } = {}): NewSkillDraft {
    const entry = this.pending(skillId);
    if (!options.force && !entry.trial) throw new Error("Try the new skill on a past task first, so there is something to compare.");
    if (!options.force && entry.trial && !entry.trial.noWorse)
      throw new Error("Tasks went worse with the new skill than without it. Keep it anyway only if you mean to.");
    const skill = this.store.skills.view(this.owner, skillId);
    if (options.force)
      audit(this.store, this.owner, { action: "skill.forced", actor: this.owner, subject: `new skill ${skill.name}`, source: "owner", outcome: "allowed",
        reason: entry.trial ? "Tasks went worse with it, and it was switched on anyway." : "It was switched on without being tried on any past task." });
    this.store.skills.activate(this.owner, skillId, { version: skill.headVersion, expectedRevision: skill.revision, acknowledge: true });
    return this.decided(entry, "accepted");
  }
  /** Removes the skill, which nothing ever used; the record of the draft stays. */
  reject(skillId: string): NewSkillDraft {
    const entry = this.pending(skillId);
    try {
      const skill = this.store.skills.view(this.owner, skillId);
      if (skill.activeVersion === null) this.store.skills.remove(this.owner, skillId, { expectedRevision: skill.revision });
    } catch { /* already gone: the decision is still recorded */ }
    return this.decided(entry, "rejected");
  }
  private decided(entry: Saved, decision: "accepted" | "rejected"): NewSkillDraft {
    this.write({ ...entry, decision, decidedAt: new Date().toISOString() });
    return this.list().find((item) => item.skillId === entry.skillId)!;
  }
}
