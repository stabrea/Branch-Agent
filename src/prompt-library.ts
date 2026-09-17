/**
 * The things you ask for often, saved once and kept where you can find them.
 *
 * Everybody who uses an assistant for real work ends up retyping the same half-page. "Read this
 * week's numbers and tell me what moved." "Take these notes and write the follow-up email in my
 * voice." They are not procedures — there are no steps, nothing runs by itself, no schedule — they
 * are simply the asking, written well once instead of badly every time.
 *
 * A prompt here is a name, the words, and a group to file it under. The words may carry
 * `{{placeholders}}`, which are declared the same way a procedure declares its inputs and filled
 * the same way, through `recipes.ts` — one templating system in the app, not two, so a placeholder
 * behaves identically wherever the owner meets it.
 *
 * Groups are a plain string rather than a structure of their own. A folder tree is what you build
 * when you expect hundreds; nobody has hundreds of these, and a tree costs the owner a decision
 * every time they save one. A group is typed or picked, renaming a group renames it everywhere,
 * and an empty group stops existing.
 *
 * What this deliberately does not do is run anything. `prompts.use` hands back the finished words
 * for the owner or the model to send; it never starts a task on its own. A saved prompt that could
 * run itself is a schedule, and schedules live somewhere else with their own approvals.
 */
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { bindInputs, InputsSchema, ParametersSchema, placeholders, substitute, type InputValue } from "./recipes.js";

export const maximumPrompts = 500;

export const PromptSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Where it is filed. Empty means the group everything starts in. */
  group: z.string().trim().max(60).default(""),
  /** What it asks for. Long enough for a real brief, short enough that it is a prompt and not a document. */
  text: z.string().trim().min(1).max(8000),
  /** One line for the list, so the owner can tell two similar ones apart without opening either. */
  description: z.string().trim().max(300).default(""),
  /** Declared the same way a procedure declares its inputs, and filled the same way. */
  parameters: ParametersSchema.default({}),
}).strict();
export type Prompt = z.infer<typeof PromptSchema>;
export interface SavedPrompt extends Prompt { id: string; updatedAt: string }

const ungrouped = "Everything else";

function read(record: { id: string; data: Record<string, unknown>; updatedAt: string }): SavedPrompt | null {
  const parsed = PromptSchema.safeParse(record.data);
  return parsed.success ? { ...parsed.data, id: record.id, updatedAt: record.updatedAt } : null;
}

/** Every saved prompt, newest first within each group, groups in the owner's own alphabetical order. */
export function prompts(store: Store, owner: string): SavedPrompt[] {
  return store.list("prompts", owner).map(read).filter((entry): entry is SavedPrompt => entry !== null)
    .sort((a, b) => (a.group || ungrouped).localeCompare(b.group || ungrouped)
      || b.updatedAt.localeCompare(a.updatedAt));
}

/** The groups in use, each with how many are in it, so a picker can offer them without inventing any. */
export function promptGroups(store: Store, owner: string): { name: string; count: number }[] {
  const counted = new Map<string, number>();
  for (const entry of prompts(store, owner)) {
    const name = entry.group || ungrouped;
    counted.set(name, (counted.get(name) ?? 0) + 1);
  }
  return [...counted].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Saves one, refusing a placeholder that was never declared.
 *
 * Catching it here rather than when the prompt is used is the whole point: the owner is looking at
 * the words they just wrote, so "you wrote {{quarter}} but never said what it is" is a sentence
 * they can act on. A week later, mid-task, it is a puzzle.
 */
export function savePrompt(store: Store, owner: string, id: string, input: unknown): SavedPrompt {
  const value = PromptSchema.parse(input);
  const declared = new Set(Object.keys(value.parameters));
  const used = [...placeholders(value.text)].filter((name) => !declared.has(name));
  if (used.length) throw new Error(`These are written in the prompt but never declared: ${used.join(", ")}`);
  const existing = store.get("prompts", owner, id);
  if (!existing && store.list("prompts", owner).length >= maximumPrompts)
    throw new Error(`There is room for ${maximumPrompts} saved prompts. Remove one before adding another.`);
  const clash = prompts(store, owner).find((entry) =>
    entry.id !== id && entry.name.toLowerCase() === value.name.toLowerCase() && entry.group === value.group);
  if (clash) throw new Error(`"${value.name}" is already saved in that group.`);
  store.save("prompts", owner, id, value);
  return { ...value, id, updatedAt: store.get("prompts", owner, id)!.updatedAt };
}

export function removePrompt(store: Store, owner: string, id: string): { removed: boolean } {
  return { removed: store.delete("prompts", owner, id) };
}

/** Renames a group everywhere at once, because renaming them one at a time is how they drift apart. */
export function renameGroup(store: Store, owner: string, from: string, to: string): { moved: number } {
  const target = z.string().trim().max(60).parse(to);
  let moved = 0;
  for (const entry of prompts(store, owner)) {
    if ((entry.group || ungrouped) !== from) continue;
    const { id, updatedAt: _at, ...rest } = entry;
    store.save("prompts", owner, id, { ...rest, group: target });
    moved++;
  }
  return { moved };
}

/** The finished words, with every placeholder filled. It does not send them anywhere. */
export function savedPromptText(store: Store, owner: string, id: string, inputs: Record<string, InputValue> = {}): string {
  const record = store.get("prompts", owner, id);
  const saved = record && read(record);
  if (!saved) throw new Error("That saved prompt is not there.");
  return substitute(saved.text, bindInputs(saved.parameters, inputs));
}

export function registerPrompts(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: "prompts.list",
    description: "List the owner's saved prompts with their groups and what each one asks for. Does not send any of them.",
    permission: "memory.read", parameters: z.object({ group: z.string().max(60).optional() }).strict(),
    execute: async ({ group }, context: ToolContext) => {
      const all = prompts(store, context.owner);
      const shown = group ? all.filter((entry) => (entry.group || ungrouped) === group) : all;
      return shown.map(({ text: _text, ...rest }) => rest);
    },
  });
  registry.register({
    name: "prompts.use",
    description: "Read one saved prompt with its placeholders filled in. Returns the words; it does not start a task.",
    permission: "memory.read",
    parameters: z.object({ id: z.string().min(1).max(200), inputs: InputsSchema.optional() }).strict(),
    execute: async ({ id, inputs }, context: ToolContext) => {
      const text = savedPromptText(store, context.owner, id, inputs ?? {});
      store.event(context.runId, "prompts.used", { id, characters: text.length });
      return { text };
    },
  });
}
