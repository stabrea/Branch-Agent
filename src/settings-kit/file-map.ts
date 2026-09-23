import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Store } from "../store.js";
import { contextFileSettings, contextFileStatus, findFile, perFileBytes, slotKeys, slots, switchFor, type SlotKey } from "../context-files.js";
import { folderAllows } from "../folder-trust.js";

/**
 * R17-S05: "which file does what". One list of the files the owner writes by hand — what each is
 * for, where it is kept, whether the assistant sees it and when — and a way to change one without
 * leaving the window.
 *
 * Reading goes through the loader in `src/context-files.ts` (`findFile`), so the editor shows
 * exactly the text the assistant would be handed. A file longer than the loader carries is not
 * offered for editing here, because saving what was shown would cut off the rest. Writing never
 * follows a link, and refuses anything that is not a plain file.
 */
export const SlotSchema = z.enum(slotKeys);
export const FileSaveSchema = z.object({
  slot: SlotSchema,
  text: z.string().max(perFileBytes * 4),
}).strict();

export interface FileMapEntry {
  slot: SlotKey;
  names: readonly string[];
  about: string;
  /** "you": kept with the owner's own things and used in every project; "project": this workspace only. */
  scope: "you" | "project";
  setting: string;
  outcome: string;
  name: string | null;
  bytes: number;
  permissionShaped: number;
  /** DG-182: the file's first line of words (not a heading), cut to 70 characters; "" when there is none. Owner only, like the rest. */
  first: string;
}

/** The first line of a file's text that is words, not a heading. */
function firstWords(text: string | undefined): string {
  const line = text?.split(/\r?\n/).map((each) => each.trim()).find((each) => each && !each.startsWith("#"));
  return line ? line.slice(0, 70) : "";
}

export function fileMap(store: Store, owner: string, workspace: string): FileMapEntry[] {
  const reports = contextFileStatus(store, owner, workspace);
  const folders = { workspace, owner: store.folder, allows: (folder: string) => folderAllows(store, owner, folder) };
  return slots.map((slot) => {
    const report = reports.find((entry) => entry.key === slot.key);
    /* A file switched off is not measured by the report, yet it is written: its name and size come from the file itself. */
    const found = findFile(folders, slot.key);
    return {
      slot: slot.key, names: slot.names, about: slot.about, scope: slot.scope === "owner" ? "you" : "project",
      setting: report?.setting ?? "off", outcome: report?.outcome ?? "missing", name: report?.name ?? found?.name ?? null,
      bytes: report?.bytes || found?.bytes || 0, permissionShaped: report?.permissionShaped.length ?? 0,
      first: firstWords(found?.text),
    };
  });
}

/** The folders a slot's file is looked for in, in the loader's order. */
function rootsFor(store: Store, owner: string, workspace: string, key: SlotKey): string[] {
  const slot = slots.find((entry) => entry.key === key)!;
  const trusted = folderAllows(store, owner, workspace);
  if (slot.scope === "owner") return trusted ? [workspace, store.folder] : [store.folder];
  return trusted ? [workspace] : [];
}

/** Where the file is, or where a new one would go; null when the workspace is not trusted. */
function placeFor(store: Store, owner: string, workspace: string, key: SlotKey): { path: string; exists: boolean } | null {
  const slot = slots.find((entry) => entry.key === key)!;
  const roots = rootsFor(store, owner, workspace, key);
  if (!roots.length) return null;
  for (const folder of roots)
    for (const name of slot.names)
      if (lstatSync(join(folder, name), { throwIfNoEntry: false })) return { path: join(folder, name), exists: true };
  return { path: join(slot.scope === "owner" ? store.folder : workspace, slot.names[0]), exists: false };
}

export interface OpenedFile { slot: SlotKey; name: string; text: string; editable: boolean; why: string; setting: string }

export function openFile(store: Store, owner: string, workspace: string, key: SlotKey): OpenedFile {
  const slot = slots.find((entry) => entry.key === key)!;
  const setting = switchFor(contextFileSettings(store, owner), key);
  const place = placeFor(store, owner, workspace, key);
  if (!place) return { slot: key, name: slot.names[0], text: "", editable: false, setting, why: "not trusted" };
  const found = findFile({ workspace, owner: store.folder, allows: (folder) => folderAllows(store, owner, folder) }, key);
  if (found?.trimmed) return { slot: key, name: found.name, text: "", editable: false, setting, why: "too long" };
  if (place.exists && !found) return { slot: key, name: slot.names[0], text: "", editable: false, setting, why: "not a file" };
  return { slot: key, name: found?.name ?? slot.names[0], text: found?.text ?? "", editable: true, setting, why: "" };
}

/**
 * Opens the file for writing without following a link, and refuses anything that is not a plain file
 * with one name: a hard link would carry the owner's text into whatever else it names.
 */
function openForWrite(path: string, exists: boolean): number {
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (exists ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = openSync(path, flags, 0o600);
  const found = fstatSync(handle);
  if (!found.isFile() || (exists && found.nlink > 1)) {
    closeSync(handle);
    throw new Error("That is not a plain file, so nothing was written.");
  }
  return handle;
}

/**
 * Replaces the whole file with the owner's text. `guard` is the never-break check: a file outside the
 * data folder's own list (a project's file) is asked about before it is written.
 */
export function saveFile(store: Store, owner: string, workspace: string, input: unknown, guard?: (target: string) => string | null): OpenedFile {
  const { slot, text } = FileSaveSchema.parse(input);
  if (Buffer.byteLength(text, "utf8") > perFileBytes)
    throw new Error(`That is longer than your assistant reads (${perFileBytes / 1000} kB). Shorten it and save again.`);
  const opened = openFile(store, owner, workspace, slot);
  if (!opened.editable) throw new Error(opened.why === "not trusted"
    ? "This workspace folder is not trusted, so its files are not read or written. Trust it under Permissions first."
    : "This file cannot be changed here. Open it in your own editor.");
  const place = placeFor(store, owner, workspace, slot)!;
  if (place.exists && !lstatSync(place.path).isFile()) throw new Error("That is not a plain file, so nothing was written.");
  const refused = resolve(dirname(place.path)) === resolve(store.folder) ? null : guard?.(place.path);
  if (refused) throw new Error(refused);
  // phase2/accounts: what the file held before, so the last save here can be undone (`undoFile`).
  const before = place.exists ? readFileSync(place.path, "utf8") : null;
  const after = text.endsWith("\n") || !text ? text : `${text}\n`;
  writeWhole(place.path, place.exists, after);
  store.save("settings", owner, undoKey(slot), { path: place.path, at: new Date().toISOString(), text: { before, after } } satisfies UndoRecord);
  return openFile(store, owner, workspace, slot);
}
function writeWhole(path: string, exists: boolean, text: string): void {
  const handle = openForWrite(path, exists);
  try {
    if (exists) ftruncateSync(handle, 0);
    writeSync(handle, text);
  } finally { closeSync(handle); }
}

/* ---------- phase2/accounts (critique #40): undo of the last save made here ---------- */

/**
 * Integration review: the two texts sit one level down, so the diagnostics summary (which keeps only a
 * record's top-level switch-like values, src/diagnostic-api.ts) never copies a word of the file.
 */
interface UndoRecord { path: string; at: string; text: { before: string | null; after: string } }
const undoKey = (slot: SlotKey): string => `settings-kit-file-undo-${slot}`;
export const FileUndoSchema = z.object({ slot: SlotSchema }).strict();

/** When the last save here was made, while it can still be undone; null when there is nothing to undo. */
export function lastSave(store: Store, owner: string, slot: SlotKey): string | null {
  const record = store.get("settings", owner, undoKey(slot))?.data as UndoRecord | undefined;
  return record?.text ? record.at : null;
}

/**
 * Puts back what the file held before the last save here: the old text, or no file at all when the
 * save made it. Only while the file still holds exactly what was saved, so a change made since (in
 * another editor, by a task) is never overwritten; the same plain-file and never-break checks apply.
 */
export function undoFile(store: Store, owner: string, workspace: string, input: unknown, guard?: (target: string) => string | null): OpenedFile {
  const { slot } = FileUndoSchema.parse(input);
  const record = store.get("settings", owner, undoKey(slot))?.data as UndoRecord | undefined;
  if (!record?.text) throw new Error("There is no save here to undo.");
  // Integration review: only where this file is today, and only while it may be written here (the
  // project folder or its trust may have changed since the save).
  const place = placeFor(store, owner, workspace, slot);
  if (!place || resolve(place.path) !== resolve(record.path) || !openFile(store, owner, workspace, slot).editable)
    throw new Error("This file is no longer where it was saved, or may no longer be changed here, so nothing was undone.");
  const { before, after } = record.text;
  const found = lstatSync(record.path, { throwIfNoEntry: false });
  if (!found?.isFile() || found.nlink > 1 || readFileSync(record.path, "utf8") !== after)
    throw new Error("The file changed after it was saved here, so nothing was undone.");
  const refused = resolve(dirname(record.path)) === resolve(store.folder) ? null : guard?.(record.path);
  if (refused) throw new Error(refused);
  if (before === null) unlinkSync(record.path);
  else writeWhole(record.path, true, before);
  store.delete("settings", owner, undoKey(slot));
  return openFile(store, owner, workspace, slot);
}
