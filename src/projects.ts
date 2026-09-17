import { z } from "zod";
import type { Store } from "./store.js";
import { audit } from "./audit.js";
import { projectIdSchema } from "./locker.js";

/**
 * Projects group a person's work: their own instructions, a preferred model and their secrets.
 * One project is active at a time; "default" always exists and cannot be removed.
 */
export const ProjectSchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(4000).default(""),
  modelPreset: z.string().min(1).max(64).nullable().default(null),
  repository: z.string().max(500).default(""),
  /** A folder inside the workspace that this project's files live in; empty means the whole workspace. */
  folder: z.string().max(200).regex(/^(?!.*(^|\/)\.\.(\/|$))[^\\:\0]*$/, "Use a relative folder name inside the workspace").transform((v) => v.replace(/^\/+|\/+$/g, "")).default(""),
  /** The way of working this project's tasks start from, when it has one (see src/model-profiles.ts). */
  profile: z.string().trim().max(64).nullable().default(null),
  /** Which collections of the person's own documents this project's tasks look in first. */
  knowledgeBases: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
  /**
   * The line of work in Git this project is about. Switching to the project switches the folder to
   * it (see src/git-checkpoint.ts). Empty, which every project written before this is, changes
   * nothing at all about the folder.
   */
  branch: z.string().trim().max(100).default(""),
}).strict();
export type Project = z.infer<typeof ProjectSchema>;
export const defaultProjectId = "default";
const activeSchema = z.object({ active: projectIdSchema }).strict();

export class Projects {
  constructor(private readonly store: Store) {}
  /**
   * Told whenever the active project really changes. The git side listens, so a project that names
   * a line of work switches the folder to it; nothing else has to know that happens.
   */
  private readonly switched = new Set<(owner: string, project: Project) => void>();
  onSwitched(listener: (owner: string, project: Project) => void): () => void {
    this.switched.add(listener);
    return () => void this.switched.delete(listener);
  }
  list(owner: string): Project[] {
    const saved = this.store.list("settings", owner)
      .filter((record) => record.id.startsWith("project:"))
      .map((record) => ProjectSchema.safeParse(record.data))
      .flatMap((result) => (result.success ? [result.data] : []))
      .sort((a, b) => a.id.localeCompare(b.id));
    return saved.some((project) => project.id === defaultProjectId)
      ? saved
      : [this.defaultProject(), ...saved];
  }
  active(owner: string): Project {
    const saved = activeSchema.safeParse(this.store.get("settings", owner, "projects")?.data ?? {});
    const id = saved.success ? saved.data.active : defaultProjectId;
    return this.list(owner).find((project) => project.id === id) ?? this.defaultProject();
  }
  setActive(owner: string, input: unknown): Project {
    const { active } = activeSchema.parse(input);
    if (!this.list(owner).some((project) => project.id === active)) throw new Error("Project not found");
    const before = this.active(owner).id;
    this.store.save("settings", owner, "projects", { active });
    const now = this.active(owner);
    if (before !== active) {
      audit(this.store, owner, { action: "profile.switched", actor: owner, subject: `${before} to ${active}`,
        reason: "The active project decides which folder and which saved secrets it can reach", outcome: "saved" });
      for (const listener of this.switched)
        try { listener(owner, now); } catch { /* telling someone must never break the switch */ }
    }
    return now;
  }
  save(owner: string, input: unknown): Project {
    const project = ProjectSchema.parse(input);
    if (this.list(owner).length >= 32 && !this.list(owner).some((p) => p.id === project.id)) throw new Error("At most 32 projects");
    this.store.save("settings", owner, `project:${project.id}`, project);
    return project;
  }
  remove(owner: string, id: string): { removed: boolean; active: string } {
    projectIdSchema.parse(id);
    if (id === defaultProjectId) throw new Error("The default project cannot be removed");
    if (!this.store.delete("settings", owner, `project:${id}`)) throw new Error("Project not found");
    if (this.active(owner).id === id) this.store.save("settings", owner, "projects", { active: defaultProjectId });
    return { removed: true, active: this.active(owner).id };
  }
  /** Instructions the active project adds to every task, or an empty string. */
  instructions(owner: string): string {
    const project = this.active(owner);
    return project.instructions ? `\nProject "${project.name}" instructions: ${project.instructions}\n` : "";
  }
  /**
   * What the active project brings to a task besides its instructions: the model connection it
   * prefers, the way of working it starts from, and the document collections to look in first.
   * Each one is only a starting point — anything chosen for this conversation still wins.
   */
  defaults(owner: string): { projectId: string; name: string; modelPreset: string | null; profile: string | null; knowledgeBases: string[] } {
    const project = this.active(owner);
    return { projectId: project.id, name: project.name, modelPreset: project.modelPreset,
      profile: project.profile, knowledgeBases: project.knowledgeBases };
  }
  private defaultProject(): Project {
    return { id: defaultProjectId, name: "Default", instructions: "", modelPreset: null, repository: "",
      folder: "", profile: null, knowledgeBases: [], branch: "" };
  }
}
