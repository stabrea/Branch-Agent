import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Q48: a structured record of every change the settings kit makes — which setting, what it was,
 * what it became, who made it (the owner in the window, or a conversation), which way (one switch,
 * a preset, putting back, a settings file, talking, an undo) and when. Undo and "why is this on?"
 * read these records only; the audit sentence `applyWithPins` writes is for people, and is never
 * parsed. Only catalogue fields reach here, so no key, password or connection is ever inside.
 */
export const settingsHistoryKey = "settings-history";
/** The most change records kept; the oldest go first. */
export const settingsHistoryLimit = 200;

const Value = z.union([z.string().max(80), z.number(), z.boolean()]);
/** Q48 review: "owner-by-command" is the owner typing a command such as /preset, in the terminal or a chat. */
export const ChangeWriters = ["owner-in-window", "owner-by-command", "conversation", "unknown"] as const;
/** "card" is a setting's own card or screen saving around the kit; "command" is a typed command. */
export const ChangeSources = ["switch", "preset", "reset", "import", "talk", "undo", "card", "command", "unknown"] as const;
export type ChangeWriter = (typeof ChangeWriters)[number];
export type ChangeSource = (typeof ChangeSources)[number];

const EntrySchema = z.object({ setting: z.string().max(160), before: Value, after: Value }).strict();
const RecordSchema = z.object({
  id: z.string().max(80),
  at: z.string().max(40),
  writer: z.enum(ChangeWriters),
  source: z.enum(ChangeSources),
  /** The preset's name, which setting was put back, or which conversation asked. */
  detail: z.string().max(200).default(""),
  runId: z.string().max(80).optional(),
  sessionId: z.string().max(80).optional(),
  changes: z.array(EntrySchema).max(500),
  /** For an undo: the record it undid. */
  undoes: z.string().max(80).optional(),
  /** Set when this record was undone, to the undo's own record. */
  undoneBy: z.string().max(80).optional(),
}).strict();
const HistorySchema = z.object({ records: z.array(RecordSchema).max(settingsHistoryLimit) }).strict();

export type ChangeEntry = z.infer<typeof EntrySchema>;
export type ChangeRecord = z.infer<typeof RecordSchema>;

/** Who and which way, as the caller of `applyWithPins` knows it. */
export interface ChangeOrigin {
  writer: ChangeWriter;
  source: ChangeSource;
  detail?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  undoes?: string | undefined;
}

/** Every record, oldest first. A damaged history counts as none, never as a made-up one. */
export function settingsHistory(store: Pick<Store, "get">, owner: string): ChangeRecord[] {
  const saved = HistorySchema.safeParse(store.get("settings", owner, settingsHistoryKey)?.data ?? { records: [] });
  return saved.success ? saved.data.records : [];
}

function saveHistory(store: Store, owner: string, records: readonly ChangeRecord[]): void {
  store.save("settings", owner, settingsHistoryKey, { records: records.slice(-settingsHistoryLimit) });
}

/** Adds one record and returns its id. */
export function recordSettingsChange(store: Store, owner: string, origin: ChangeOrigin, changes: readonly ChangeEntry[]): string {
  const record: ChangeRecord = RecordSchema.parse({
    id: randomUUID(), at: new Date().toISOString(), writer: origin.writer, source: origin.source,
    detail: (origin.detail ?? "").slice(0, 200), changes: changes.slice(0, 500),
    ...(origin.runId ? { runId: origin.runId.slice(0, 80) } : {}),
    ...(origin.sessionId ? { sessionId: origin.sessionId.slice(0, 80) } : {}),
    ...(origin.undoes ? { undoes: origin.undoes } : {}),
  });
  const records = settingsHistory(store, owner);
  const marked = origin.undoes
    ? records.map((entry) => entry.id === origin.undoes ? { ...entry, undoneBy: record.id } : entry)
    : records;
  saveHistory(store, owner, [...marked, record]);
  return record.id;
}

/** The newest record that changed this setting, or undefined. */
export function lastChangeOf(store: Pick<Store, "get">, owner: string, setting: string): { record: ChangeRecord; entry: ChangeEntry } | undefined {
  const records = settingsHistory(store, owner);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const entry = record.changes.find((change) => change.setting === setting);
    if (entry) return { record, entry };
  }
  return undefined;
}
