import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { WorkspaceFiles } from "./files.js";
import { factKindOf, factKinds, layerOf, projectOf, type FactKind } from "./memory-layers.js";
import type { MemoryRecord } from "./memory.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * Everything the assistant remembers, written out as ordinary Markdown in the person's own
 * workspace. The database stays the real store; this is a window onto it, one note per kind of
 * fact, rewritten from scratch whenever it is asked for. That makes what the assistant knows
 * readable in any editor, searchable with any tool, and — because it is a folder of Markdown —
 * usable by a notes app such as Obsidian pointed at the same workspace.
 *
 * The folder is the assistant's to write and nobody else's, so it is marked read-only to the
 * assistant's own file tools: editing a note here would be quietly undone the next time the mirror
 * is written, and a change nobody can keep is worse than no change at all. To change what is
 * remembered, change the fact in the Memory screen and the note follows.
 */
export const mirrorFolder = "memory";
export const maximumMirrored = 500;
export const readOnlyRefusal =
  `The "${mirrorFolder}" folder is written from what the assistant remembers, so a change made here would be `
  + "undone the next time it is written. Change the fact in the Memory screen instead and the note will follow.";

/** The heading each kind of fact gets, in the words a person would use for it. */
export const kindTitles: Record<FactKind, string> = {
  preference: "How you like things done",
  "fact-about-person": "About you and the people around you",
  "fact-about-world": "Things that are so",
  "procedure-hint": "How to do particular jobs",
  "project-note": "Notes tied to a project",
  "task-scratch": "Notes kept from one job",
};
export const MirrorSchema = z.object({
  /** Write the notes even when nothing has changed since the last time. */
  force: z.boolean().default(false),
}).strict();
export interface MirrorReport {
  folder: string; files: { path: string; facts: number }[]; facts: number; wrote: boolean; note: string;
}

export class MemoryMirror {
  /** A fingerprint of what was last written, so an unchanged store is not rewritten every minute. */
  private lastWritten = new Map<string, string>();
  // ── R17-059 (src/learning-more/readback.ts): the owner's edits are read back before a rewrite, and
  // what was written is noted after it. `beforeWrite` answers true when it read edits, which forces
  // the rewrite so the file shows what is remembered again. Both stay unset while that part is off. ──
  beforeWrite?: (owner: string) => Promise<boolean>;
  afterWrite?: (owner: string) => Promise<void>;
  // ── end R17-059 ──
  constructor(private readonly store: Store, private readonly files?: WorkspaceFiles) {}

  /** Whether a workspace path belongs to the mirror, which is what makes it read-only above. */
  owns(path: string): boolean {
    const clean = path.replace(/^\.\//, "").replace(/\\/g, "/");
    return clean === mirrorFolder || clean.startsWith(`${mirrorFolder}/`);
  }
  /**
   * Whether the folder is there at all. Nobody's workspace grows a folder they did not ask for, so
   * the notes are written the first time the owner asks for them and only keep themselves up to
   * date after that. Deleting the folder is how you say you have stopped wanting them.
   */
  async exists(): Promise<boolean> {
    if (!this.files) return false;
    const folder = await this.files.checked(mirrorFolder, true).catch(() => "");
    return !!folder && (await readdir(folder).catch(() => null)) !== null;
  }

  /** Every long-lasting fact, grouped by kind, newest first within each group. */
  grouped(owner: string): Map<FactKind, MemoryRecord[]> {
    const grouped = new Map<FactKind, MemoryRecord[]>();
    const records = (this.store.list("memory", owner) as MemoryRecord[])
      .filter((record) => layerOf(record) !== "working").slice(0, maximumMirrored);
    for (const record of records) {
      const kind = factKindOf(record);
      grouped.set(kind, [...(grouped.get(kind) ?? []), record]);
    }
    return grouped;
  }

  /** Writes the folder from scratch: one note per kind, plus a short note saying what it all is. */
  async regenerate(owner: string, input: unknown = {}): Promise<MirrorReport> {
    let { force } = MirrorSchema.parse(input);
    if (!this.files) return { folder: mirrorFolder, files: [], facts: 0, wrote: false, note: "Workspace files are not available in this launch." };
    if (await this.beforeWrite?.(owner).catch(() => false)) force = true; // R17-059
    const grouped = this.grouped(owner);
    const notes = [...grouped].map(([kind, records]) => ({ kind, records, body: noteFor(kind, records) }));
    const fingerprint = notes.map((note) => `${note.kind}:${note.body.length}:${note.records.length}`).join("|");
    if (!force && this.lastWritten.get(owner) === fingerprint)
      return { folder: mirrorFolder, files: notes.map((note) => ({ path: pathFor(note.kind), facts: note.records.length })),
        facts: countAll(grouped), wrote: false, note: "Nothing has changed since these notes were last written." };
    await this.clear();
    await this.put(`${mirrorFolder}/README.md`, readme(countAll(grouped), notes.length));
    for (const note of notes) await this.put(pathFor(note.kind), note.body);
    this.lastWritten.set(owner, fingerprint);
    await this.afterWrite?.(owner).catch(() => undefined); // R17-059
    return { folder: mirrorFolder, files: notes.map((note) => ({ path: pathFor(note.kind), facts: note.records.length })),
      facts: countAll(grouped), wrote: true, note: "" };
  }
  /** Old notes go before new ones are written, so a kind with nothing left in it leaves no note. */
  private async clear(): Promise<void> {
    if (!this.files) return;
    const folder = await this.files.checked(mirrorFolder, true).catch(() => "");
    if (!folder) return;
    for (const name of await readdir(folder).catch(() => [] as string[]))
      if (name.endsWith(".md")) await rm(`${folder}/${name}`, { force: true }).catch(() => undefined);
  }
  private async put(path: string, body: string): Promise<void> {
    if (!this.files) return;
    const target = await this.files.checked(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { mode: 0o600 });
  }
}
const pathFor = (kind: FactKind): string => `${mirrorFolder}/${kind}.md`;
const countAll = (grouped: Map<FactKind, MemoryRecord[]>): number =>
  [...grouped.values()].reduce((sum, records) => sum + records.length, 0);
/** One note: a heading, then one bullet per fact, with the project it belongs to where it has one. */
export function noteFor(kind: FactKind, records: MemoryRecord[]): string {
  const lines = records.map((record) => {
    const text = String(record.data.text ?? "").replace(/\s+/g, " ").trim();
    const project = projectOf(record);
    return `- ${text}${project ? ` _(project: ${project})_` : ""}`;
  });
  return `# ${kindTitles[kind]}\n\nWritten by Branch Agent from what it remembers. Do not edit: see README.md.\n\n${lines.join("\n")}\n`;
}
const readme = (facts: number, notes: number): string =>
  `# What Branch Agent remembers\n\nThis folder is written by the assistant from the facts it has saved: `
  + `${facts} of them, across ${notes} note${notes === 1 ? "" : "s"}. It is rewritten from scratch each time, so `
  + `anything you type here is lost. To change what the assistant remembers, open the Memory screen.\n\n`
  + `Because these are plain Markdown files in your workspace, a notes app pointed at the same folder — Obsidian, `
  + `for example — shows them alongside your own notes.\n\nOne note per kind of fact:\n`
  + `${factKinds.map((kind) => `- \`${kind}.md\` — ${kindTitles[kind]}`).join("\n")}\n`;

/**
 * The mirror is deliberately **not** a tool the assistant can call. The folder is read-only to the
 * assistant's own file tools for the reason given above, and handing it a second way to write the
 * very folder it may not edit would take that back. So it keeps itself up to date instead: once the
 * owner has asked for the notes at least once (`POST /api/memory/mirror` from the Memory screen),
 * every task that finishes writes them again if what is remembered has changed — and the
 * fingerprint above means an unchanged store costs nothing. Until then the folder is not created,
 * because nobody's workspace should grow a folder they never asked for.
 */
export function registerMemoryMirror(registry: ToolRegistry, mirror: MemoryMirror): void {
  registry.onRunFinished(async (context) => {
    if (await mirror.exists().catch(() => false))
      await mirror.regenerate(context.owner).catch(() => undefined);
  });
}
