import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { contextOf, FlyCore, type MemoryAdvice, type Suggestions } from "./hook.js";
import { flyCoreSettings, saveFlyCoreSettings, suggestToolName, type FlyCoreSettings } from "./settings.js";

/**
 * The on-demand side of the learning core: one read-only tool the model can ask, while working,
 * what has worked before in situations like this one. It is advertised while the switch of the
 * owner the app was started for is not off; when it is called, the switch that decides is the one
 * of the owner whose task is asking, so a person who has it off is never read or written for.
 */
export const switchedOffAnswer = "The learning core is switched off for this person, so it has nothing to suggest.";
const SuggestSchema = z.object({
  /** What the work is about, in a few words; the current task's request when left out. */
  request: z.string().trim().max(2000).optional(),
}).strict();

export function registerSuggestTool(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: suggestToolName, group: "memory", permission: "memory.read", parameters: SuggestSchema,
    description: "What worked before in tasks like this: tools, skills and memories to try or avoid.",
    execute: async (value, context): Promise<(Suggestions & { memoryAdvice: MemoryAdvice }) | { off: true; note: string }> => {
      if (flyCoreSettings(store, context.owner).mode === "off") return { off: true, note: switchedOffAnswer };
      const core = new FlyCore(store);
      const run = store.run(context.runId);
      const situation = run ? contextOf(store, run) : { prompt: "" };
      const code = core.code(context.owner, { ...situation, prompt: value.request ?? situation.prompt });
      return { ...core.suggest(context.owner, code), memoryAdvice: core.memoryAdvice(context.owner) };
    },
  });
}

/** Makes the tool match the saved switch: present unless it is off. */
export function syncSuggestTool(registry: ToolRegistry, store: Store, owner: string): void {
  registry.unregister(suggestToolName);
  if (flyCoreSettings(store, owner).mode !== "off") registerSuggestTool(registry, store);
}

/** Saves the switch and adds or removes the tool at once. */
export function setFlyCoreMode(store: Store, owner: string, input: unknown, registry: ToolRegistry): FlyCoreSettings {
  const saved = saveFlyCoreSettings(store, owner, input);
  syncSuggestTool(registry, store, owner);
  return saved;
}
