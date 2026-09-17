import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { parseSkillDocument } from "../skill-document.js";
import { zipRead } from "../skill-package.js";
import { tomlStrings } from "./toml-lite.js";
import { FilterRuleSchema, type FilterRule } from "./filters.js";
import { checkApiVersion } from "./sdk.js";

/**
 * Bucket 15: an add-on package, read without running a line of it.
 *
 * Four layouts are understood, all as plain files:
 *   branch      `branch-addon.json` beside its files (a folder, or one flat zip)
 *   claude      a Claude Code plugin: `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `.mcp.json`
 *   codex       a Codex plugin: `.codex-plugin/plugin.json` (or an Agent Plugins `plugin.json`) with the same layout
 *   gemini      a Gemini CLI extension: `gemini-extension.json`, `commands/*.toml`, `skills/`, its context file
 *
 * Whatever the layout, what comes out is the same short list: instructions (skills), outside
 * servers it would connect, plugin code, and filters — each one shown to the owner before anything
 * is copied. What a layout can carry that Branch will not take (shell hooks, tool allowances,
 * themes) is named in `leftOut`, never quietly dropped. Formats are read from their published
 * layouts; no code from those projects is copied here.
 */
export const addOnFormats = ["branch", "claude", "codex", "gemini"] as const;
export type AddOnFormat = (typeof addOnFormats)[number];
export const addOnManifestName = "branch-addon.json";
const maxFiles = 64, maxFileBytes = 256 * 1024, maxTotalBytes = 1024 * 1024, maxDepth = 5;
const wanted = /\.(json|md|toml|mjs)$/i;
const runnable = /\.(sh|bash|zsh|py|js|cjs|ts|ps1|cmd|bat|exe|rb|pl)$/i;
/** Program files a folder held that were never read, so the owner can be told they were left out. */
const unread = new WeakMap<ReadonlyMap<string, string>, string[]>();
const skipped = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

export interface AddOnSkill { name: string; description: string; document: string; from: string }
export type AddOnServer =
  | { id: string; transport: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { id: string; transport: "http"; url: string };
export interface AddOnOffer {
  format: AddOnFormat;
  id: string; name: string; version: string; description: string; author: string;
  skills: AddOnSkill[];
  servers: AddOnServer[];
  plugin: { file: string; code: string; permissions: string[]; hosts: string[] } | null;
  filters: FilterRule[];
  leftOut: string[];
  /** Every file read, with its fingerprint. */
  files: Record<string, string>;
  /** One fingerprint for the whole package: the sorted list of file fingerprints. */
  sha256: string;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const slug = (text: string, max = 40): string =>
  (text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, max).replace(/-+$/, "")) || "add-on";
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Every text file in a folder that a package could use, with limits, never following a link. */
export async function readPackageFolder(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const skippedPrograms: string[] = [];
  unread.set(files, skippedPrograms);
  let total = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for (const name of (await readdir(dir)).sort()) {
      if (skipped.has(name)) continue;
      const full = join(dir, name), info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(full, `${prefix}${name}/`, depth + 1); continue; }
      if (info.isFile() && runnable.test(name)) skippedPrograms.push(`${prefix}${name}`);
      if (!info.isFile() || !wanted.test(name) || info.size > maxFileBytes) continue;
      if (files.size >= maxFiles || (total += info.size) > maxTotalBytes)
        throw new Error("That package holds more files than an add-on may.");
      files.set(`${prefix}${name}`, await readFile(full, "utf8"));
    }
  };
  await walk(folder, "", 0);
  return files;
}

/** Reads a package from a folder, or from one flat zip, without running anything in it. */
export async function readPackageSource(source: string): Promise<Map<string, string>> {
  if (!isAbsolute(source)) throw new Error("Point at the folder or file in full, starting from the drive.");
  const info = await lstat(source).catch(() => null);
  if (!info) throw new Error("There is nothing at that address.");
  if (info.isDirectory()) return readPackageFolder(source);
  if (!info.isFile() || info.size > maxTotalBytes) throw new Error("That is not an add-on package this copy can read.");
  try { return zipRead(await readFile(source)); }
  catch (error) {
    // One file holds only a flat Branch package; anything with folders inside is read from a folder.
    if (error instanceof z.ZodError) throw new Error("That file has folders inside it. Unpack it and point at the folder instead.");
    throw error;
  }
}

/** Which layout the files are in, or null. */
export function formatOf(files: ReadonlyMap<string, string>): AddOnFormat | null {
  if (files.has(addOnManifestName)) return "branch";
  if (files.has(".claude-plugin/plugin.json")) return "claude";
  if (files.has(".codex-plugin/plugin.json") || files.has("plugin.json")) return "codex";
  if (files.has("gemini-extension.json")) return "gemini";
  return null;
}

const json = (files: ReadonlyMap<string, string>, name: string): Record<string, unknown> => {
  const raw = files.get(name);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { throw new Error(`${name} is not readable JSON.`); }
};

/** Turns any instruction file into a skill document Branch accepts, keeping only the fields it knows. */
export function toSkill(source: string, fallbackName: string, from: string, fallbackDescription = ""): AddOnSkill | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  let front: Record<string, unknown> = {};
  if (match) {
    try { front = (parseDocument(match[1]!).toJS({ maxAliasCount: 0 }) ?? {}) as Record<string, unknown>; } catch { front = {}; }
  }
  const body = (match ? match[2]! : source).trim();
  if (!body) return null;
  const name = slug(text(front.name, 64) || fallbackName, 64);
  const description = (text(front.description, 1000) || fallbackDescription || `Instructions from ${fallbackName}.`).replace(/\s+/g, " ");
  const document = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
  try { parseSkillDocument(document); } catch { return null; }
  return { name, description, document, from };
}

function mcpServers(raw: unknown, leftOut: string[]): AddOnServer[] {
  const servers: AddOnServer[] = [];
  const map = raw && typeof raw === "object" ? raw as Record<string, Record<string, unknown>> : {};
  for (const [name, entry] of Object.entries(map).slice(0, 12)) {
    const id = slug(name, 30);
    const url = text(entry?.url, 500) || text(entry?.httpUrl, 500);
    if (typeof entry?.command === "string" && entry.command.trim()) {
      const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string").slice(0, 40) : [];
      const envKeys = entry.env && typeof entry.env === "object" ? Object.keys(entry.env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).slice(0, 20) : [];
      servers.push({ id, transport: "stdio", command: entry.command.trim().slice(0, 300), args, envKeys });
    } else if (/^https?:\/\//.test(url)) servers.push({ id, transport: "http", url });
    else leftOut.push(`The server "${name}" was left out: Branch could not tell how to reach it.`);
  }
  return servers;
}

function folderSkills(files: ReadonlyMap<string, string>, leftOut: string[]): AddOnSkill[] {
  const skills: AddOnSkill[] = [];
  for (const [path, body] of files) {
    const skill = /^skills\/(.+)\/SKILL\.md$/i.exec(path);
    const command = /^commands\/(.+)\.md$/i.exec(path);
    const agent = /^agents\/(.+)\.md$/i.exec(path);
    const name = skill?.[1] ?? command?.[1] ?? agent?.[1];
    if (!name) continue;
    const kind = skill ? "skill" : command ? "command" : "helper";
    const made = toSkill(body, name.replaceAll("/", "-"), path, kind === "command" ? `The /${name} command from this add-on.` : "");
    if (made) skills.push(made);
    else leftOut.push(`${path} was left out: it has no instructions Branch can use.`);
    if (made && /^\uFEFF?---\r?\n(?:(?!---)[\s\S])*?^allowed-tools\s*:/m.test(body))
      leftOut.push(`The tool allowance in ${path} was left out: Branch's own approval rules decide what tools may do.`);
  }
  return skills;
}

function geminiCommands(files: ReadonlyMap<string, string>, leftOut: string[]): AddOnSkill[] {
  const skills: AddOnSkill[] = [];
  for (const [path, body] of files) {
    const command = /^commands\/(.+)\.toml$/i.exec(path);
    if (!command) continue;
    const { prompt = "", description = "" } = tomlStrings(body);
    const made = prompt.trim() ? toSkill(prompt, command[1]!.replaceAll("/", "-"), path, description || `The /${command[1]!.replaceAll("/", ":")} command from this extension.`) : null;
    if (made) skills.push(made); else leftOut.push(`${path} was left out: it has no prompt Branch can use.`);
  }
  return skills;
}

function leftOutOfPlugin(manifest: Record<string, unknown>, files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  if (manifest.hooks || files.has("hooks/hooks.json"))
    out.push("Its hooks were left out: they run shell commands, and Branch hooks only run programs you declared yourself.");
  for (const key of ["lspServers", "outputStyles", "themes", "settings", "userConfig", "plan"])
    if (manifest[key]) out.push(`Its "${key}" part was left out: Branch has nothing to put it in.`);
  if (manifest.excludeTools) out.push("Its list of tools to hide was left out: Branch's own approval rules decide what tools may do.");
  const programs = unread.get(files) ?? [];
  if (programs.length)
    out.push(`Its programs and scripts (${programs.slice(0, 5).join(", ")}${programs.length > 5 ? ", …" : ""}) were left out: nothing in a package is run except a plugin file you switch on.`);
  return out;
}

function claudeLike(files: ReadonlyMap<string, string>, format: AddOnFormat): Omit<AddOnOffer, "files" | "sha256"> {
  const manifestPath = format === "claude" ? ".claude-plugin/plugin.json" : files.has(".codex-plugin/plugin.json") ? ".codex-plugin/plugin.json" : "plugin.json";
  const manifest = json(files, manifestPath);
  const name = text(manifest.name, 80);
  if (!name) throw new Error(`${manifestPath} does not say what the plugin is called.`);
  const leftOut = leftOutOfPlugin(manifest, files);
  const author = manifest.author && typeof manifest.author === "object" ? text((manifest.author as Record<string, unknown>).name, 120) : text(manifest.author, 120);
  const mcp = json(files, ".mcp.json");
  const servers = mcpServers({ ...(mcp.mcpServers && typeof mcp.mcpServers === "object" ? mcp.mcpServers : mcp),
    ...(manifest.mcpServers && typeof manifest.mcpServers === "object" ? manifest.mcpServers : {}) }, leftOut);
  return { format, id: slug(name), name, version: text(manifest.version, 40) || "1", description: text(manifest.description, 500),
    author, skills: folderSkills(files, leftOut), servers, plugin: null, filters: [], leftOut };
}

function gemini(files: ReadonlyMap<string, string>): Omit<AddOnOffer, "files" | "sha256"> {
  const manifest = json(files, "gemini-extension.json");
  const name = text(manifest.name, 80);
  if (!name) throw new Error("gemini-extension.json does not say what the extension is called.");
  const leftOut = leftOutOfPlugin(manifest, files);
  const skills = [...folderSkills(files, leftOut), ...geminiCommands(files, leftOut)];
  const contextNames = Array.isArray(manifest.contextFileName) ? manifest.contextFileName : [manifest.contextFileName ?? "GEMINI.md"];
  for (const file of contextNames.filter((n): n is string => typeof n === "string").slice(0, 4)) {
    const body = files.get(file);
    const made = body ? toSkill(body, `${slug(name, 40)}-instructions`, file, `What the ${name} extension tells the assistant.`) : null;
    if (made) skills.push(made);
  }
  return { format: "gemini", id: slug(name), name, version: text(manifest.version, 40) || "1", description: text(manifest.description, 500),
    author: "", skills, servers: mcpServers(manifest.mcpServers, leftOut), plugin: null, filters: [], leftOut };
}

/**
 * A web address a plugin may reach, named by the site's own name. Numbers, this computer and names
 * that only mean something on a private network are refused, so a plugin can never be pointed back
 * at Branch or at the owner's own devices (the door refuses those too; this says so up front).
 */
export const PluginHostSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,200}$/)
  .refine((host) => /[a-z]/.test(host.split(".").at(-1) ?? ""), "Name a site by its name, not by numbers.")
  .refine((host) => !/(^|\.)(localhost|local|internal|lan|home|localdomain|home\.arpa)$/.test(host) && host.includes("."),
    "A plugin may not be pointed at this computer or a private network.");

export const BranchAddOnManifestSchema = z.object({
  format: z.literal("branch-addon"),
  apiVersion: z.number().int().min(1).default(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().max(40).default("1"),
  description: z.string().trim().max(500).default(""),
  author: z.string().trim().max(120).default(""),
  skills: z.array(z.string().max(120)).max(16).default([]),
  plugin: z.string().max(120).optional(),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(20).default([]),
  hosts: z.array(PluginHostSchema).max(16).default([]),
  servers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  filters: z.array(z.unknown()).max(16).default([]),
  /** A fingerprint for each file; when given, a file that differs or is not listed stops the read. */
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict();

function checkListed(files: ReadonlyMap<string, string>, listed: Record<string, string> | undefined): void {
  if (!listed) return;
  for (const [name, body] of files) {
    if (name === addOnManifestName) continue;
    if (!(name in listed)) throw new Error(`${name} is not in the package's list of files, so the package was not read.`);
    if (listed[name] !== sha256(body)) throw new Error(`${name} does not match the fingerprint in the package, so the package was not read.`);
  }
  for (const name of Object.keys(listed)) if (!files.has(name)) throw new Error(`The package lists ${name}, but it is missing.`);
}

function branch(files: ReadonlyMap<string, string>): Omit<AddOnOffer, "files" | "sha256"> {
  const manifest = BranchAddOnManifestSchema.parse(json(files, addOnManifestName));
  checkApiVersion(manifest.apiVersion, `The add-on ${manifest.name}`);
  checkListed(files, manifest.files);
  const leftOut: string[] = [];
  const skills = manifest.skills.map((file) => {
    const body = files.get(file);
    if (body === undefined) throw new Error(`The package names the skill ${file}, but it is missing.`);
    const made = toSkill(body, file.replace(/\.md$/i, ""), file);
    if (!made) throw new Error(`${file} is not a skill Branch can read.`);
    return made;
  });
  let plugin: AddOnOffer["plugin"] = null;
  if (manifest.plugin) {
    if (manifest.plugin !== `${manifest.id}.mjs`) throw new Error(`The plugin file of ${manifest.id} must be called ${manifest.id}.mjs.`);
    const code = files.get(manifest.plugin);
    if (code === undefined) throw new Error(`The package names ${manifest.plugin}, but it is missing.`);
    plugin = { file: manifest.plugin, code, permissions: manifest.permissions, hosts: manifest.hosts };
  }
  const filters = manifest.filters.map((rule) => FilterRuleSchema.parse({ ...(rule as object), enabled: false }));
  return { format: "branch", id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
    author: manifest.author, skills, servers: mcpServers(manifest.servers, leftOut), plugin, filters, leftOut };
}

/** Reads what a package holds, in any layout this copy knows. */
export function readOffer(files: ReadonlyMap<string, string>): AddOnOffer {
  const format = formatOf(files);
  if (!format) throw new Error(`That is not an add-on: there is no ${addOnManifestName}, .claude-plugin/plugin.json, .codex-plugin/plugin.json or gemini-extension.json in it.`);
  const read = format === "branch" ? branch(files) : format === "gemini" ? gemini(files) : claudeLike(files, format);
  const fingerprints = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => [name, sha256(body)]));
  const whole = sha256(Object.entries(fingerprints).map(([name, hash]) => `${name}\0${hash}`).join("\n"));
  return { ...read, skills: read.skills.slice(0, 16), files: fingerprints, sha256: whole };
}
