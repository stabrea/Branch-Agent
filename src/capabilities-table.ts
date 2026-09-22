import type { Store } from "./store.js";
import { toolFeatures, type CapabilityGroup, type FeatureMode } from "./feature-switches.js";
import { addOnLabels, addOnMode, addOnParts } from "./add-ons/settings.js";
import { askKey, askLabels, askMode, askParts } from "./asks/settings.js";
import { autonomyKey, autonomyLabels, autonomyMode, autonomyParts } from "./autonomy/settings.js";
import { codingKey, codingLabels, codingMode, codingParts } from "./coding/settings.js";
import { boardKey, boardLabels, boardMode, boardParts } from "./flows-boards/settings.js";
import { interopKey, interopLabels, interopMode, interopParts } from "./interop/settings.js";
import { learningKey, learningLabels, learningMode, learningParts } from "./learning-more/settings.js";
import { personalKey, personalLabels, personalMode, personalParts } from "./personal/settings.js";
import { reachKey, reachLabels, reachMode, reachParts } from "./reach/settings.js";
import { safetyKey, safetyLabels, safetyMode, safetyParts } from "./safety-extras/settings.js";
import { trunkKey, trunkLabels, trunkMode, trunkParts } from "./trunks/settings.js";
import { contextFileSettings, slots, switchFor } from "./context-files.js";

/**
 * Owner item 17: every capability the Capabilities page promises, in one table built from each
 * module's own lists, so nothing can be added to a module without appearing here. It holds every
 * part of the parts modules (tool-less ones too: Trunks itself, Rooms, routines, teaching …), every
 * single-feature switch that brings tools, and every file the assistant can read before a task.
 *
 * Not here: switches whose three positions mean something other than "can it do this" (how much the
 * diagnostic log keeps, how the loop guard or folder trust behaves). Those stay on their own pages.
 */
type Reader = Pick<Store, "get">;
export type CapabilityGroupName = CapabilityGroup | "files";
type Setter = { setMode(part: string, input: unknown): unknown };
/**
 * The running modules, each switched through its own setter so the change takes effect at once: its
 * tools come and go in the live registry, and switching off runs its cleanup (cancelling work,
 * disconnecting, stopping). These are the objects `createBranch` hands back.
 */
export interface LiveModules {
  trunks: Setter; interop: Setter; asks: Setter; autonomy: Setter; safetyExtras: Setter; flowsBoards: Setter; learningMore: Setter;
  coding: { setMode(part: string, mode: FeatureMode): unknown };
  personal: { setMode(part: string, input: unknown): Promise<unknown> };
  reachParts: { setMode(part: string, input: unknown): Promise<unknown> };
  addOns: { save(input: unknown): unknown };
  learn: { save(input: unknown): unknown };
  devices: { setMode(input: unknown): unknown };
}
export interface Capability {
  /** The row's key: the settings record, `record#field`, `add-ons:<part>` or `context-files:<slot>`. */
  id: string;
  group: CapabilityGroupName;
  /** Its name in the owner's words, in English; the page shows `capabilities.label.<id>`. */
  label: string;
  tools: readonly string[];
  /** Another capability this one only works with (Trunks' parts need Trunks). */
  needs?: string;
  /** What is in use: the module's own reader, so dependencies and Lockdown are counted. */
  effective: (store: Reader, owner: string) => FeatureMode;
  /** Switches it through the live module; absent for a switch that is only ever read fresh per task. */
  live?: (modules: LiveModules, mode: FeatureMode) => unknown | Promise<unknown>;
}

/** The key a capability's name has in the language files. */
export const labelKeyOf = (id: string): string => `capabilities.label.${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

interface PartsModule<P extends string> {
  parts: readonly P[]; key: (part: P) => string; labels: Record<P, string>;
  mode: (store: Reader, owner: string, part: P) => FeatureMode; group: CapabilityGroupName; root?: P;
  live: (modules: LiveModules, part: P, mode: FeatureMode) => unknown | Promise<unknown>;
}
const toolsOf = new Map(toolFeatures.map((feature) => [feature.field && feature.field !== "mode" ? `${feature.key}#${feature.field}` : feature.key, feature.tools]));

function fromModule<P extends string>(module: PartsModule<P>): Capability[] {
  return module.parts.map((part) => {
    const id = module.key(part);
    return {
      id, group: module.group, label: module.labels[part], tools: toolsOf.get(id) ?? [],
      ...(module.root && part !== module.root ? { needs: module.key(module.root) } : {}),
      effective: (store: Reader, owner: string) => module.mode(store, owner, part),
      live: (modules: LiveModules, mode: FeatureMode) => module.live(modules, part, mode),
    };
  });
}

const modules = [
  fromModule({ parts: trunkParts, key: trunkKey, labels: trunkLabels, mode: trunkMode, group: "trunks", root: "trunks", live: (m, part, mode) => m.trunks.setMode(part, { mode }) }),
  fromModule({ parts: interopParts, key: interopKey, labels: interopLabels, mode: interopMode, group: "agents", live: (m, part, mode) => m.interop.setMode(part, { mode }) }),
  fromModule({ parts: askParts, key: askKey, labels: askLabels, mode: askMode, group: "helpers", live: (m, part, mode) => m.asks.setMode(part, { mode }) }),
  fromModule({ parts: autonomyParts, key: autonomyKey, labels: autonomyLabels, mode: autonomyMode, group: "automations", live: (m, part, mode) => m.autonomy.setMode(part, { mode }) }),
  fromModule({ parts: codingParts, key: codingKey, labels: codingLabels, mode: codingMode, group: "work", live: (m, part, mode) => m.coding.setMode(part, mode) }),
  fromModule({ parts: personalParts, key: personalKey, labels: personalLabels, mode: personalMode, group: "accounts", live: (m, part, mode) => m.personal.setMode(part, { mode }) }),
  fromModule({ parts: reachParts, key: reachKey, labels: reachLabels, mode: reachMode, group: "reach", live: (m, part, mode) => m.reachParts.setMode(part, { mode }) }),
  fromModule({ parts: safetyParts, key: safetyKey, labels: safetyLabels, mode: safetyMode, group: "safety", live: (m, part, mode) => m.safetyExtras.setMode(part, { mode }) }),
  fromModule({ parts: boardParts, key: boardKey, labels: boardLabels, mode: boardMode, group: "flows", live: (m, part, mode) => m.flowsBoards.setMode(part, { mode }) }),
  fromModule({ parts: learningParts, key: learningKey, labels: learningLabels, mode: learningMode, group: "memory", live: (m, part, mode) => m.learningMore.setMode(part, { mode }) }),
  fromModule({ parts: addOnParts, key: (part) => `add-ons:${part}`, labels: addOnLabels, mode: addOnMode, group: "add-ons", live: (m, part, mode) => m.addOns.save({ modes: { [part]: mode } }) }),
].flat();

/** A tool switch of its own ("page notes are switched on") named the way the page names it. */
const nameOf = (reason: string): string => {
  const words = reason.replace(/ (is|are) switched on$/, "");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const inModules = new Set(modules.map((entry) => entry.id));
/** The single switches with a running side (the rest are read fresh by every task, so saving is all). */
const singleSetters: Record<string, (modules: LiveModules, mode: FeatureMode) => unknown> = {
  "devices-book": (m, mode) => m.devices.setMode({ mode }),
  learn: (m, mode) => m.learn.save({ mode }),
};
const singles: Capability[] = toolFeatures
  .map((feature) => ({ feature, id: feature.field && feature.field !== "mode" ? `${feature.key}#${feature.field}` : feature.key }))
  .filter(({ id }) => !inModules.has(id))
  .map(({ feature, id }) => ({ id, group: feature.group, label: nameOf(feature.reason), tools: feature.tools, effective: feature.mode,
    ...(singleSetters[id] ? { live: singleSetters[id] } : {}) }));

const files: Capability[] = slots.map((slot) => ({
  id: `context-files:${slot.key}`, group: "files", label: `${slot.names[0]}: ${slot.about}`, tools: [],
  effective: (store: Reader, owner: string) => switchFor(contextFileSettings(store, owner), slot.key),
}));

/** Every capability the page shows, each once. */
export const capabilities: readonly Capability[] = [...singles, ...modules, ...files];
