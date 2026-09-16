import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";

/**
 * A skill registry is a plain JSON index the owner points at (their own, a team's, or a public one).
 * Installing from it fetches one SKILL.md, checks its published fingerprint, runs the usual skill
 * scan, and installs it disabled: nothing a registry ships can act until the owner activates it.
 * A version 2 registry also publishes a signing key; entries signed with it are shown as checked,
 * entries without a signature are shown plainly as unsigned, and a signature that does not match
 * stops the install. Installed skills remember where they came from, so later versions can be
 * offered, installed in one step, and put back if the new version is worse.
 */
const registryEntry = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(64),
  description: z.string().max(1024),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().max(40).optional(),
  /** What changed in this version, in the registry author's words. */
  changelog: z.string().max(2000).optional(),
  /** Base64 ed25519 signature over this entry, made with the registry's published key. */
  signature: z.string().max(200).optional(),
}).strict();
export type RegistryEntry = z.infer<typeof registryEntry>;
export const RegistryIndexSchema = z.object({
  format: z.literal("branch-skill-registry"),
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1).max(120),
  /** Base64 (SPKI) ed25519 public key the registry publishes once; only version 2 registries have one. */
  publicKey: z.string().max(200).optional(),
  skills: z.array(registryEntry).max(500),
}).strict();
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;
export interface SkillOrigin { registry: string; registryName: string; skillId: string; sha256: string; version: string | null; signed: string; installedAt: string; previousSkillVersion?: number | null }
const maxDocumentBytes = 48 * 1024, maxIndexBytes = 512 * 1024;

/** The exact bytes a registry signs for one entry. Fixed order, so key order in the file cannot change it. */
export function signingPayload(registryName: string, entry: Pick<RegistryEntry, "id" | "version" | "sha256">): Buffer {
  return Buffer.from(["branch-skill-registry", registryName, entry.id, entry.version ?? "", entry.sha256].join("\n"), "utf8");
}
export function signRegistryEntry(privateKey: KeyObject, registryName: string, entry: Pick<RegistryEntry, "id" | "version" | "sha256">): string {
  return signBytes(null, signingPayload(registryName, entry), privateKey).toString("base64");
}
/** "checked" when the signature matches the published key, "unsigned" when there is none, "invalid" otherwise. */
export function verifyRegistryEntry(index: RegistryIndex, entry: RegistryEntry): "checked" | "unsigned" | "invalid" {
  if (!index.publicKey || !entry.signature) return "unsigned";
  try {
    const key = createPublicKey({ key: Buffer.from(index.publicKey, "base64"), format: "der", type: "spki" });
    return verifyBytes(null, signingPayload(index.name, entry), key, Buffer.from(entry.signature, "base64")) ? "checked" : "invalid";
  } catch { return "invalid"; }
}

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
  /** The catalog a registry advertises, with each entry labelled checked or unsigned; nothing is installed by looking. */
  async browse(url: string) {
    const index = RegistryIndexSchema.parse(JSON.parse(await this.read(url, maxIndexBytes)));
    const skills = index.skills.map((entry) => ({ ...entry, signed: verifyRegistryEntry(index, entry) }));
    this.store.save("settings", this.owner, `registry-index:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      { url, name: index.name, skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, version: s.version ?? null })) });
    return { ...index, skills };
  }
  /** Fetches one listed skill, checks its fingerprint and signature, scans it and installs it disabled. */
  async install(url: string, skillId: string) {
    const index = await this.browse(url);
    const entry = index.skills.find((s) => s.id === skillId);
    if (!entry) throw new Error(`The registry "${index.name}" has no skill called ${skillId}`);
    if (entry.signed === "invalid") throw new Error("The registry's signature for this skill does not match the key it published, so it was not installed");
    const document = await this.fetchDocument(entry);
    const installed = this.store.skills.install(this.owner, { document });
    if (installed.activeVersion !== null) this.store.skills.disable(this.owner, installed.id, { expectedRevision: installed.revision });
    const view = this.store.skills.view(this.owner, installed.id);
    const origin: SkillOrigin = { registry: url, registryName: index.name, skillId, sha256: entry.sha256, version: entry.version ?? null, signed: entry.signed, installedAt: new Date().toISOString(), previousSkillVersion: null };
    this.store.save("settings", this.owner, `skill-origin:${installed.id}`, { ...origin });
    return { ...view, origin };
  }
  private async fetchDocument(entry: RegistryEntry): Promise<string> {
    const document = await this.read(entry.url, maxDocumentBytes);
    if (createHash("sha256").update(document, "utf8").digest("hex") !== entry.sha256)
      throw new Error("The skill file does not match the fingerprint the registry published, so it was not installed");
    return document;
  }
  private origins(): { id: string; origin: SkillOrigin }[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("skill-origin:"))
      .map((row) => ({ id: row.id.slice("skill-origin:".length), origin: row.data as unknown as SkillOrigin }));
  }
  /** Asks every registry the owner installed from whether a newer version of their skills exists. */
  async updates() {
    const indexes = new Map<string, Awaited<ReturnType<SkillRegistry["browse"]>>>();
    const available: { skillId: string; name: string; from: string | null; to: string | null; changelog: string; signed: string; registryName: string }[] = [];
    for (const { id, origin } of this.origins()) {
      const index = indexes.get(origin.registry) ?? await this.browse(origin.registry).catch(() => null);
      if (!index) continue;
      indexes.set(origin.registry, index);
      const entry = index.skills.find((s) => s.id === origin.skillId);
      if (!entry || !entry.version || entry.version === origin.version) continue;
      const skill = this.store.skills.list(this.owner).find((s) => s.id === id);
      if (!skill) continue;
      available.push({ skillId: id, name: skill.name, from: origin.version, to: entry.version, changelog: entry.changelog ?? "", signed: entry.signed, registryName: index.name });
    }
    return { updates: available, checkedAt: new Date().toISOString() };
  }
  /** Installs the newer version as a new retained version, keeping the one in use available to go back to. */
  async update(skillId: string) {
    const origin = this.store.get("settings", this.owner, `skill-origin:${skillId}`)?.data as unknown as SkillOrigin | undefined;
    if (!origin) throw new Error("This skill did not come from a registry");
    const index = await this.browse(origin.registry);
    const entry = index.skills.find((s) => s.id === origin.skillId);
    if (!entry) throw new Error(`The registry "${index.name}" no longer lists this skill`);
    if (entry.signed === "invalid") throw new Error("The registry's signature for this skill does not match the key it published, so nothing was changed");
    const document = await this.fetchDocument(entry);
    const before = this.store.skills.view(this.owner, skillId);
    const previousSkillVersion = before.activeVersion ?? before.headVersion;
    const updated = this.store.skills.update(this.owner, skillId, { document, expectedRevision: before.revision });
    const view = before.activeVersion === null ? updated : this.store.skills.activate(this.owner, skillId, { expectedRevision: updated.revision, version: updated.headVersion, acknowledge: true });
    this.store.save("settings", this.owner, `skill-origin:${skillId}`, { ...origin, sha256: entry.sha256, version: entry.version ?? null, signed: entry.signed, previousSkillVersion });
    return { ...view, origin: { ...origin, version: entry.version ?? null, previousSkillVersion }, changelog: entry.changelog ?? "" };
  }
  /** Puts an updated skill back to the version that was in use before the update. */
  rollback(skillId: string) {
    const origin = this.store.get("settings", this.owner, `skill-origin:${skillId}`)?.data as unknown as SkillOrigin | undefined;
    if (!origin?.previousSkillVersion) throw new Error("There is no earlier version of this skill to go back to");
    const view = this.store.skills.view(this.owner, skillId);
    const restored = this.store.skills.activate(this.owner, skillId, { expectedRevision: view.revision, version: origin.previousSkillVersion, acknowledge: true });
    this.store.save("settings", this.owner, `skill-origin:${skillId}`, { ...origin, previousSkillVersion: null });
    return restored;
  }
}
