import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { WorkspaceFiles } from "./files.js";
import { lineDiff } from "./workspace-history.js";
import { parseSkillDocument } from "./skill-document.js";

/**
 * A skill that improves itself, but never behind the owner's back. When a task goes well the app
 * drafts a better version of the skill it used. Before that draft is ever offered, it is tried
 * against the version in use on the last three real tasks — as a practice run, so nothing is
 * actually done — and the two are compared. The owner then sees the changed lines side by side and
 * says yes or no. A draft they never accept simply sits there; nothing switches over on its own.
 */
export interface TrialTask { prompt: string; runId: string }
export interface TrialSide { finished: number; ms: number; tokens: number }
export interface TrialReport {
  tasks: number; baseline: TrialSide; candidate: TrialSide;
  /** Whether the draft did at least as well as the version in use. */
  noWorse: boolean; ranAt: string; parentRunId: string;
}
export interface RevisionCandidate {
  skillId: string; skillName: string; version: number; activeVersion: number | null;
  fromRunId: string; createdAt: string;
  /** The lines that changed, exactly as the file history shows a change. */
  diff: string; added: number; removed: number;
  trial: TrialReport | null;
  decision: "accepted" | "rejected" | null; decidedAt: string | null;
}

export class SkillRevisions {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private key(skillId: string, version: number): string { return `skill-candidate:${skillId}:${version}`; }
  private saved(skillId: string, version: number): Record<string, unknown> | undefined {
    return this.store.get("settings", this.owner, this.key(skillId, version))?.data as Record<string, unknown> | undefined;
  }
  /** Every drafted version still waiting for a yes or a no, newest first. */
  list(): RevisionCandidate[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("skill-candidate:"))
      .map((row) => this.describe(row.id.split(":")[1]!, Number(row.id.split(":")[2]), row.data as Record<string, unknown>))
      .filter((entry): entry is RevisionCandidate => entry !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private describe(skillId: string, version: number, saved: Record<string, unknown>): RevisionCandidate | null {
    const skill = (() => { try { return this.store.skills.view(this.owner, skillId); } catch { return null; } })();
    if (!skill) return null;
    const base = skill.activeVersion ?? Math.max(1, version - 1);
    const before = this.documentOf(skillId, base), after = this.documentOf(skillId, version);
    if (after === null) return null;
    const change = lineDiff(before ?? "", after);
    return { skillId, skillName: skill.name, version, activeVersion: skill.activeVersion,
      fromRunId: String(saved.fromRunId ?? ""), createdAt: String(saved.createdAt ?? ""),
      diff: change.diff, added: change.added, removed: change.removed,
      trial: (saved.trial as TrialReport | undefined) ?? null,
      decision: (saved.decision as RevisionCandidate["decision"]) ?? null,
      decidedAt: saved.decidedAt ? String(saved.decidedAt) : null };
  }
  private documentOf(skillId: string, version: number): string | null {
    try { return this.store.skills.read(this.owner, skillId, { version }).document; } catch { return null; }
  }
  /** The last few real tasks that used this skill, newest first, so the draft is tried on real work. */
  recentTasks(skillId: string, limit = 3): TrialTask[] {
    const governance = this.store.governanceFor(this.owner);
    const tasks: TrialTask[] = [];
    for (const run of this.store.runs(this.owner)) {
      if (tasks.length >= limit) break;
      if (run.status !== "completed" || !run.prompt.trim()) continue;
      if (!governance.skillsUsed(run.id).includes(skillId)) continue;
      tasks.push({ prompt: run.prompt.slice(0, 4000), runId: run.id });
    }
    return tasks;
  }
  /**
   * Tries the draft and the version in use on the same recent tasks as a practice run, where every
   * tool that would change something only reports what it would have done, and compares the two.
   */
  async tryOut(runtime: Runtime, skillId: string, version: number): Promise<TrialReport> {
    const skill = this.store.skills.view(this.owner, skillId);
    const base = skill.activeVersion ?? Math.max(1, version - 1);
    const documents = { baseline: this.documentOf(skillId, base) ?? "", candidate: this.documentOf(skillId, version) ?? "" };
    const tasks = this.recentTasks(skillId);
    if (!tasks.length) throw new Error("This skill has not been used on a finished task yet, so there is nothing to try the draft against.");
    const parent = await runtime.run({ prompt: `Try the draft of "${skill.name}" against version ${base} on ${tasks.length} recent task(s)`, dryRun: true });
    const context = runtime.context({ runId: parent.id, dryRun: true });
    const sides = { baseline: { finished: 0, ms: 0, tokens: 0 }, candidate: { finished: 0, ms: 0, tokens: 0 } };
    for (const task of tasks) for (const side of ["baseline", "candidate"] as const) {
      const started = Date.now();
      const run = await runtime.delegate(task.prompt, context, [...context.permissions],
        `The skill being tried (${side}):\n${documents[side]}`, { timeoutMs: 120000 }).catch(() => null);
      const usage = run ? this.store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number } : {};
      sides[side].finished += run?.status === "completed" ? 1 : 0;
      sides[side].ms += Date.now() - started;
      sides[side].tokens += (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0);
    }
    const report: TrialReport = { tasks: tasks.length, baseline: sides.baseline, candidate: sides.candidate,
      noWorse: sides.candidate.finished >= sides.baseline.finished, ranAt: new Date().toISOString(), parentRunId: parent.id };
    this.store.save("settings", this.owner, this.key(skillId, version), { ...(this.saved(skillId, version) ?? {}), trial: report });
    this.store.event(parent.id, "skill.candidate_tried", { skillId, version, ...report });
    return report;
  }
  /** Switches the draft on. It is refused until it has been tried and did no worse. */
  accept(skillId: string, version: number, options: { force?: boolean } = {}): RevisionCandidate {
    const saved = this.saved(skillId, version);
    if (!saved) throw new Error("There is no draft of that skill waiting");
    const trial = saved.trial as TrialReport | undefined;
    if (!options.force && !trial)
      throw new Error("Try the draft on the last few tasks first, so there is something to compare.");
    if (!options.force && trial && !trial.noWorse)
      throw new Error("The draft did worse than the version in use on those tasks. Accept it anyway only if you mean to.");
    const skill = this.store.skills.view(this.owner, skillId);
    this.store.skills.activate(this.owner, skillId, { version, expectedRevision: skill.revision, acknowledge: true });
    this.store.save("settings", this.owner, this.key(skillId, version), { ...saved, decision: "accepted", decidedAt: new Date().toISOString() });
    return this.describe(skillId, version, { ...saved, decision: "accepted", decidedAt: new Date().toISOString() })!;
  }
  /** Says no. The version stays in the skill's history, but it is never the one in use. */
  reject(skillId: string, version: number): RevisionCandidate {
    const saved = this.saved(skillId, version);
    if (!saved) throw new Error("There is no draft of that skill waiting");
    const next = { ...saved, decision: "rejected", decidedAt: new Date().toISOString() };
    this.store.save("settings", this.owner, this.key(skillId, version), next);
    return this.describe(skillId, version, next)!;
  }
}

export const SkillSyncSchema = z.object({
  /** A folder inside the workspace — the owner's own git folder, if they keep their skills in one. */
  folder: z.string().min(1).max(300),
  direction: z.enum(["out", "in", "both"]).default("both"),
}).strict();
export interface SyncReport {
  folder: string; written: string[]; installed: string[]; updated: string[]; unchanged: string[]; skipped: { file: string; reason: string }[];
}
const fileNameFor = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "skill"}.md`;

/**
 * Skills as files in a folder the owner names, so they can be kept in version control like anything
 * else. Out writes every skill into the folder; in reads the folder back, installing what is new and
 * adding a version where the text has changed. Nothing is ever deleted by a sync.
 */
export async function syncSkills(store: Store, owner: string, files: WorkspaceFiles, input: unknown): Promise<SyncReport> {
  const { folder, direction } = SkillSyncSchema.parse(input);
  await files.checked(folder, true);
  const report: SyncReport = { folder, written: [], installed: [], updated: [], unchanged: [], skipped: [] };
  if (direction !== "in") await writeOut(store, owner, files, folder, report);
  if (direction !== "out") await readIn(store, owner, files, folder, report);
  return report;
}
async function writeOut(store: Store, owner: string, files: WorkspaceFiles, folder: string, report: SyncReport): Promise<void> {
  for (const skill of store.skills.list(owner)) {
    const view = store.skills.view(owner, skill.id);
    const file = `${folder}/${fileNameFor(view.name)}`;
    await files.write(file, view.document, AbortSignal.timeout(10000));
    report.written.push(file);
  }
}
async function readIn(store: Store, owner: string, files: WorkspaceFiles, folder: string, report: SyncReport): Promise<void> {
  const listing = await files.list(folder).catch(() => ({ entries: [] as { name: string; type?: string }[] }));
  const byName = new Map(store.skills.list(owner).map((skill) => [skill.name, skill]));
  for (const entry of listing.entries.slice(0, 50)) {
    if (!entry.name.endsWith(".md")) continue;
    const file = `${folder}/${entry.name}`;
    try {
      const { content } = await files.read(file);
      const name = parseSkillDocument(content).name;
      const existing = byName.get(name);
      if (!existing) { store.skills.install(owner, { document: content }); report.installed.push(file); continue; }
      const view = store.skills.view(owner, existing.id);
      if (view.document === content) { report.unchanged.push(file); continue; }
      store.skills.update(owner, existing.id, { document: content, expectedRevision: view.revision });
      report.updated.push(file);
    } catch (error) {
      report.skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function registerSkillSync(registry: ToolRegistry, store: Store, files: WorkspaceFiles): void {
  registry.register({
    name: "skills.sync", permission: "skills.manage", group: "skills",
    description: "Keep the installed skills as .md files in a folder in the workspace, so they can be kept in version control. \"out\" writes them into the folder, \"in\" reads the folder back, installing what is new and adding a version where the text has changed. Nothing is ever deleted.",
    parameters: SkillSyncSchema,
    target: (args) => args.folder,
    execute: async (args, context: ToolContext) => syncSkills(store, context.owner, files, args),
  });
}
