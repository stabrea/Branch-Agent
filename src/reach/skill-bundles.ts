import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { agentManifestEntry, openAgent } from "../agent-export.js";
import type { WorkspaceFiles } from "../files.js";
import { bringInShareable, readCapped } from "../interop/agent-market.js";
import type { NetworkPolicy } from "../network-policy.js";
import { parseSkillDocument } from "../skill-document.js";
import { zipWrite } from "../skill-package.js";
import type { Store } from "../store.js";
import { withoutKnownSkills } from "./agent-git.js";
import { requireReach } from "./settings.js";

/**
 * R17-083 (second half): skill bundles — several skills in one file (`.branch-skills`), each with
 * its fingerprint, to hand on or to fetch from an address.
 *
 * Bringing a bundle in uses the market's rules (`bringInShareable`): only skills, each installed
 * the ordinary way and scanned as usual, every one switched off until the owner switches it on, a
 * skill whose name the owner already has left alone, and a file whose fingerprints do not match is
 * refused whole. Looking at a bundle installs nothing.
 *
 * The idea is Hermes Agent's `hermes bundles` (MIT); this is an independent implementation.
 */
const BundleSkill = z.object({ name: z.string().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/), document: z.string().min(1).max(16000) }).strict();
export const BundleSchema = z.object({
  format: z.literal("branch-skill-bundle"),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  summary: z.string().max(500).default(""),
  skills: z.array(BundleSkill).min(1).max(50),
}).strict();
export type Bundle = z.infer<typeof BundleSchema>;
export const maxBundleBytes = 2 * 1024 * 1024;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Reads a bundle and checks every skill against its fingerprint and its own name. */
export function openBundle(text: string): Bundle {
  if (Buffer.byteLength(text) > maxBundleBytes) throw new Error("That bundle is larger than Branch reads.");
  const bundle = BundleSchema.parse(JSON.parse(text));
  for (const skill of bundle.skills) {
    if (sha(skill.document) !== skill.sha256) throw new Error(`${skill.name} does not match its fingerprint, so nothing was brought in.`);
    if (parseSkillDocument(skill.document).name !== skill.name) throw new Error(`${skill.name} is named differently inside, so nothing was brought in.`);
  }
  return bundle;
}

export const ExportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  summary: z.string().max(500).default(""),
  /** Installed skill ids; only switched-on skills can be bundled. */
  skills: z.array(z.string().min(1).max(80)).min(1).max(50),
  /** A workspace path ending in .branch-skills. */
  path: z.string().trim().min(1).max(300).regex(/\.branch-skills$/, "The file name ends in .branch-skills"),
}).strict();

export interface BundleDeps { store: Store; owner: string; files: WorkspaceFiles; policy: NetworkPolicy; fetcher: typeof fetch }

export class SkillBundles {
  constructor(private readonly deps: BundleDeps) {}

  async write(input: unknown): Promise<{ path: string; skills: number }> {
    requireReach(this.deps.store, this.deps.owner, "skill-bundles");
    const { name, summary, skills, path } = ExportSchema.parse(input);
    const { store, owner } = this.deps;
    const chosen = store.skills.catalog(owner).filter((entry) => skills.includes(entry.id));
    if (chosen.length !== new Set(skills).size) throw new Error("Only skills that are installed and switched on can go in a bundle.");
    const bundle: Bundle = { format: "branch-skill-bundle", version: 1, name, summary, skills: chosen.map((entry) => {
      const document = store.secrets.scrubber.text(String((store.skills.read(owner, entry.id, { version: entry.version }) as { document?: unknown }).document ?? ""));
      return { name: entry.name, sha256: sha(document), document };
    }) };
    const target = await this.deps.files.checkedForWrite(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(bundle, null, 1) + "\n", { mode: 0o644 });
    return { path, skills: bundle.skills.length };
  }

  /** A bundle from the workspace or from an https address, for looking at or bringing in. */
  async read(source: { path?: string | undefined; url?: string | undefined }): Promise<Bundle> {
    requireReach(this.deps.store, this.deps.owner, "skill-bundles");
    if (source.path) return openBundle(await readFile(await this.deps.files.checked(source.path), "utf8"));
    if (!source.url) throw new Error("Say where the bundle is: a workspace file or an https address.");
    const target = new URL(source.url);
    if (target.protocol !== "https:") throw new Error("A bundle is fetched over https only.");
    await this.deps.policy.assertAllowed(target, "skill bundle address");
    const response = await this.deps.fetcher(target, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`The address did not answer (HTTP ${response.status}).`);
    return openBundle((await readCapped(response, maxBundleBytes)).toString("utf8"));
  }

  async preview(source: { path?: string | undefined; url?: string | undefined }) {
    const bundle = await this.read(source);
    const have = new Set(this.deps.store.skills.list(this.deps.owner).map((s) => s.name));
    return { name: bundle.name, summary: bundle.summary, skills: bundle.skills.map((s) => ({ name: s.name, alreadyHave: have.has(s.name) })) };
  }

  /** Brings in the named skills (all when none are named), switched off. */
  async install(source: { path?: string | undefined; url?: string | undefined }, names: readonly string[] = []) {
    const bundle = await this.read(source);
    const picked = bundle.skills.filter((s) => !names.length || names.includes(s.name));
    if (!picked.length) throw new Error("None of those skills is in the bundle.");
    const text = JSON.stringify(picked.map(({ document }) => ({ name: parseSkillDocument(document).name, document })));
    const manifest = { format: "branch-agent", version: 1, exportedAt: new Date().toISOString(), appVersion: "bundle", memoryRedacted: false,
      sections: [{ name: "skills", items: picked.length, file: "skills.json", sha256: sha(text), summary: `${picked.length} skills` }] };
    const opened = withoutKnownSkills(this.deps.store, this.deps.owner, openAgent(zipWrite([[agentManifestEntry, JSON.stringify(manifest)], ["skills.json", text]])));
    return bringInShareable(this.deps.store, this.deps.owner, opened, ["skills"], { subject: `the skill bundle ${bundle.name}`, from: "Brought in from a skill bundle" });
  }
}
