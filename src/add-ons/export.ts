import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket 15 (A1333, A1567, A0602): Branch as a plugin for Claude Code and for Codex.
 *
 * The plugin is small and does one thing: it tells the other tool how to start Branch's own tool
 * server (`branch mcp-serve`) and gives it one skill saying when to hand work over. Everything the
 * other tool can then do is what the owner already shared in Settings, Connections, and every call
 * still goes through Branch's own approval rules.
 *
 * Its whole life is here, and only in a folder the owner names: written (with a fingerprint for each
 * file), checked (is it still what Branch wrote, and is it this version), and removed (only the
 * files Branch wrote and nobody changed). Branch never writes into another tool's own settings and
 * never installs the plugin there by itself; the owner adds the folder in that tool.
 *
 * The same files ship in the repository under `integrations/agent-plugin/` (a test keeps them equal),
 * so the folder can also be added straight from a copy of Branch's source. The layouts follow Claude
 * Code's and Codex's published plugin formats; nothing is copied from either project.
 */
export const pluginTargets = ["claude-code", "codex"] as const;
export type PluginTarget = (typeof pluginTargets)[number];
export const exportManifest = ".branch-export.json";
export interface StdioLaunch { command: string; args: string[]; env: Record<string, string> }

/** The only files Branch ever writes into a plugin folder; a record naming anything else is not Branch's. */
const knownFiles = new Set([".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json",
  ".mcp.json", "skills/branch-agent/SKILL.md"]);
const ExportRecord = z.object({
  target: z.enum(pluginTargets), version: z.string().max(40), writtenAt: z.string().max(40),
  files: z.record(z.string().refine((name) => knownFiles.has(name)), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
type ExportRecord = z.infer<typeof ExportRecord>;
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const description = "Hand work to Branch Agent, your own assistant on this computer, through the tools you shared with it.";

export async function branchVersion(): Promise<string> {
  const text = await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8").catch(() => "{}");
  return String((JSON.parse(text) as { version?: unknown }).version ?? "0");
}

/** How the other tool starts Branch's tool server: the `branch` command, or the packaged app itself. */
export function stdioLaunch(dataDir: string | null, workspace: string | null): StdioLaunch {
  const env: Record<string, string> = {
    ...(dataDir ? { BRANCH_DATA_DIR: dataDir } : {}), ...(workspace ? { BRANCH_WORKSPACE: workspace } : {}) };
  const packaged = Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp;
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  return packaged
    ? { command: process.execPath, args: [cli, "mcp-serve"], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }
    : { command: "branch", args: ["mcp-serve"], env };
}

export const branchSkill = `---
name: branch-agent
description: Use when the person asks to hand a task to Branch Agent, or wants something done with the tools, memory or files they keep in Branch.
---
Branch Agent is the person's own assistant, running on this computer. Its tools reach you through the
"branch" tool server this plugin starts.

- Use Branch's tools when the person asks for Branch, or for something only Branch holds (their saved
  memory, their knowledge bases, the tools they shared from Branch).
- Branch decides what each call may do. If a call needs a yes, the person answers in Branch's own
  window; do not try the call another way.
- Say which Branch tool you used and what it returned. Never ask the person for a Branch key.
`;

/** Every file of the plugin for one tool, by its path inside the plugin folder. */
export function branchPluginFiles(target: PluginTarget, version: string, launch: StdioLaunch): Record<string, string> {
  const manifestDir = target === "claude-code" ? ".claude-plugin" : ".codex-plugin";
  const manifest = { name: "branch-agent", version, description, author: { name: "Branch Agent" }, license: "MIT" };
  const files: Record<string, string> = {
    [`${manifestDir}/plugin.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    ".mcp.json": `${JSON.stringify({ mcpServers: { branch: { command: launch.command, args: launch.args, ...(Object.keys(launch.env).length ? { env: launch.env } : {}) } } }, null, 2)}\n`,
    "skills/branch-agent/SKILL.md": branchSkill,
  };
  if (target === "claude-code")
    files[".claude-plugin/marketplace.json"] = `${JSON.stringify({ name: "branch-agent", owner: { name: "Branch Agent" },
      plugins: [{ name: "branch-agent", source: "./", description, version }] }, null, 2)}\n`;
  return files;
}

async function readRecord(folder: string): Promise<ExportRecord | null> {
  const text = await readFile(join(folder, exportManifest), "utf8").catch(() => null);
  if (text === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const parsed = ExportRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
function checkFolder(folder: string): void {
  if (!isAbsolute(folder)) throw new Error("Name the folder in full, starting from the drive.");
  if (folder.split(sep).includes("..")) throw new Error("Name the folder without \"..\" in it.");
}

export class PluginExports {
  constructor(private readonly store: Pick<Store, "get" | "save" | "list" | "delete">, private readonly owner: string,
    private readonly launch: () => StdioLaunch) {}
  private key(folder: string): string { return `add-on-export:${hash(folder).slice(0, 16)}`; }
  saved(): { folder: string; target: PluginTarget }[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("add-on-export:"))
      .map((row) => row.data as { folder: string; target: PluginTarget });
  }

  /** Writes the plugin into an empty folder, or over one Branch wrote before and nobody changed. */
  async write(target: PluginTarget, folder: string): Promise<{ folder: string; files: string[] }> {
    checkFolder(folder);
    const before = await this.status(folder);
    const entries = await readdir(folder).catch(() => [] as string[]);
    if (entries.length && !before.written) throw new Error("That folder is not empty, and Branch did not write it. Choose an empty folder.");
    if (before.changed.length) throw new Error(`These files were changed after Branch wrote them, so nothing was replaced: ${before.changed.join(", ")}.`);
    const version = await branchVersion();
    const files = branchPluginFiles(target, version, this.launch());
    if (before.written) await this.remove(folder);
    for (const [name, body] of Object.entries(files)) {
      const path = join(folder, ...name.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, "utf8");
    }
    const record: ExportRecord = { target, version, writtenAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, hash(body)])) };
    await writeFile(join(folder, exportManifest), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    this.store.save("settings", this.owner, this.key(folder), { folder, target });
    return { folder, files: Object.keys(files) };
  }

  /** Whether Branch wrote this folder, for which tool and version, and which files changed since. */
  async status(folder: string): Promise<{ written: boolean; target: PluginTarget | null; version: string | null; current: boolean; changed: string[]; missing: string[] }> {
    checkFolder(folder);
    const record = await readRecord(folder);
    if (!record) return { written: false, target: null, version: null, current: false, changed: [], missing: [] };
    const changed: string[] = [], missing: string[] = [];
    for (const [name, fingerprint] of Object.entries(record.files)) {
      const body = await readFile(join(folder, ...name.split("/")), "utf8").catch(() => null);
      if (body === null) missing.push(name);
      else if (hash(body) !== fingerprint) changed.push(name);
    }
    const expected = branchPluginFiles(record.target, await branchVersion(), this.launch());
    const current = Object.entries(expected).every(([name, body]) => record.files[name] === hash(body));
    return { written: true, target: record.target, version: record.version, current, changed, missing };
  }

  /** Takes out the files Branch wrote and nobody changed; anything else stays. */
  async remove(folder: string): Promise<{ removed: string[]; kept: string[] }> {
    checkFolder(folder);
    const record = await readRecord(folder);
    if (!record) throw new Error("Branch did not write that folder, so nothing was removed.");
    const removed: string[] = [], kept: string[] = [];
    for (const [name, fingerprint] of Object.entries(record.files)) {
      const path = join(folder, ...name.split("/"));
      const body = await readFile(path, "utf8").catch(() => null);
      if (body === null) continue;
      if (hash(body) !== fingerprint) { kept.push(name); continue; }
      await rm(path, { force: true });
      removed.push(name);
      // Empty folders Branch made go too; a folder with anything else in it stays.
      for (let dir = dirname(path); dir !== folder && dir.startsWith(folder + sep); dir = dirname(dir))
        if (!(await rmdir(dir).then(() => true, () => false))) break;
    }
    if (!kept.length) await rm(join(folder, exportManifest), { force: true });
    this.store.delete("settings", this.owner, this.key(folder));
    return { removed, kept };
  }
}
