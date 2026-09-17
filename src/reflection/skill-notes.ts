import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { Proposal } from "../memory-review.js";
import { SkillRevisions } from "../skill-revisions.js";
import { draftFromNote } from "../skill-authoring.js";
import { asLines, turnsOf } from "./evidence.js";
import type { LearningJobs } from "./jobs.js";
import type { NewSkillDrafts } from "./new-skills.js";
import { reflectionSettings } from "./settings.js";

/**
 * What accepting a "skill note" in the review queue does. It used to answer `{ noted: true }` and
 * change nothing. Now:
 *
 * - a note on an existing skill is written into a new, switched-off version of that skill, which is
 *   tried on the last few tasks that used it and then listed under "Suggested better versions"
 *   with its diff. Switching to it is a second yes, there.
 * - a note with no skill (a skill idea, from the learning core or a look back) becomes a brand-new
 *   skill draft, tried and listed under "Skills your assistant wrote", when writing new skills is
 *   not switched off. While it is off, the idea is only noted, as before.
 * - a note offering to set aside a skill nobody uses switches that skill off.
 *
 * Accepting in the queue is synchronous, so the writing and trying happen in the background.
 */
export type NoteKind = "retire" | "revise" | "new-skill";
const sidecar = (proposalId: string): string => `reflection-note:${proposalId}`;

/** Remembers what a note the learning passes staged is for, beside the queue entry. */
export function noteAction(store: Store, owner: string, proposalId: string, value: { action: NoteKind }): void {
  store.save("settings", owner, sidecar(proposalId), { ...value });
}
export function noteKind(store: Store, owner: string, proposal: Proposal): NoteKind {
  const saved = (store.get("settings", owner, sidecar(proposal.id))?.data as { action?: NoteKind } | undefined)?.action;
  return saved ?? (proposal.skillId ? "revise" : "new-skill");
}

export class SkillNotes {
  constructor(private readonly store: Store, private readonly runtime: Runtime,
    private readonly drafts: NewSkillDrafts, private readonly jobs: LearningJobs) {}
  apply(owner: string, proposal: Proposal): unknown {
    const kind = noteKind(this.store, owner, proposal);
    if (kind !== "new-skill" && !this.store.skills.list(owner).some((skill) => skill.id === proposal.skillId))
      throw new Error("The skill this note is about is no longer installed");
    if (kind === "retire") return this.retire(owner, proposal);
    if (kind === "revise") return this.revise(owner, proposal);
    return this.newSkill(owner, proposal);
  }
  private retire(owner: string, proposal: Proposal) {
    const skill = this.store.skills.view(owner, String(proposal.skillId));
    if (skill.activeVersion !== null) this.store.skills.disable(owner, skill.id, { expectedRevision: skill.revision });
    return { setAside: skill.id, name: skill.name };
  }
  private revise(owner: string, proposal: Proposal) {
    const skill = this.store.skills.view(owner, String(proposal.skillId));
    this.jobs.start(`Work a note into ${skill.name}`, async () => {
      const drafted = await draftFromNote(this.store, owner, this.runtime, { skillId: skill.id, note: proposal.text, runId: proposal.runId });
      try {
        await new SkillRevisions(this.store, owner).tryOut(this.runtime, skill.id, drafted.candidateVersion);
        return `Version ${drafted.candidateVersion} of ${skill.name} is written and tried.`;
      } catch (error) {
        return `Version ${drafted.candidateVersion} of ${skill.name} is written but not tried: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    return { drafting: true, skillId: skill.id, name: skill.name,
      next: "A new version is being written and tried. It will wait under Suggested better versions." };
  }
  private newSkill(owner: string, proposal: Proposal) {
    // While writing new skills is off, accepting an idea does exactly what it always did.
    if (reflectionSettings(this.store, owner).newSkills === "off") return { noted: true };
    const source = proposal.runId ? this.store.run(proposal.runId) : undefined;
    const evidence = [`The idea: ${proposal.text}`, proposal.note,
      source && source.owner === owner ? `The task it came from:\n${asLines(turnsOf(this.store, source.sessionId), 8000)}` : ""]
      .filter(Boolean).join("\n\n");
    this.jobs.start("Write a new skill from an idea", async () => {
      const draft = await this.drafts.draft({ evidence, fromRunId: proposal.runId, sessionId: source?.sessionId ?? "",
        sourcePrompt: source?.prompt ?? "", origin: "pattern" });
      return draft ? `Drafted ${draft.name}.` : "Nothing in it was worth a skill.";
    });
    return { drafting: true, skillId: null, next: "A new skill is being written and tried. It will wait under Skills your assistant wrote." };
  }
}
