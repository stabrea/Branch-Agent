import { basename } from "node:path";
import type { StatusItem } from "./settings.js";

/**
 * R17-S16: the status line, built from the pieces the owner picked. The window and the terminal
 * both use this, so the two always say the same thing in the same order.
 */
export interface StatusFacts {
  /** The model's display name. */
  model: string;
  /** Tokens used so far in this conversation, and how many fit. */
  used: number;
  room: number;
  /** The folder the assistant works in. */
  folder: string;
  /** What the conversation has cost, already in words ("$0.0123", "no price on file"). */
  cost: string;
  now: Date;
}
/** The room the status line measures against when nothing else is known. */
export const defaultRoom = 128000;

export interface StatusWords { t(key: string, english: string, values?: Record<string, string | number>): string }
const plain: StatusWords = { t: (_key, english, values) => english.replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name] ?? "")) };

/** One piece in words. */
export function statusPiece(item: StatusItem, facts: StatusFacts, words: StatusWords = plain): string {
  switch (item) {
    case "model": return facts.model;
    case "context": {
      const share = Math.max(0, Math.min(100, Math.round((facts.used / (facts.room || defaultRoom)) * 100)));
      return words.t("comfort.status.context", "{percent}% of the room used", { percent: share });
    }
    case "folder": return basename(facts.folder) || facts.folder;
    case "cost": return facts.cost;
    case "time": return facts.now.toTimeString().slice(0, 5);
  }
}

/** The whole line, or null when the owner kept the line as it has always been. */
export function statusLineText(items: readonly StatusItem[] | null, facts: StatusFacts, words?: StatusWords, dot = "·"): string | null {
  if (items === null) return null;
  return items.map((item) => statusPiece(item, facts, words)).filter(Boolean).join(` ${dot} `);
}
