import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import { agentManifestEntry, AgentManifestSchema, exportAgent, openAgent, type OpenedAgent } from "../agent-export.js";
import type { WorkspaceFiles } from "../files.js";
import { bringInShareable, shareablePackage, shareableSections, type Shareable } from "../interop/agent-market.js";
import type { NetworkPolicy } from "../network-policy.js";
import { parseSkillDocument } from "../skill-document.js";
import { zipWrite } from "../skill-package.js";
import type { Store } from "../store.js";
import { reachRecord, requireReach } from "./settings.js";

/**
 * R17-083 (first half): sharing the assistant as a git repository that updates in place.
 *
 * Publishing writes the shareable parts of "Export the assistant" (specialists, saved procedures and
 * skills — never rules, model choices, memory or secrets) as plain files into a workspace folder. The
 * owner commits and pushes that folder themselves; nothing is pushed from here.
 *
 * Bringing one in follows the market's rules exactly (`bringInShareable` in
 * src/interop/agent-market.ts): every file is checked against the manifest's fingerprints, only the
 * shareable parts are taken, nothing of the owner's is rewritten, and new skills arrive switched off.
 * The repository is fetched over https only, after the owner's network rules allow its host, with a
 * shallow clone that runs no hooks, follows no redirects, asks for no password and reads nothing
 * outside the named folder; symbolic links and oversized files are refused.
 *
 * Updating in place: each source remembers its commit and a fingerprint of every specialist and
 * procedure it brought. A newer commit replaces only the ones the owner has not changed since; one
 * the owner edited is kept as theirs. A skill whose name the owner already has is left alone.
 *
 * The idea is Hermes Agent's profile distribution (MIT); this is an independent implementation.
 */
export interface GitOutcome { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[], signal: AbortSignal) => Promise<GitOutcome>;

const Ref = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use a branch or tag name").refine((v) => !v.includes(".."), "Use a branch or tag name");
const Folder = z.string().trim().max(200).regex(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*$/, "Use a folder inside the repository").refine((v) => !v.split("/").includes(".."), "Use a folder inside the repository");
export const GitSourceInput = z.object({
  url: z.string().trim().url().max(2000).refine((v) => new URL(v).protocol === "https:", "A shared assistant is fetched over https only").refine((v) => !new URL(v).username && !new URL(v).password, "Leave any name or password out of the address"),
  ref: Ref.default("main"),
  folder: Folder.default(""),
  sections: z.array(z.enum(shareableSections)).min(1).max(3).default([...shareableSections]),
}).strict();
const Tracked = z.object({ table: z.enum(["specialists", "procedures"]), id: z.string().max(200), hash: z.string().length(64) }).strict();
const SourceSchema = GitSourceInput.extend({
  id: z.string().uuid(), commit: z.string().regex(/^[a-f0-9]{40,64}$/), importedAt: z.string().max(40), items: z.array(Tracked).max(1000),
});
export type GitSource = z.infer<typeof SourceSchema>;
const SourcesSchema = z.object({ sources: z.array(SourceSchema).max(20).default([]) }).strict();
const sourcesKey = "reach-agent-git-sources";
const maxFileBytes = 4 * 1024 * 1024;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const dataHash = (store: Store, owner: string, table: "specialists" | "procedures", id: string): string | null => {
  const record = store.get(table, owner, id);
  return record ? sha(JSON.stringify(record.data)) : null;
};

/** The exact git commands, so tests can check them and nothing else is ever run. */
export const gitCommands = {
  head: (url: string, ref: string): string[] => ["ls-remote", "--", url, ref],
  clone: (url: string, ref: string, dir: string): string[] => [
    "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false", "-c", "credential.helper=",
    "clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--branch", ref, "--", url, dir,
  ],
  commit: (dir: string): string[] => ["-C", dir, "rev-parse", "HEAD"],
};

export interface AgentGitDeps { store: Store; owner: string; files: WorkspaceFiles; policy: NetworkPolicy; git: GitRunner; appVersion: string; scratch?: () => Promise<string> }

export class AgentGit {
  constructor(private readonly deps: AgentGitDeps) {}

  sources(): GitSource[] { return reachRecord(this.deps.store, this.deps.owner, sourcesKey, SourcesSchema).sources; }
  private saveSources(sources: GitSource[]): void { this.deps.store.save("settings", this.deps.owner, sourcesKey, { sources }); }

  /** Writes the shareable parts into a workspace folder, ready to be committed. */
  async publish(input: unknown): Promise<{ folder: string; files: string[] }> {
    requireReach(this.deps.store, this.deps.owner, "agent-git");
    const { folder, sections } = z.object({ folder: z.string().trim().min(1).max(200), sections: GitSourceInput.shape.sections }).strict().parse(input);
    const whole = exportAgent(this.deps.store, this.deps.owner, this.deps.appVersion, { memory: false });
    const opened = openAgent(shareablePackage(whole.bytes, sections));
    const written: string[] = [];
    for (const [name, text] of opened.files) {
      const target = await this.deps.files.checkedForWrite(`${folder}/${name}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, { mode: 0o644 });
      written.push(`${folder}/${name}`);
    }
    return { folder, files: written };
  }

  private async run(args: string[], signal: AbortSignal): Promise<string> {
    const outcome = await this.deps.git(args, signal);
    if (outcome.code !== 0) throw new Error(`git could not fetch the shared assistant: ${outcome.stderr.trim().slice(0, 200) || "no reason given"}`);
    return outcome.stdout;
  }

  /** The newest commit on the source's branch or tag, without fetching anything else. */
  private async head(url: string, ref: string, signal: AbortSignal): Promise<string> {
    await this.deps.policy.assertAllowed(new URL(url), "shared assistant address");
    const line = (await this.run(gitCommands.head(url, ref), signal)).split("\n").find((l) => /^[a-f0-9]{40,64}\s/.test(l));
    if (!line) throw new Error(`The repository has no branch or tag called ${ref}.`);
    return line.slice(0, line.search(/\s/));
  }

  /** A shallow copy in a private temporary folder, read back as an opened assistant file, then removed. */
  private async fetch(source: z.infer<typeof GitSourceInput>, signal: AbortSignal): Promise<{ opened: OpenedAgent; commit: string }> {
    await this.deps.policy.assertAllowed(new URL(source.url), "shared assistant address");
    const scratch = await (this.deps.scratch?.() ?? mkdtemp(join(tmpdir(), "branch-agent-git-")));
    try {
      const dir = join(scratch, "repo");
      await this.run(gitCommands.clone(source.url, source.ref, dir), signal);
      const commit = (await this.run(gitCommands.commit(dir), signal)).trim();
      return { opened: await readShared(dir, source.folder), commit };
    } finally {
      if (!this.deps.scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async install(input: unknown, signal: AbortSignal = AbortSignal.timeout(120000)) {
    requireReach(this.deps.store, this.deps.owner, "agent-git");
    const source = GitSourceInput.parse(input);
    const { opened, commit } = await this.fetch(source, signal);
    const { reports, items } = this.bring(opened, source.sections, source.url);
    const record: GitSource = { ...source, id: randomUUID(), commit, importedAt: new Date().toISOString(), items };
    this.saveSources([...this.sources().filter((s) => s.url !== source.url || s.folder !== source.folder), record].slice(-20));
    return { source: record, reports };
  }

  async update(id: string, signal: AbortSignal = AbortSignal.timeout(120000)) {
    requireReach(this.deps.store, this.deps.owner, "agent-git");
    const source = this.sources().find((s) => s.id === id);
    if (!source) throw new Error("There is no shared assistant with that id.");
    if (await this.head(source.url, source.ref, signal) === source.commit) return { source, reports: [], upToDate: true };
    const { opened, commit } = await this.fetch(source, signal);
    const { store, owner } = this.deps;
    // Only what arrived from here and is unchanged since is taken out, so the new version can replace it.
    for (const item of source.items) if (dataHash(store, owner, item.table, item.id) === item.hash) store.delete(item.table, owner, item.id);
    const { reports, items } = this.bring(opened, source.sections, source.url);
    const next = { ...source, commit, importedAt: new Date().toISOString(), items };
    this.saveSources(this.sources().map((s) => (s.id === id ? next : s)));
    return { source: next, reports, upToDate: false };
  }

  remove(id: string): GitSource[] {
    requireReach(this.deps.store, this.deps.owner, "agent-git");
    const left = this.sources().filter((s) => s.id !== id);
    this.saveSources(left);
    return left;
  }

  private bring(opened: OpenedAgent, sections: readonly Shareable[], url: string) {
    const { store, owner } = this.deps;
    const trimmed = withoutKnownSkills(store, owner, opened);
    const before = new Map(sectionIds(trimmed).map((t) => [`${t.table}:${t.id}`, store.get(t.table, owner, t.id) !== undefined]));
    const reports = bringInShareable(store, owner, trimmed, sections, { subject: `a shared assistant from ${new URL(url).host}`, from: "Brought in from a git repository" });
    const items = sectionIds(trimmed).filter((t) => sections.includes(t.table) && !before.get(`${t.table}:${t.id}`))
      .flatMap((t) => { const hash = dataHash(store, owner, t.table, t.id); return hash ? [{ ...t, hash }] : []; });
    return { reports, items };
  }
}

function sectionIds(opened: OpenedAgent): { table: "specialists" | "procedures"; id: string }[] {
  return opened.manifest.sections.flatMap((section) => {
    if (section.name !== "specialists" && section.name !== "procedures") return [];
    const rows = JSON.parse(opened.files.get(section.file) ?? "[]") as unknown;
    return (Array.isArray(rows) ? rows : []).flatMap((row) => typeof (row as { id?: unknown })?.id === "string" ? [{ table: section.name as "specialists" | "procedures", id: (row as { id: string }).id }] : []);
  });
}

/** The same file with every skill whose name the owner already has taken out. */
export function withoutKnownSkills(store: Store, owner: string, opened: OpenedAgent): OpenedAgent {
  const names = new Set(store.skills.list(owner).map((s) => s.name));
  const files = new Map(opened.files);
  for (const section of opened.manifest.sections.filter((s) => s.name === "skills")) {
    const rows = JSON.parse(files.get(section.file) ?? "[]") as unknown;
    const fresh = (Array.isArray(rows) ? rows : []).filter((row) => !names.has(skillName((row as { document?: unknown })?.document)));
    files.set(section.file, JSON.stringify(fresh));
  }
  return { ...opened, files };
}
const skillName = (document: unknown): string => {
  try { return parseSkillDocument(String(document ?? "")).name; } catch { return ""; }
};

/** The manifest and the files it names, from a folder that must really be inside the copy. */
async function readShared(dir: string, folder: string): Promise<OpenedAgent> {
  const root = await realpath(dir);
  const base = await realpath(folder ? join(dir, ...folder.split("/")) : dir).catch(() => "");
  if (!base || (base !== root && !base.startsWith(root + sep))) throw new Error("That folder is not inside the repository.");
  const manifestText = await safeRead(join(base, agentManifestEntry));
  const manifest = AgentManifestSchema.parse(JSON.parse(manifestText));
  const entries: [string, string][] = [[agentManifestEntry, manifestText]];
  for (const section of manifest.sections) {
    if (!/^[a-z]+\.json$/.test(section.file)) throw new Error(`${section.file} is not a file name Branch reads.`);
    entries.push([section.file, await safeRead(join(base, section.file))]);
  }
  return openAgent(zipWrite(entries));
}

/** A regular file inside the copy, never a link, never too large. */
async function safeRead(path: string): Promise<string> {
  const info = await lstat(path).catch(() => null);
  if (!info) throw new Error(`The repository has no ${path.split(/[\\/]/).pop()} where it was expected.`);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The shared assistant holds a link instead of a file, so nothing was brought in.");
  if (info.size > maxFileBytes) throw new Error("A file in the shared assistant is larger than Branch reads.");
  return readFile(path, "utf8");
}

/** The real git: the argument list only, no shell, no password prompts, a time limit. */
export function gitRunner(gitPath: string, env: NodeJS.ProcessEnv): GitRunner {
  return (args, signal) => new Promise((resolve) => {
    execFile(gitPath, args, { signal, timeout: 120000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "", SSH_ASKPASS: "" } },
    (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr || error?.message || "") }));
  });
}
