import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

/**
 * A bridge to the owner's notes folder. The owner uses Obsidian, and Obsidian's own files are
 * ordinary Markdown in an ordinary folder — so this is a folder bridge and nothing more. There is
 * no Obsidian plugin here, nothing is installed into Obsidian, and Obsidian does not have to be
 * running: Branch writes notes into a folder the owner names, and reads back the ones they have
 * tagged for it.
 *
 * Three rules make it safe to point at a folder full of the owner's own writing:
 *
 * 1. **Confined.** Every path is resolved for real — following any shortcut — and must still sit
 *    inside the folder the owner named, with the separator included in the comparison, so a folder
 *    called `notes-other` is not mistaken for a folder called `notes`.
 * 2. **Never overwritten.** Each note Branch writes carries a hash of what Branch wrote. If the
 *    file on disk no longer matches that hash, the owner has edited it, and the new version is
 *    written beside it as `<name>.branch-conflict.md` instead. Nothing the owner typed is lost.
 * 3. **Only what it is given.** Reading back takes only notes carrying `#branch`, so pointing at a
 *    whole vault does not pull the owner's private writing into the assistant's documents.
 */
export const ObsidianSettingsSchema = z.object({
  /** Off until the owner names a folder. */
  enabled: z.boolean().default(false),
  /** The folder, in full. Everything is written inside it and nothing outside it is ever read. */
  vault: z.string().max(1000).default(""),
  /** The subfolder inside the vault that Branch writes into, so its notes stay together. */
  folder: z.string().max(120).default("Branch"),
}).strict();
export type ObsidianSettings = z.infer<typeof ObsidianSettingsSchema>;
const settingsKey = "obsidian";

export function obsidianSettings(store: Store, owner: string): ObsidianSettings {
  const saved = ObsidianSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : ObsidianSettingsSchema.parse({});
}
export async function saveObsidianSettings(store: Store, owner: string, input: unknown): Promise<ObsidianSettings> {
  const value = ObsidianSettingsSchema.parse({ ...obsidianSettings(store, owner), ...(input as object ?? {}) });
  if (value.enabled) {
    if (!value.vault || !isAbsolute(value.vault))
      throw new Error("Give the notes folder in full, starting from the drive.");
    if (!(await stat(value.vault).catch(() => null))?.isDirectory())
      throw new Error("There is no folder at that address.");
    if (/[\\/]/.test(value.folder)) throw new Error("The subfolder is one name, not a path.");
  }
  store.save("settings", owner, settingsKey, value);
  return value;
}

/** What a note is made of. Everything else about it is worked out from these. */
export const NoteSchema = z.object({
  /** What the note is: a fact remembered, a knowledge card, a saved report, a conversation. */
  kind: z.enum(["memory", "knowledge", "report", "conversation"]),
  /** Branch's own number for the thing, written into the note so it is recognised again. */
  id: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  body: z.string().max(200_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
}).strict();
export type Note = z.infer<typeof NoteSchema>;
export interface WrittenNote { path: string; written: boolean; conflict: string | null; reason: string }

/** A note's file name: the title, made safe, with Branch's own number so two never collide. */
export function noteFileName(note: Note): string {
  const stem = note.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, " ").slice(0, 60) || note.kind;
  return `${stem} (${note.id.slice(0, 8)}).md`;
}
const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

/**
 * Every path goes through here. The folder is resolved for real first, so a shortcut pointing out
 * of the vault is followed and then refused; the separator is part of the comparison, so a sibling
 * folder whose name merely starts the same way is refused too.
 */
/** The real path of the nearest part of a name that exists, with the rest of the name hung back on. */
async function resolveThroughLinks(target: string): Promise<string> {
  const missing: string[] = [];
  let probe = target;
  for (let depth = 0; depth < 64; depth += 1) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) return missing.length ? resolve(real, ...missing) : real;
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  return target;
}

export async function insideVault(vault: string, wanted: string): Promise<string> {
  const root = await realpath(resolve(vault)).catch(() => resolve(vault));
  const target = resolve(root, wanted);
  /* A file that does not exist yet cannot be resolved for real, so the nearest folder above it that
     does exist is resolved and the rest of the name hung back on. Resolving only the whole path and
     falling back to the name as written would let a link already sitting in the notes folder carry
     a note that does not exist yet straight out of it. */
  const existing = await resolveThroughLinks(target);
  const within = relative(root + sep, existing);
  if (existing !== root && (!within || within.startsWith("..") || isAbsolute(within)))
    throw new Error("That note is outside the notes folder, so Branch will not touch it.");
  return existing;
}

/** The note as Obsidian sees it: front matter, then the words, then the tags on their own line. */
export function noteText(note: Note, hash: string): string {
  const lines = ["---", `branch-id: ${note.id}`, `branch-kind: ${note.kind}`,
    `branch-hash: ${hash}`, `title: "${note.title.replace(/"/g, "'")}"`, "---", "",
    `# ${note.title}`, "", note.body.trim(), ""];
  const tags = ["branch", ...note.tags].map((tag) => `#${tag.replace(/[^\p{L}\p{N}_-]/gu, "")}`);
  lines.push(tags.join(" "), "");
  return lines.join("\n");
}
/** The hash Branch wrote into a note the last time it wrote one, or null when there is none. */
export function hashIn(text: string): string | null {
  return /^---[\s\S]*?^branch-hash:\s*([a-f0-9]{8,64})\s*$/m.exec(text)?.[1] ?? null;
}
/**
 * The words out of a note Branch wrote: the front matter, the heading and the tag line taken back
 * off again, so what is left can be hashed and held against the hash the note carries.
 */
export function bodyOf(text: string): string {
  return text
    .replace(/^---[\s\S]*?^---[^\n]*\n/m, "")
    .replace(/^\s*#[^#\n][^\n]*\n/, "")
    .replace(/\n#[\p{L}\p{N}_ #-]*\s*$/u, "")
    .trim();
}
/** True when the note on disk is still exactly the one Branch last wrote there. */
export function untouched(text: string): boolean {
  const wrote = hashIn(text);
  return wrote !== null && wrote === hashOf(bodyOf(text));
}

export class ObsidianBridge {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private settings(): ObsidianSettings {
    const value = obsidianSettings(this.store, this.owner);
    if (!value.enabled || !value.vault) throw new Error("The notes folder is not set up. The owner names it in Settings.");
    return value;
  }
  /**
   * Writes one note. A note Branch has not written before is written; one it has written before is
   * written again only if the owner has not touched it since. If they have, the new version goes
   * beside it and the owner's own words stay exactly where they were.
   */
  async write(input: unknown): Promise<WrittenNote> {
    const note = NoteSchema.parse(input);
    const { vault, folder } = this.settings();
    const target = await insideVault(vault, join(folder, noteFileName(note)));
    await mkdir(await insideVault(vault, folder), { recursive: true });
    const wanted = noteText(note, hashOf(note.body.trim()));
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing === null) {
      await writeFile(target, wanted, "utf8");
      return { path: target, written: true, conflict: null, reason: "This note is new." };
    }
    if (untouched(existing)) {
      await writeFile(target, wanted, "utf8");
      return { path: target, written: true, conflict: null, reason: "The note was untouched, so it was brought up to date." };
    }
    const beside = target.replace(/\.md$/, "") + ".branch-conflict.md";
    await writeFile(beside, wanted, "utf8");
    return { path: target, written: false, conflict: beside,
      reason: "You have edited that note since Branch wrote it, so the new version is beside it and yours is untouched." };
  }
  /** Every note in the vault carrying `#branch`, so the owner decides what Branch may read. */
  async read(limit = 200): Promise<{ path: string; title: string; text: string }[]> {
    const { vault } = this.settings();
    const root = await insideVault(vault, ".");
    const found: { path: string; title: string; text: string }[] = [];
    await walk(root, root, found, limit);
    return found;
  }
}

/** Walks the vault, never following a shortcut out of it, collecting only the tagged notes. */
async function walk(root: string, at: string, found: { path: string; title: string; text: string }[], limit: number): Promise<void> {
  if (found.length >= limit) return;
  const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (found.length >= limit) return;
    if (entry.name.startsWith(".")) continue;
    const here = join(at, entry.name);
    /* A folder or file reached through a shortcut is refused, exactly as a write would be. */
    const real = await insideVault(root, relative(root, here)).catch(() => null);
    if (!real) continue;
    if (entry.isDirectory()) { await walk(root, real, found, limit); continue; }
    if (!entry.name.endsWith(".md")) continue;
    const text = await readFile(real, "utf8").catch(() => "");
    if (!/(^|\s)#branch(\s|$)/m.test(text)) continue;
    found.push({ path: real, title: entry.name.replace(/\.md$/, ""), text: text.slice(0, 200_000) });
  }
}

export function registerObsidian(registry: ToolRegistry, bridge: ObsidianBridge): void {
  registry.register({
    name: "obsidian.sync", permission: "documents.write",
    description: "Write one note into the owner's notes folder, never over anything they have edited themselves.",
    parameters: NoteSchema,
    execute: async (input) => bridge.write(input),
  });
  registry.register({
    name: "obsidian.read", permission: "documents.read",
    description: "Read back the notes in the owner's notes folder that they tagged with #branch.",
    parameters: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
    execute: async (input) => ({ notes: (await bridge.read(input.limit)).map((note) => ({ ...note, text: note.text.slice(0, 4000) })) }),
  });
}

/** The routes behind the notes-folder card. Returns null for any path that is not one of them. */
export async function obsidianApi(
  store: Store, owner: string, bridge: ObsidianBridge,
  request: { method?: string | undefined }, path: string, body: () => Promise<unknown>,
): Promise<unknown | null> {
  const method = request.method ?? "GET";
  if (path === "/api/obsidian")
    return method === "POST" ? saveObsidianSettings(store, owner, await body()) : obsidianSettings(store, owner);
  if (path === "/api/obsidian/write" && method === "POST") return bridge.write(await body());
  if (path === "/api/obsidian/notes" && method === "GET")
    return { notes: (await bridge.read()).map((note) => ({ path: note.path, title: note.title })) };
  return null;
}
