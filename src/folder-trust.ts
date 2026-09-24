import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { presetRules, type Policy } from "./policy.js";
import { FeatureSwitchSchema, type FeatureSwitch } from "./loop-guard.js";
import type { Store } from "./store.js";

/**
 * Trusting a folder before anything in it is acted on.
 *
 * A folder can carry things that change what the assistant does: notes for AI assistants
 * (`AGENTS.md` and the like), lists of AI-tool servers, skills and hooks. A folder somebody else
 * made — a download, a cloned project — should not get to steer the assistant just by being
 * opened. So before a folder's own settings are used, the owner is shown what the folder carries
 * and says "trust" or "don't trust".
 *
 *  - trusted: what it carries may be read (a loader asks `isFolderTrusted` first);
 *  - not trusted: nothing of its own is read, and a task working in it asks before every change,
 *    whatever the approval setting says (a rule can only tighten, never loosen);
 *  - not decided yet: nothing of its own is read, the approval setting is left as it is, and
 *    the owner is asked.
 *
 * The owner chooses how it works (`folderTrustMode`), and it ships switched off:
 *  - off: every folder counts as trusted and approvals are unchanged, exactly as before;
 *  - on: every folder has to be decided;
 *  - when needed: only a folder that holds something for AI assistants (`assistantFolderItems`)
 *    has to be decided; one that holds nothing counts as trusted.
 *
 * A decision covers the folder and everything inside it; the closest decided folder wins. The
 * shape follows Gemini CLI's `trust.ts` and `FolderTrustDiscoveryService.ts` (Apache-2.0).
 *
 * Inheritance stops at a nested repository: a folder containing `.git` (as a dir or file)
 * strictly below the closest decided folder. A folder inside a nested repo with no explicit
 * decision of its own is treated as undecided, so integrations files hold back their security
 * sections until the owner trusts the repo itself.
 */
export type FolderTrust = "trusted" | "untrusted" | "unknown";

const DecisionSchema = z.enum(["trust", "distrust"]);
const SavedSchema = z.object({
  folders: z.array(z.object({
    path: z.string().min(1).max(1000),
    decision: DecisionSchema,
    decidedAt: z.string().max(40),
  }).strict()).max(200).default([]),
}).strict();
type Saved = z.infer<typeof SavedSchema>;
const settingsKey = "folder_trust";
const modeKey = "folder_trust_mode";
export const FolderTrustSettingsSchema = z.object({
  /** off (the default), on, or when-needed. */
  mode: FeatureSwitchSchema.default("off"),
}).strict();
/** How the owner has set folder trust. Read fresh every time. */
export function folderTrustMode(store: Store, owner: string): FeatureSwitch {
  const parsed = FolderTrustSettingsSchema.safeParse(store.get("settings", owner, modeKey)?.data ?? {});
  return parsed.success ? parsed.data.mode : "off";
}
export function saveFolderTrustSettings(store: Store, owner: string, input: unknown): FeatureSwitch {
  const { mode } = FolderTrustSettingsSchema.parse(input ?? {});
  store.save("settings", owner, modeKey, { mode });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `Folder trust: ${mode}`,
    reason: "Whether folders have to be trusted before what they carry is used", outcome: "saved" });
  return mode;
}

/** What the owner sends: a folder written relative to the workspace ("" or "." for the workspace itself). */
export const FolderTrustInputSchema = z.object({
  folder: z.string().max(200).default(""),
  decision: DecisionSchema,
}).strict();

function saved(store: Store, owner: string): Saved {
  const parsed = SavedSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return parsed.success ? parsed.data : { folders: [] };
}

/** True when `inner` is `outer` or inside it. Windows paths compare without regard to case. */
export function folderContains(outer: string, inner: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const path = platform === "win32" ? win32 : posix;
  const rel = path.relative(fold(path.resolve(outer)), fold(path.resolve(inner)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The folder with links followed, so a folder reached through a link is judged as the folder it
 * points to. A path that does not exist (yet) keeps its written form, with its closest existing
 * parent resolved. Paths for another system (tests pass `platform`) are left as written.
 */
export function realFolder(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== process.platform) return path;
  const full = resolve(path);
  try { return realpathSync.native(full); } catch { /* not there yet */ }
  const parent = dirname(full);
  return parent === full ? full : join(realFolder(parent, platform), basename(full));
}

const copiesKey = "folder-trust-copies";
const CopiesSchema = z.object({ copies: z.array(z.object({ source: z.string(), copy: z.string() }).strict()).max(500).default([]) }).strict();
const copies = (store: Pick<Store, "get">, owner: string) => {
  const parsed = CopiesSchema.safeParse(store.get("settings", owner, copiesKey)?.data ?? {});
  return parsed.success ? parsed.data.copies : [];
};
/**
 * Q100: Branch's own record of the parallel copies it made (git.worktree_add, plans.try, a forked
 * conversation, a helper's copy), kept as real paths. Only this record lets a copy take its source's
 * decision: a `.git` file inside the copy is the folder's own text and grants nothing.
 */
export function recordWorktreeCopy(store: Store, owner: string, source: string, copy: string, made: boolean): void {
  const entry = { source: realFolder(source), copy: realFolder(copy) };
  const kept = copies(store, owner).filter((one) => one.copy !== entry.copy);
  store.save("settings", owner, copiesKey, { copies: made ? [...kept, entry].slice(-500) : kept });
}
/** A folder Branch made as a parallel copy of `source`'s repository: in its `.branch-worktrees`, on record, with a `.git` file. */
function branchCopy(store: Pick<Store, "get">, owner: string, folder: string, pathApi: typeof posix): boolean {
  const home = pathApi.dirname(folder);
  if (pathApi.basename(home) !== ".branch-worktrees") return false;
  try { if (!lstatSync(join(folder, ".git")).isFile()) return false; } catch { return false; }
  const source = pathApi.dirname(home);
  // The source must be a repository itself (then the walk judges it, not a folder inside one) whose own list
  // of worktrees still names this copy: a record the copy outlived grants nothing.
  if (!listedBy(source, folder)) return false;
  // The copy's own record must name this source: another checkout of the same repository lists it too.
  return copies(store, owner).some((one) => one.copy === folder && one.source === source);
}
/** Where a repository keeps its worktrees' entries: its own `.git/worktrees`, or, for a copy, the one it shares. */
function worktreeEntries(source: string): string | null {
  const dotGit = join(source, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return join(dotGit, "worktrees");
    const own = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!own) return null;
    const entry = resolve(source, own);
    return join(resolve(entry, readFileSync(join(entry, "commondir"), "utf8").trim()), "worktrees");
  } catch { return null; }
}
/** Whether `source`'s repository still lists `copy` among its worktrees (the entry's `gitdir` points at the copy). */
function listedBy(source: string, copy: string): boolean {
  const entries = worktreeEntries(source);
  if (!entries) return false;
  const wanted = realFolder(join(copy, ".git"));
  let names: string[];
  try { names = readdirSync(entries); } catch { return false; }
  return names.some((name) => {
    try { return realFolder(resolve(join(entries, name), readFileSync(join(entries, name, "gitdir"), "utf8").trim())) === wanted; }
    catch { return false; }
  });
}

/**
 * Q108: each decided folder's real path when the owner decided, by the path as saved (older answers have none).
 * Q115: kept apart from the answers themselves, so an older build, which reads those strictly, still reads them
 * all after a rollback.
 */
const realsKey = "folder-trust-real";
const RealsSchema = z.object({ reals: z.record(z.string().max(1000), z.string().min(1).max(4096)).default({}) }).strict();
const decidedReals = (store: Pick<Store, "get">, owner: string): Record<string, string> => {
  const parsed = RealsSchema.safeParse(store.get("settings", owner, realsKey)?.data ?? {});
  return parsed.success ? parsed.data.reals : {};
};
type Decided = Saved["folders"][number] & { real?: string | undefined };

/** The owner's decision closest above `inner` (a real path), or null when none covers it. */
function closestDecision(entries: Decided[], inner: string, platform: NodeJS.Platform) {
  let best: { depth: number; decision: "trust" | "distrust"; path: string } | null = null;
  for (const entry of entries) {
    const outer = realFolder(entry.path, platform);
    const moved = !!entry.real && platform === process.platform && outer !== entry.real;
    // Q108: a trust covers the folder the owner trusted. Once its path leads somewhere else (a pulled commit made
    // it, or a folder above it, a link), it no longer counts. Q116: a "don't trust" holds both on the folder the
    // owner meant and wherever its path leads now, so re-pointing a link never moves it off that folder.
    if (entry.decision === "trust" && moved) continue;
    for (const place of moved ? [outer, entry.real!] : [outer]) {
      if (!folderContains(place, inner, platform)) continue;
      if (!best || place.length >= best.depth) best = { depth: place.length, decision: entry.decision, path: place };
    }
  }
  return best;
}
/** How far a folder is trusted, from the closest folder the owner has decided about. */
export function folderTrust(store: Store, owner: string, folder: string, platform: NodeJS.Platform = process.platform): FolderTrust {
  const reals = decidedReals(store, owner);
  const entries: Decided[] = saved(store, owner).folders.map((entry) => ({ ...entry, real: reals[entry.path] }));
  if (!entries.length) return "unknown";
  const inner = realFolder(folder, platform);
  const best = closestDecision(entries, inner, platform);
  // Q100: a copy Branch made of a folder the owner does not trust is not trusted either, wherever it ended up
  // (a copy made before its place was checked for links may lie outside the source, or outside every decision).
  // Only a decision the owner made inside the copy itself comes first.
  for (const one of copies(store, owner)) {
    if (!folderContains(one.copy, inner, platform) || (best && folderContains(one.copy, best.path, platform))) continue;
    if (closestDecision(entries, one.source, platform)?.decision === "distrust") return "untrusted";
  }
  if (!best) return "unknown";

  // Q100: inside a copy Branch made, what was not decided in the copy itself is judged where it came from:
  // the same place in the source, so every decision there (a "don't trust" on a subfolder too) holds in the copy.
  // Only when the closest decision covers the source too: a decision between the two is closer, and wins. A
  // repository inside the copy still stops trust, as it would in the source. Never through a link in the source:
  // the copy's real folder would take the decision of wherever the source's link points now, so it is judged
  // where it is instead. Each step drops `.branch-worktrees/<name>`, so the check always ends.
  if (platform === process.platform) {
    const path = platform === "win32" ? win32 : posix;
    let nested = false;
    for (let current = inner; current !== best.path && current !== path.dirname(current); current = path.dirname(current)) {
      const source = path.dirname(path.dirname(current));
      if (branchCopy(store, owner, current, path) && folderContains(best.path, source, platform)) {
        const same = path.join(source, path.relative(current, inner));
        if (realFolder(same, platform) !== same) break;
        const there = folderTrust(store, owner, same, platform);
        return nested && there === "trusted" ? "unknown" : there;
      }
      if (existsSync(join(current, ".git"))) nested = true;
    }
  }

  // Inheritance stops at a nested repository (a folder containing .git, dir or file).
  // Walk from inner up to (but not including) best.path, using resolved paths so symlinks
  // cannot skip the check. A symlink to a repo elsewhere is still subject to the check
  // at the resolved location.
  // Only trust stops there: a nested repository under a folder the owner distrusts stays distrusted.
  if (best.decision === "trust" && platform === process.platform) {
    const path = platform === "win32" ? win32 : posix;
    let current = inner;
    while (current !== best.path && current !== path.dirname(current)) {
      if (existsSync(join(current, ".git"))) return "unknown";
      current = path.dirname(current);
    }
  }

  return best.decision === "trust" ? "trusted" : "untrusted";
}

/** Writes down the owner's answer for one folder inside the workspace. */
export function decideFolder(store: Store, owner: string, workspace: string, input: unknown): { path: string; trust: FolderTrust } {
  const { folder, decision } = FolderTrustInputSchema.parse(input);
  const path = workspaceFolder(workspace, folder);
  // The same folder written another way (letter case on Windows, a link) replaces the old answer.
  const same = (other: string) => folderContains(realFolder(other), realFolder(path)) && folderContains(realFolder(path), realFolder(other));
  const kept = saved(store, owner).folders.filter((entry) => !same(entry.path));
  const folders = [...kept, { path, decision, decidedAt: new Date().toISOString() }].slice(-200);
  store.save("settings", owner, settingsKey, { folders });
  const reals = { ...decidedReals(store, owner), [path]: realFolder(path) };
  store.save("settings", owner, realsKey, { reals: Object.fromEntries(folders.flatMap((entry) => reals[entry.path] ? [[entry.path, reals[entry.path]!]] : [])) });
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `Folder ${decision === "trust" ? "trusted" : "not trusted"}: ${path}`.slice(0, 300),
    reason: decision === "trust"
      ? "What the folder carries for AI assistants may now be used"
      : "Nothing the folder carries is used, and a task working in it asks before every change",
    outcome: "saved",
  });
  return { path, trust: decision === "trust" ? "trusted" : "untrusted" };
}

/** The absolute folder for a path written relative to the workspace; never outside it. */
export function workspaceFolder(workspace: string, folder: string): string {
  const clean = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some((part) => part === "..") || isAbsolute(folder) || folder.includes(":"))
    throw new Error("Use a folder inside the workspace");
  const root = resolve(workspace), target = resolve(root, clean || ".");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Use a folder inside the workspace");
  return target;
}

/**
 * The approval setting a task in this folder works under. A folder the owner does not trust keeps
 * every "no" and every "ask" it had, loses every standing "yes", and asks before any change — even
 * when approvals are otherwise switched off.
 */
export function trustCappedPolicy(policy: Policy, trust: FolderTrust, mode: FeatureSwitch = "on"): Policy {
  if (mode === "off" || trust !== "untrusted") return policy;
  return { ...policy, rules: [...policy.rules.filter((rule) => rule.decision !== "allow"), ...presetRules("ask-before-changes")] };
}

/**
 * Everything in a folder that is meant for an AI assistant. One list, so every loader of these
 * things and the trust screen agree on what has to be trusted first. Names are compared without
 * regard to letter case. Folders and files named here are listed, never opened, by this module.
 */
export const assistantFolderItems = Object.freeze({
  /** Notes for assistants, looked for in the folder and up to three folders below it. */
  notes: Object.freeze(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "GEMINI.md", ".hermes.md",
    "SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md", "HEARTBEAT.md", "TOOLS.md", "SOP.md"]),
  /** AI tool server lists: the file, and the key the servers sit under. */
  toolServers: Object.freeze([[".mcp.json", "mcpServers"], [".cursor/mcp.json", "mcpServers"],
    [".vscode/mcp.json", "servers"], [".gemini/settings.json", "mcpServers"]] as const),
  /** Folders whose sub-folders are skills. */
  skills: Object.freeze([".agents/skills", ".claude/skills", ".gemini/skills", ".branch-skills"]),
  /** Settings files whose "hooks" entries run commands by themselves. */
  hooks: Object.freeze([".claude/settings.json", ".claude/settings.local.json", ".gemini/settings.json"]),
  /** Folders whose sub-folders are plugins or extensions. */
  plugins: Object.freeze([".claude/plugins", ".agents/plugins", ".gemini/extensions"]),
});

export interface FolderFindings {
  instructions: string[];
  aiToolServers: string[];
  skills: string[];
  hooks: string[];
  plugins: string[];
}
const findingLimit = 50;
const noteNames = new Set(assistantFolderItems.notes.map((name) => name.toUpperCase()));
const skippedFolders = new Set(["node_modules", ".git", "dist", "release", ".branch", ".branch-worktrees"]);

/**
 * What a folder carries that could steer an assistant, found without running or loading any of
 * it: note files are only listed by name, settings files are read for their entry names alone.
 * Links are never followed and every list is capped.
 */
export async function discoverFolder(folder: string): Promise<FolderFindings> {
  const found: FolderFindings = { instructions: [], aiToolServers: [], skills: [], hooks: [], plugins: [] };
  await findNotes(folder, "", 0, found.instructions);
  for (const [file, key] of assistantFolderItems.toolServers)
    found.aiToolServers.push(...(await jsonKeys(join(folder, file), key)));
  for (const file of assistantFolderItems.hooks)
    found.hooks.push(...(await jsonKeys(join(folder, file), "hooks")));
  await subFolders(folder, assistantFolderItems.skills, found.skills);
  await subFolders(folder, assistantFolderItems.plugins, found.plugins);
  found.aiToolServers = found.aiToolServers.slice(0, findingLimit);
  found.hooks = found.hooks.slice(0, findingLimit);
  return found;
}

export function nothingFound(found: FolderFindings): boolean {
  return Object.values(found).every((list: string[]) => !list.length);
}

/**
 * Whether a loader may read what a folder carries, under the owner's setting. Off: always yes, as
 * before. On: only a folder the owner trusts. When needed: a trusted folder, or one not decided
 * about that holds nothing for AI assistants. A folder the owner does not trust is always no.
 */
export async function isFolderTrusted(store: Store, owner: string, path: string): Promise<boolean> {
  if (folderTrustMode(store, owner) !== "when-needed" || folderTrust(store, owner, path) !== "unknown")
    return folderAllows(store, owner, path);
  return folderAllows(store, owner, path, !nothingFound(await discoverFolder(path)));
}

/**
 * The same answer without looking at the disk, for a loader that already knows whether the folder
 * holds something for AI assistants (it usually does: it has just found a file to read). A loader
 * that is about to read a file from the folder passes nothing and gets the strict answer.
 */
export function folderAllows(store: Store, owner: string, path: string, holdsSomething = true, platform: NodeJS.Platform = process.platform): boolean {
  const mode = folderTrustMode(store, owner);
  if (mode === "off") return true;
  const trust = folderTrust(store, owner, path, platform);
  if (trust !== "unknown") return trust === "trusted";
  return mode === "when-needed" && !holdsSomething;
}

/**
 * Whether the launch's integrations file may be used at all. Only a file that sits inside the
 * workspace is a folder's own; one elsewhere, reached without going through the workspace, is the
 * owner's. A file that is itself a link is judged
 * both where it is written and where it really is, and counts only when both may be used: a link
 * outside the workspace to a file in a folder the owner has not trusted is still that folder's file,
 * and a link inside such a folder is still that folder's, wherever it points. A path written inside
 * the workspace that a link (to a folder or a file) leads out of it is judged where it leads, with no
 * decision there, so it is refused even from a trusted folder. `platform` is for
 * tests, as in `folderTrust`.
 */
export function integrationsFileTrusted(store: Store, owner: string, workspace: string, file: string,
  platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const full = path.resolve(file), root = realFolder(workspace, platform);
  const written = realFolder(path.dirname(full), platform), really = path.dirname(realFolder(full, platform));
  // Q89: a path written inside the workspace is still the workspace's when a folder link on the way leads out of it.
  const fromInside = folderContains(path.resolve(workspace), full, platform) || folderContains(root, written, platform);
  const judged = (folder: string) => fromInside || folderContains(root, folder, platform);
  return [written, really].every((folder) => !judged(folder) || folderAllows(store, owner, folder, true, platform));
}

/** Whether the owner should be asked about a folder now, under the owner's setting. */
export function needsAnswer(mode: FeatureSwitch, trust: FolderTrust, found: FolderFindings): boolean {
  if (mode === "off" || trust !== "unknown") return false;
  return mode === "on" || !nothingFound(found);
}

async function findNotes(folder: string, prefix: string, depth: number, out: string[]): Promise<void> {
  if (depth > 3 || out.length >= findingLimit) return;
  let entries;
  try { entries = await readdir(join(folder, prefix), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= findingLimit) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Listed whatever the letter case, since a disk that ignores case would read "agents.md" too.
    if (entry.isFile() && noteNames.has(entry.name.toUpperCase())) out.push(path);
    else if (entry.isDirectory() && !skippedFolders.has(entry.name) && !entry.name.startsWith("."))
      await findNotes(folder, path, depth + 1, out);
  }
}

async function subFolders(folder: string, places: readonly string[], out: string[]): Promise<void> {
  for (const place of places)
    for (const name of await plainFolders(join(folder, place)))
      if (out.length < findingLimit) out.push(`${place}/${name}`);
}

async function plainFolders(path: string): Promise<string[]> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return [];
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, findingLimit);
  } catch { return []; }
}

/** The names under one key of a small JSON settings file, or none. */
async function jsonKeys(path: string, key: string): Promise<string[]> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 262_144) return [];
    const value = (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).slice(0, findingLimit).map((name) => name.slice(0, 100)) : [];
  } catch { return []; }
}
