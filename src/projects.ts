import { z } from "zod";
import type { Store } from "./store.js";
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
}).strict();
export type Project = z.infer<typeof ProjectSchema>;
export const defaultProjectId = "default";
const activeSchema = z.object({ active: projectIdSchema }).strict();

export class Projects {
  constructor(private readonly store: Store) {}
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
    this.store.save("settings", owner, "projects", { active });
    return this.active(owner);
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
  private defaultProject(): Project {
    return { id: defaultProjectId, name: "Default", instructions: "", modelPreset: null, repository: "" };
  }
}
