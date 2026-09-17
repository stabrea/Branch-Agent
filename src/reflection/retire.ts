import type { Store } from "../store.js";
import { reflectionSettings } from "./settings.js";
import { noteAction } from "./skill-notes.js";

/**
 * Skills nobody has used for a long time, offered for setting aside. No model is asked. Accepting
 * only switches the skill off; it stays installed, with its history, and can be switched back on.
 *
 * The idea (active, then stale, then archived, with skills a schedule relies on left alone) follows
 * Hermes Agent's curator (MIT); see THIRD_PARTY_NOTICES.md.
 */
export interface RetireReport { examinedTasks: number; since: string | null; offered: { skillId: string; name: string; proposalId: string }[]; reason: string }
const dayMs = 86_400_000;

/** Skill ids each of the examined tasks read or had pinned. */
function usedSkills(store: Store, owner: string): { used: Set<string>; examined: number; oldest: string | null; complete: boolean } {
  const runs = store.runs(owner);
  const governance = store.governanceFor(owner);
  const used = new Set<string>();
  for (const run of runs) for (const id of governance.skillsUsed(run.id)) used.add(id);
  // `runs()` stops at 100. With fewer than that, every task this workspace has is in view.
  return { used, examined: runs.length, oldest: runs.at(-1)?.createdAt ?? null, complete: runs.length < 100 };
}

function scheduledNames(store: Store, owner: string): string {
  return store.list("schedules", owner).map((row) => JSON.stringify(row.data)).join("\n").toLowerCase();
}

export function offerRetirements(store: Store, owner: string, now = new Date()): RetireReport {
  const days = reflectionSettings(store, owner).retireAfterDays;
  const cutoff = new Date(now.getTime() - days * dayMs).toISOString();
  const seen = usedSkills(store, owner);
  if (!seen.complete && (seen.oldest ?? "") > cutoff)
    return { examinedTasks: seen.examined, since: seen.oldest, offered: [],
      reason: `Only the last ${seen.examined} tasks are kept to look at, and they go back less than ${days} days, so no skill can be called unused.` };
  const schedules = scheduledNames(store, owner);
  const offered: RetireReport["offered"] = [];
  for (const skill of store.skills.list(owner)) {
    if (skill.activeVersion === null || seen.used.has(skill.id) || schedules.includes(skill.name)) continue;
    const installedAt = store.skills.view(owner, skill.id).versions.at(-1)?.createdAt ?? now.toISOString();
    if (installedAt > cutoff || recentlyOffered(store, owner, skill.id, cutoff)) continue;
    const proposal = store.review.propose(owner, {
      kind: "skill-note", skillId: skill.id, source: "Looked for skills nobody uses",
      text: `Set aside the skill ${skill.name}: no task has used it in the last ${days} days.`,
      note: `Looked at ${seen.examined} task(s)${seen.oldest ? ` going back to ${seen.oldest.slice(0, 10)}` : ""}. Setting it aside switches it off; it stays installed.`,
    });
    noteAction(store, owner, proposal.id, { action: "retire" });
    store.save("settings", owner, `skill-retire-offered:${skill.id}`, { at: now.toISOString(), proposalId: proposal.id });
    offered.push({ skillId: skill.id, name: skill.name, proposalId: proposal.id });
  }
  return { examinedTasks: seen.examined, since: seen.oldest, offered, reason: offered.length ? "" : "Every switched-on skill has been used recently, or was offered already." };
}

function recentlyOffered(store: Store, owner: string, skillId: string, cutoff: string): boolean {
  const at = (store.get("settings", owner, `skill-retire-offered:${skillId}`)?.data as { at?: string } | undefined)?.at;
  return !!at && at > cutoff;
}
