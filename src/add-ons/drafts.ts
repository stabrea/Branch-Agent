import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import { PluginHostSchema, addOnManifestName, sha256 } from "./formats.js";
import { addOnApiVersion } from "./sdk.js";

/**
 * Bucket 15 (A2322): add-ons the assistant drafts ("mods").
 *
 * The assistant may write a plugin for the owner — a new tool, a hook — but only as a draft: a
 * package in the drafts folder, with its code and the permissions and web addresses it says it
 * needs. A draft does nothing. The owner reads it on the Plugins page and installs it through the
 * same shelf as anybody else's package, where it runs walled and arrives switched off. The assistant
 * can never install, switch on, or change the permissions of what it wrote.
 */
export const DraftSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  code: z.string().min(1).max(64_000),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(20).default([]),
  hosts: z.array(PluginHostSchema).max(16).default([]),
}).strict();
export type Draft = z.infer<typeof DraftSchema>;

export class AddOnDrafts {
  constructor(private readonly folder: string) {}
  path(id: string): string { return join(this.folder, z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse(id)); }

  async write(input: unknown): Promise<{ id: string; folder: string; note: string }> {
    const draft = DraftSchema.parse(input);
    const folder = this.path(draft.id);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    const code = `${draft.code.trim()}\n`;
    const manifest = { format: "branch-addon", apiVersion: addOnApiVersion, id: draft.id, name: draft.name, version: "draft",
      description: draft.description, author: "Drafted by your assistant", plugin: `${draft.id}.mjs`,
      permissions: draft.permissions, hosts: draft.hosts, files: { [`${draft.id}.mjs`]: sha256(code) } };
    await writeFile(join(folder, `${draft.id}.mjs`), code, "utf8");
    await writeFile(join(folder, addOnManifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { id: draft.id, folder, note: "Saved as a draft. Nothing is installed or switched on: the owner reviews it under Customize, Plugins." };
  }

  async list(): Promise<{ id: string; name: string; description: string; permissions: string[]; hosts: string[]; code: string }[]> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const out = [];
    for (const id of names.sort()) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || !(await lstat(join(this.folder, id))).isDirectory()) continue;
      const manifest = JSON.parse(await readFile(join(this.folder, id, addOnManifestName), "utf8").catch(() => "{}")) as Record<string, unknown>;
      const code = await readFile(join(this.folder, id, `${id}.mjs`), "utf8").catch(() => "");
      out.push({ id, name: String(manifest.name ?? id), description: String(manifest.description ?? ""),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
        hosts: Array.isArray(manifest.hosts) ? manifest.hosts.map(String) : [], code });
    }
    return out;
  }

  async discard(id: string): Promise<{ removed: boolean }> {
    const folder = this.path(id);
    const there = await lstat(folder).then(() => true, () => false);
    await rm(folder, { recursive: true, force: true });
    return { removed: there };
  }
}

export const draftToolName = "addon.draft";

export function registerDraftTool(registry: ToolRegistry, drafts: AddOnDrafts): void {
  registry.register({
    name: draftToolName,
    description: "Save a plugin you wrote for the owner as a draft add-on (an ES module whose default export is { id, name, permissions, tools: [{ name: 'plugin.<id>.<name>', description, permission, input, run(args) }] }). It is never installed or switched on by this; the owner reviews it.",
    permission: "addons.draft",
    parameters: DraftSchema,
    execute: async (args) => drafts.write(args),
  });
}
