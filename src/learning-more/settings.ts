import { z } from "zod";
import type { Store } from "../store.js";

/**
 * R17-F (wave mac7): "Learning, deeper". Nine parts, each with the owner's three-way switch — off,
 * when needed, on — kept in a settings record of its own, and every one ships off.
 *
 *   off          the part refuses in one plain sentence, and its tools are not offered
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, its tools are loaded from the first round, and what it adds to the
 *                start of a conversation (memory blocks, lessons) is put there
 *
 * This file imports nothing from Branch but the store type, so src/feature-switches.ts can read it.
 */
export const learningParts = [
  "blocks", "curator", "journey", "meaning-search", "lessons", "session-lessons", "expiry", "readback", "providers",
] as const;
export type LearningPart = (typeof learningParts)[number];
export const LearningPartSchema = z.enum(learningParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type LearningMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

/** The switch's record. A part's own settings use a different key (ending in "-settings" or naming what they hold). */
export const learningKey = (part: LearningPart): string => `learning-more-${part}`;

/** What each part is, in the owner's words: the card title and the refusal. */
export const learningLabels: Record<LearningPart, string> = {
  blocks: "Memory blocks the assistant can edit",
  curator: "How often each skill is used, and merging look-alikes",
  journey: "A timeline of what was learned",
  "meaning-search": "Finding past conversations by meaning",
  lessons: "Learning from failed evaluation tasks",
  "session-lessons": "Learning your preferences from Claude Code and Codex",
  expiry: "Memories that expire, with tags and dates",
  readback: "Reading your edits to the memory notes back",
  providers: "Outside memory services",
};

/** The tools each part owns, so the catalog leaves them out while the part is off. */
export const learningTools: Record<LearningPart, readonly string[]> = {
  blocks: ["memory.block_view", "memory.block_edit"],
  curator: ["skills.usage"],
  journey: ["learning.journey"],
  "meaning-search": ["history.meaning"],
  lessons: ["lessons.list"],
  "session-lessons": [],
  expiry: ["memory.find", "memory.label"],
  readback: [],
  providers: ["memory.outside_recall", "memory.outside_keep", "memory.outside_ask"],
};

/** For src/feature-switches.ts: each part with tools — its record, why it is loaded, and its tools. */
export const learningToolFeatures: readonly (readonly [string, string, readonly string[]])[] = learningParts
  .filter((part) => learningTools[part].length > 0)
  .map((part) => [learningKey(part), `${learningLabels[part].charAt(0).toLowerCase()}${learningLabels[part].slice(1)} is switched on`, learningTools[part]] as const);

type Reader = Pick<Store, "get">;

export function learningMode(store: Reader, owner: string, part: LearningPart): LearningMode {
  const saved = RecordSchema.safeParse(store.get("settings", owner, learningKey(part))?.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function allLearningModes(store: Reader, owner: string): Record<LearningPart, LearningMode> {
  return Object.fromEntries(learningParts.map((part) => [part, learningMode(store, owner, part)])) as Record<LearningPart, LearningMode>;
}

export function saveLearningMode(store: Store, owner: string, part: LearningPart, input: unknown): LearningMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, learningKey(part), { mode });
  return mode;
}

export class LearningOffError extends Error {
  override name = "LearningOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireLearning(store: Reader, owner: string, part: LearningPart): void {
  if (learningMode(store, owner, part) === "off")
    throw new LearningOffError(`${learningLabels[part]} is switched off. The owner can switch it on in Branch.`);
}

/** A part's own settings record (not its switch), read through a schema with defaults. */
export function learningSettings<T>(store: Reader, owner: string, key: string, schema: z.ZodType<T>): T {
  const saved = schema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : schema.parse({});
}

/** Saves a part's own settings: fields left out keep what was there. */
export function saveLearningSettings<T extends Record<string, unknown>>(store: Store, owner: string, key: string, schema: z.ZodType<T>, input: unknown): T {
  const value = schema.parse({ ...learningSettings(store, owner, key, schema), ...(input && typeof input === "object" ? input : {}) });
  store.save("settings", owner, key, value);
  return value;
}
