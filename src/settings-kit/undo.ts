import type { Store } from "../store.js";
import { specFor } from "./catalogue.js";
import { applyWithPins, changesFor, currentValue, type Change, type Value, type Writer } from "./changes.js";
import { lastChangeOf, settingsHistory, type ChangeRecord } from "./history.js";

/**
 * Q48 and Q49: undoing one recorded change, and saying why a setting is as it is. Both read the
 * structured change records (src/settings-kit/history.ts) and nothing else.
 */
export class UndoRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function valueOf(store: Store, owner: string, setting: string): Value | undefined {
  const dot = setting.indexOf(".");
  const spec = specFor(setting.slice(0, dot));
  const field = spec?.fields.find((entry) => entry.field === setting.slice(dot + 1));
  return spec && field ? currentValue(store, owner, spec, field) : undefined;
}

/** Why this record cannot be undone exactly as it stands, or null. Nothing is written here. */
function undoRefusal(store: Store, owner: string, record: ChangeRecord): string | null {
  if (record.undoneBy) return "That change was already undone.";
  const moved = record.changes.filter((entry) => valueOf(store, owner, entry.setting) !== entry.after);
  if (moved.length)
    return `It cannot be put back exactly, because ${moved.map((entry) => entry.setting).join(", ")} changed again since. Change ${moved.length > 1 ? "them" : "it"} by hand instead.`;
  return null;
}

export interface UndoChoice {
  confirmLoosening: boolean;
  writers?: Record<string, Writer> | undefined;
}

/**
 * Puts back exactly the recorded before-values of one change, as a new change of its own through
 * the same path every change takes: pins, the separate yes for anything less careful, the setting's
 * own save, the audit record and a change record. It is all or nothing: a setting that changed
 * again since, a pinned setting or a missing yes refuses the whole undo before anything is written.
 */
export function undoSettingsChange(store: Store, owner: string, id: string, choice: UndoChoice): { applied: Change[]; record: string | null } {
  const record = settingsHistory(store, owner).find((entry) => entry.id === id);
  if (!record) throw new UndoRefused(404, "There is no such change to undo.");
  const refusal = undoRefusal(store, owner, record);
  if (refusal) throw new UndoRefused(409, refusal);
  const proposals = record.changes.map((entry) => {
    const dot = entry.setting.indexOf(".");
    return { key: entry.setting.slice(0, dot), field: entry.setting.slice(dot + 1), value: entry.before };
  });
  const { changes, refused } = changesFor(store, owner, proposals);
  if (refused.length) throw new UndoRefused(409, `It cannot be put back: ${refused.join("; ")}`);
  const pinned = changes.filter((change) => change.pinned);
  if (pinned.length)
    throw new UndoRefused(409, `It cannot be put back while ${pinned.map((change) => `${change.name}: ${change.label}`).join(", ")} is pinned. Unpin it first.`);
  try {
    const done = applyWithPins(store, owner, changes, {
      accept: changes.map((change) => change.id), confirmLoosening: choice.confirmLoosening,
      why: `undo of a change made ${record.at}`, pinnedAllowed: false, writers: choice.writers,
      record: { writer: "owner-in-window", source: "undo", detail: record.id, undoes: record.id },
    });
    return { applied: done.applied, record: done.record ?? null };
  } catch (error) { throw new UndoRefused(409, (error as Error).message); }
}

export type WhyKind = "recorded" | "changed-since" | "starting-value" | "not-recorded";
export interface WhyAnswer {
  setting: string;
  value: Value;
  startsAs: Value;
  kind: WhyKind;
  /** The record the answer comes from, when there is one. */
  record: (Pick<ChangeRecord, "id" | "at" | "writer" | "source" | "detail" | "runId" | "sessionId" | "undoes"> & { before: Value; after: Value }) | null;
  words: string;
}

const byWhom: Record<ChangeRecord["source"], string> = {
  switch: "you, moving the switch in Settings",
  preset: "a preset",
  reset: "putting settings back to how they started",
  import: "a settings file you brought in",
  talk: "a conversation, when you asked for it",
  undo: "undoing an earlier change",
  unknown: "a change whose source was not recorded",
};

function wordsFor(kind: WhyKind, value: Value, found: ReturnType<typeof lastChangeOf>): string {
  if (kind === "starting-value") return `It is ${String(value)}, how it starts. No change to it was recorded.`;
  if (kind === "not-recorded") return `It is ${String(value)}. Nothing was recorded about who or what set it.`;
  const { record, entry } = found!;
  const how = `${byWhom[record.source]}${record.source === "preset" && record.detail ? ` (${record.detail})` : ""}`;
  if (kind === "changed-since")
    return `It is ${String(value)}. The last recorded change set it to ${String(entry.after)} (${how}, ${record.at}), but it was changed again since by something that keeps no record.`;
  return `It is ${String(value)}, set by ${how} on ${record.at}.`;
}

/** Q49: who or what last set this setting, from the change records only. */
export function whySetting(store: Store, owner: string, setting: string): WhyAnswer | undefined {
  const dot = setting.indexOf(".");
  const spec = dot > 0 ? specFor(setting.slice(0, dot)) : undefined;
  const field = spec?.fields.find((entry) => entry.field === setting.slice(dot + 1));
  if (!spec || !field) return undefined;
  const value = currentValue(store, owner, spec, field);
  const found = lastChangeOf(store, owner, setting);
  const kind: WhyKind = found ? (found.entry.after === value ? "recorded" : "changed-since")
    : value === field.initial ? "starting-value" : "not-recorded";
  const record = found ? {
    id: found.record.id, at: found.record.at, writer: found.record.writer, source: found.record.source, detail: found.record.detail,
    runId: found.record.runId, sessionId: found.record.sessionId, undoes: found.record.undoes, before: found.entry.before, after: found.entry.after,
  } : null;
  return { setting, value, startsAs: field.initial, kind, record, words: wordsFor(kind, value, found) };
}
