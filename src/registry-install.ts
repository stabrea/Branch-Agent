import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";

/**
 * A skill registry is a plain JSON index the owner points at (their own, a team's, or a public one).
 * Installing from it fetches one SKILL.md, checks its published fingerprint, runs the usual skill
 * scan, and installs it disabled: nothing a registry ships can act until the owner activates it.
 */
export const RegistryIndexSchema = z.object({
  format: z.literal("branch-skill-registry"),
  version: z.literal(1),
  name: z.string().min(1).max(120),
  skills: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(64),
    description: z.string().max(1024),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().max(40).optional(),
  }).strict()).max(500),
}).strict();
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;
const maxDocumentBytes = 48 * 1024, maxIndexBytes = 512 * 1024;

export class SkillRegistry {
  constructor(private readonly store: Store, private readonly owner: string, private readonly policy: NetworkPolicy, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  private async read(url: string, limit: number): Promise<string> {
    const target = new URL(url);
    await this.policy.assertAllowed(target, "registry address");
    const response = await this.fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { accept: "application/json, text/plain, text/markdown" } });
    if (!response.ok) throw new Error(`The registry did not answer (HTTP ${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("The registry response is larger than allowed");
    return text;
  }
  /** The catalog a registry advertises; nothing is installed by looking. */
  async browse(url: string): Promise<RegistryIndex> {
    return RegistryIndexSchema.parse(JSON.parse(await this.read(url, maxIndexBytes)));
  }
  /** Fetches one listed skill, checks its fingerprint, scans it and installs it disabled. */
  async install(url: string, skillId: string) {
    const index = await this.browse(url);
    const entry = index.skills.find((s) => s.id === skillId);
    if (!entry) throw new Error(`The registry "${index.name}" has no skill called ${skillId}`);
    const document = await this.read(entry.url, maxDocumentBytes);
    const digest = createHash("sha256").update(document, "utf8").digest("hex");
    if (digest !== entry.sha256) throw new Error("The skill file does not match the fingerprint the registry published, so it was not installed");
    const installed = this.store.skills.install(this.owner, { document });
    if (installed.activeVersion !== null) this.store.skills.disable(this.owner, installed.id, { expectedRevision: installed.revision });
    const view = this.store.skills.view(this.owner, installed.id);
    this.store.save("settings", this.owner, `skill-origin:${installed.id}`, { registry: url, registryName: index.name, skillId, sha256: digest, installedAt: new Date().toISOString() });
    return { ...view, origin: { registry: url, registryName: index.name, skillId, sha256: digest } };
  }
}
