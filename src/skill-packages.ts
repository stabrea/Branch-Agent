import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { errorText } from "./contracts.js";
import {
  packSkill, readSkillPackage, requestedPermissions, SkillHooksSchema, SkillToolsSchema,
  type SkillPackageManifest,
} from "./skill-package.js";
import { registerHttpTools, secretsUsed, type HttpToolHost } from "./skill-http-tools.js";

/**
 * Installing and sharing skill packages. Opening a package shows the owner what it is and what it
 * asks for; nothing is installed until they say yes. The instructions go through the same check
 * every skill goes through and arrive switched off, so a package cannot act on its own: the web
 * calls it declares are registered as tools but refuse to run until the owner switches the skill
 * on. The events it lists start one of the owner's own recipes, and it can never bring a recipe
 * of its own.
 */
export const PackageInstallSchema = z.object({
  /** The package file, base64 encoded, as the browser or the CLI read it. */
  file: z.string().min(1).max(1024 * 1024),
  /** Set once the owner has seen the list of what the package asks for. */
  approve: z.boolean().default(false),
}).strict();
export const PackagePackSchema = z.object({
  author: z.string().trim().min(1).max(120),
  packageVersion: z.string().max(20).default("1.0.0"),
}).strict();
interface PackageRecord { skillId: string; manifest: SkillPackageManifest; files: Record<string, string>; installedAt: string }

export class SkillPackages {
  private readonly toolNames = new Map<string, string[]>();
  private stopListening: (() => void) | undefined;
  /** Set by the launcher so a package's hooks can start one of the owner's verified recipes. */
  replayRecipe: ((recipe: string, event: string, runId: string) => Promise<void>) | undefined;
  private firing = false;
  constructor(private readonly store: Store, private readonly owner: string, private readonly registry: ToolRegistry, private readonly host: HttpToolHost) {}
  private key(skillId: string): string { return `skill-package:${skillId}`; }
  private records(): PackageRecord[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("skill-package:"))
      .map((row) => row.data as unknown as PackageRecord);
  }
  /** What is inside a package and what it asks to be allowed to do. Nothing is installed by looking. */
  inspect(bytes: Buffer) {
    const { manifest, files } = readSkillPackage(bytes);
    const tools = files["tools.json"] ? SkillToolsSchema.parse(JSON.parse(files["tools.json"])).tools : [];
    return {
      manifest, permissions: requestedPermissions(files),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, method: tool.method, address: tool.url, secrets: secretsUsed(tool) })),
      hooks: files["hooks.json"] ? SkillHooksSchema.parse(JSON.parse(files["hooks.json"])).hooks : [],
      document: files["SKILL.md"] ?? "",
    };
  }
  /** The packages installed whose skill still exists, so a forgotten one never blocks an install. */
  private live(): PackageRecord[] {
    const skills = new Set(this.store.skills.list(this.owner).map((skill) => skill.id));
    return this.records().filter((record) => skills.has(record.skillId));
  }
  /** Installs a package the owner has approved: the skill arrives switched off, its tools are registered. */
  install(bytes: Buffer, approve: boolean) {
    const preview = this.inspect(bytes);
    if (!approve) return { installed: false, ...preview };
    if (this.live().some((record) => record.manifest.name === preview.manifest.name))
      throw new Error(`A package called "${preview.manifest.name}" is already installed. Remove that skill first, then install this one.`);
    const { files } = readSkillPackage(bytes);
    const skill = this.store.skills.install(this.owner, { document: preview.document });
    if (skill.activeVersion !== null) this.store.skills.disable(this.owner, skill.id, { expectedRevision: skill.revision });
    const record: PackageRecord = { skillId: skill.id, manifest: preview.manifest, files, installedAt: new Date().toISOString() };
    // The tools go in first: if a name is taken, the half-installed skill is taken back out again.
    try { this.registerTools(record); }
    catch (error) {
      const current = this.store.skills.view(this.owner, skill.id);
      this.store.skills.remove(this.owner, skill.id, { expectedRevision: current.revision });
      throw error;
    }
    this.store.save("settings", this.owner, this.key(skill.id), { ...record });
    return { installed: true, ...preview, skill: this.store.skills.view(this.owner, skill.id) };
  }
  /** Rebuilds a package file from an installed skill, using its newest instructions. */
  pack(skillId: string, input: unknown): { filename: string; base64: string } {
    const options = PackagePackSchema.parse(input);
    const view = this.store.skills.view(this.owner, skillId);
    const saved = this.store.get("settings", this.owner, this.key(skillId))?.data as unknown as PackageRecord | undefined;
    const files = { ...(saved?.files ?? {}), "SKILL.md": view.document };
    const bytes = packSkill({ files, author: options.author, packageVersion: options.packageVersion, description: view.description ?? "" });
    return { filename: `${view.name}-${options.packageVersion}.branchskill`, base64: bytes.toString("base64") };
  }
  list() {
    const skills = new Map(this.store.skills.list(this.owner).map((skill) => [skill.id, skill]));
    return this.records().filter((record) => skills.has(record.skillId)).map((record) => ({
      skillId: record.skillId, name: record.manifest.name, author: record.manifest.author,
      packageVersion: record.manifest.packageVersion, installedAt: record.installedAt,
      permissions: requestedPermissions(record.files), tools: this.toolNames.get(record.skillId) ?? [],
      enabled: skills.get(record.skillId)!.activeVersion !== null,
    }));
  }
  /** Takes a package's tools out of the catalog and forgets it; the skill itself is removed separately. */
  forget(skillId: string): void {
    for (const name of this.toolNames.get(skillId) ?? []) this.registry.unregister(name);
    this.toolNames.delete(skillId);
    this.store.delete("settings", this.owner, this.key(skillId));
  }
  /**
   * Registers the tools of every installed package and starts listening for their events. A package
   * that cannot be put back is reported rather than stopping the assistant from starting at all.
   */
  restore(): { skill: string; error: string }[] {
    const problems: { skill: string; error: string }[] = [];
    for (const record of this.records()) {
      if (this.toolNames.has(record.skillId)) continue;
      try { this.registerTools(record); }
      catch (error) { problems.push({ skill: record.manifest.name, error: errorText(error).slice(0, 200) }); }
    }
    this.stopListening ??= this.store.onEvent((runId, kind) => this.fire(kind, runId));
    return problems;
  }
  stop(): void { this.stopListening?.(); this.stopListening = undefined; }
  /** Whether the skill a package brought is switched on; its web calls only run while it is. */
  private enabled(skillId: string): boolean {
    return this.store.skills.list(this.owner).some((skill) => skill.id === skillId && skill.activeVersion !== null);
  }
  private registerTools(record: PackageRecord): void {
    const file = record.files["tools.json"];
    if (!file) return;
    const { tools } = SkillToolsSchema.parse(JSON.parse(file));
    this.toolNames.set(record.skillId, registerHttpTools(this.registry, this.host, record.manifest.name, tools, () => this.enabled(record.skillId)));
  }
  /** Starts the recipe a package asked for when its event happens; a failure never disturbs the task. */
  private fire(event: string, runId: string): void {
    if (this.firing || !this.replayRecipe) return;
    for (const record of this.records()) {
      const file = record.files["hooks.json"];
      if (!file) continue;
      for (const hook of SkillHooksSchema.parse(JSON.parse(file)).hooks) {
        if (hook.event !== event) continue;
        this.firing = true;
        void this.replayRecipe(hook.recipe, event, runId)
          .catch((error) => this.store.event(runId, "skill.hook_failed", { skill: record.manifest.name, recipe: hook.recipe, event, error: errorText(error).slice(0, 200) }))
          .finally(() => { this.firing = false; });
      }
    }
  }
}
