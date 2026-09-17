import { lstat, readdir, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import { presetRules, type Policy } from "./policy.js";
import { instructionFileNames } from "./instruction-files.js";
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
 *  - trusted: its notes are read (see src/instruction-files.ts);
 *  - not trusted: nothing of its own is read, and every change waits for a yes, whatever the
 *    approval setting says (a rule can only tighten, never loosen);
 *  - not decided yet: nothing of its own is read, the approval setting is left as it is, and
 *    the owner is asked.
 *
 * A decision covers the folder and everything inside it; the closest decided folder wins. The
 * shape follows Gemini CLI's `trust.ts` and `FolderTrustDiscoveryService.ts` (Apache-2.0).
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

/** How far a folder is trusted, from the closest folder the owner has decided about. */
export function folderTrust(store: Store, owner: string, folder: string, platform: NodeJS.Platform = process.platform): FolderTrust {
  let best: { depth: number; decision: "trust" | "distrust" } | null = null;
  for (const entry of saved(store, owner).folders) {
    if (!folderContains(entry.path, folder, platform)) continue;
    const depth = entry.path.length;
    if (!best || depth >= best.depth) best = { depth, decision: entry.decision };
  }
  return best ? (best.decision === "trust" ? "trusted" : "untrusted") : "unknown";
}

/** Writes down the owner's answer for one folder inside the workspace. */
export function decideFolder(store: Store, owner: string, workspace: string, input: unknown): { path: string; trust: FolderTrust } {
  const { folder, decision } = FolderTrustInputSchema.parse(input);
  const path = workspaceFolder(workspace, folder);
  const kept = saved(store, owner).folders.filter((entry) => resolve(entry.path) !== path);
  const folders = [...kept, { path, decision, decidedAt: new Date().toISOString() }].slice(-200);
  store.save("settings", owner, settingsKey, { folders });
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `Folder ${decision === "trust" ? "trusted" : "not trusted"}: ${path}`.slice(0, 300),
    reason: decision === "trust"
      ? "The folder's own instructions may now be read"
      : "Nothing the folder carries is read, and every change waits for a yes",
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
export function trustCappedPolicy(policy: Policy, trust: FolderTrust): Policy {
  if (trust !== "untrusted") return policy;
  return { ...policy, rules: [...policy.rules.filter((rule) => rule.decision !== "allow"), ...presetRules("ask-before-changes")] };
}

export interface FolderFindings {
  instructions: string[];
  aiToolServers: string[];
  skills: string[];
  hooks: string[];
}
const findingLimit = 50;
const noteNames = new Set(instructionFileNames.map((name) => name.toUpperCase()));
const skippedFolders = new Set(["node_modules", ".git", "dist", "release", ".branch", ".branch-worktrees"]);

/**
 * What a folder carries that could steer an assistant, found without running or loading any of
 * it. Links are never followed and every list is capped. Branch itself reads only the notes today;
 * the rest is shown so the owner knows what the folder holds.
 */
export async function discoverFolder(folder: string): Promise<FolderFindings> {
  const found: FolderFindings = { instructions: [], aiToolServers: [], skills: [], hooks: [] };
  await findNotes(folder, "", 0, found.instructions);
  found.aiToolServers = await jsonKeys(join(folder, ".mcp.json"), "mcpServers");
  found.hooks = [
    ...(await jsonKeys(join(folder, ".claude", "settings.json"), "hooks")),
    ...(await jsonKeys(join(folder, ".gemini", "settings.json"), "hooks")),
  ].slice(0, findingLimit);
  for (const place of [".agents/skills", ".claude/skills", ".gemini/skills"])
    for (const name of await plainFolders(join(folder, place)))
      if (found.skills.length < findingLimit) found.skills.push(`${place}/${name}`);
  return found;
}

export function nothingFound(found: FolderFindings): boolean {
  return !found.instructions.length && !found.aiToolServers.length && !found.skills.length && !found.hooks.length;
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

/* ------------------------------------------------------------------ the owner's screen */

/** What the runtime and store look like to the trust screen; `createBranch`'s result fits. */
export interface FolderTrustApp {
  store: Store;
  runtime: { owner: string; workspace: string };
}
export interface FolderTrustView {
  path: string;
  /** The folder as the owner sends it back: "" for the workspace, or a folder inside it. */
  folder: string;
  label: string;
  /** The project whose folder this is, or null for the workspace itself. */
  project: string | null;
  trust: FolderTrust;
  found: FolderFindings;
  /** True when the owner should be asked: not decided yet, and the folder carries something. */
  needsAnswer: boolean;
}

export function handlesFolderTrustPath(path: string): boolean {
  return path === "/api/folder-trust";
}

/** The workspace and every project folder, each with what it carries and whether it is trusted. */
export async function folderTrustView(app: FolderTrustApp): Promise<{ folders: FolderTrustView[] }> {
  const { owner, workspace } = app.runtime;
  const projects = app.store.projects.list(owner);
  const places = new Map<string, string | null>([["", null]]);
  for (const project of projects)
    if (project.folder && !places.has(project.folder)) places.set(project.folder, project.name);
  const folders: FolderTrustView[] = [];
  for (const [folder, project] of places) {
    const path = workspaceFolder(workspace, folder);
    const trust = folderTrust(app.store, owner, path);
    const found = await discoverFolder(path);
    const label = project === null ? "Your workspace" : `The "${project}" project's folder`;
    folders.push({ path, folder, label, project, trust, found, needsAnswer: trust === "unknown" && !nothingFound(found) });
  }
  return { folders };
}

export async function folderTrustApi(
  app: FolderTrustApp, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  if (!handlesFolderTrustPath(path)) throw new Error("Not found");
  if (request.method === "POST") decideFolder(app.store, app.runtime.owner, app.runtime.workspace, await readBody(request));
  else if (request.method !== "GET") throw new Error("Use GET or POST");
  return folderTrustView(app);
}
