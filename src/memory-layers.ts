import { z } from "zod";
import type { MemoryRecord } from "./memory.js";

/**
 * What kind of thing a saved fact is, and how long it is meant to last. Both were implicit before:
 * every fact was simply "something the assistant knows", and all of them competed for the same
 * space in front of a task. Saying it out loud lets the assistant put a lasting preference ahead of
 * a note it scribbled while doing one job, and lets the scribble be thrown away when the job ends.
 *
 * Nothing already saved has to change: a fact with no kind is treated as a fact about the world,
 * and a fact with no layer is treated as long-term, which is exactly how they behaved before.
 */
export const factKinds = [
  "preference", "fact-about-person", "fact-about-world", "procedure-hint", "project-note", "task-scratch",
] as const;
export type FactKind = (typeof factKinds)[number];
/** working: only this conversation. task: only this job. long-term: kept until the owner forgets it. */
export const memoryLayers = ["working", "task", "long-term"] as const;
export type MemoryLayer = (typeof memoryLayers)[number];
export const FactKindSchema = z.enum(factKinds);
export const MemoryLayerSchema = z.enum(memoryLayers);

/** What a fact with no kind of its own counts as: something about the world. */
export const defaultKind: FactKind = "fact-about-world";
/** What a fact with no layer of its own counts as: something kept for good. */
export const defaultLayer: MemoryLayer = "long-term";
/** Where a kind belongs when the caller does not say: only a scribble is short-lived. */
export const layerForKind = (kind: FactKind): MemoryLayer => (kind === "task-scratch" ? "task" : "long-term");

interface Layered { kind?: unknown; layer?: unknown; project?: unknown; promoted?: unknown }
export const factKindOf = (record: MemoryRecord): FactKind =>
  FactKindSchema.safeParse((record.data as Layered).kind).data ?? defaultKind;
export const layerOf = (record: MemoryRecord): MemoryLayer =>
  MemoryLayerSchema.safeParse((record.data as Layered).layer).data ?? defaultLayer;
/** The project a fact belongs to, or nothing when it is not tied to one. */
export const projectOf = (record: MemoryRecord): string =>
  typeof (record.data as Layered).project === "string" ? String((record.data as Layered).project) : "";
/** Whether the owner asked for this scribble to be kept, which stops the task from clearing it. */
export const isPromoted = (record: MemoryRecord): boolean => (record.data as Layered).promoted === true;

/**
 * Whether a fact should be read while working on a given project. A fact tied to no project is
 * always in; a fact tied to one is in only while that project is the one being worked on.
 */
export const inProject = (record: MemoryRecord, project?: string): boolean => {
  const tied = projectOf(record);
  return !tied || !project || tied.toLowerCase() === project.toLowerCase();
};

/**
 * How much of the space in front of a task each layer may take, and in which order. The order is
 * what makes the rule easy to explain: what is happening now comes first, then the job in hand,
 * then everything the assistant knows for good. Each layer is capped so a busy conversation can
 * never crowd out every lasting preference.
 */
export const injectionOrder: MemoryLayer[] = ["working", "task", "long-term"];
export const layerBudget: Record<MemoryLayer, number> = { working: 6, task: 4, "long-term": 20 };

export interface InjectionChoice { records: MemoryRecord[]; perLayer: Record<MemoryLayer, number> }
/**
 * The facts to put in front of a task, taken layer by layer in the documented order and stopped by
 * whichever runs out first: that layer's own cap, the total number of facts, or the space allowed.
 * The records handed in are already in the order the assistant prefers them within a layer.
 */
export function chooseForInjection(
  records: MemoryRecord[], limits: { facts: number; chars: number }, project?: string,
): InjectionChoice {
  const chosen: MemoryRecord[] = [];
  const perLayer: Record<MemoryLayer, number> = { working: 0, task: 0, "long-term": 0 };
  let chars = 0;
  for (const layer of injectionOrder)
    for (const record of records.filter((entry) => layerOf(entry) === layer && inProject(entry, project))) {
      const size = String(record.data.text).replace(/\s+/g, " ").trim().length + 3;
      if (perLayer[layer] >= layerBudget[layer] || chosen.length >= limits.facts || chars + size > limits.chars) break;
      chosen.push(record); perLayer[layer]++; chars += size;
    }
  return { records: chosen, perLayer };
}

/** How the store is made up right now, for the diagnostics folder and the Memory screen. */
export interface MemoryHealth {
  facts: number;
  byKind: Record<string, number>;
  byLayer: Record<string, number>;
  /** Scribbles still waiting for the job that made them to finish. */
  taskScratch: number;
  /** Scribbles the owner asked to keep, which the job that made them no longer clears. */
  keptScratch: number;
  /** Facts nothing has ever drawn on, which is what tidying looks at first. */
  neverUsed: number;
  archived: number;
  capacity: { count: number; maxFacts: number };
}
/** Counts only: no wording of any fact goes into this, so it is safe to hand to someone helping. */
export function memoryHealth(
  records: MemoryRecord[], uses: Map<string, number>, archived: number, capacity: { count: number; maxFacts: number },
): MemoryHealth {
  const byKind: Record<string, number> = {}, byLayer: Record<string, number> = {};
  for (const record of records) {
    byKind[factKindOf(record)] = (byKind[factKindOf(record)] ?? 0) + 1;
    byLayer[layerOf(record)] = (byLayer[layerOf(record)] ?? 0) + 1;
  }
  return {
    facts: records.length, byKind, byLayer,
    taskScratch: records.filter((record) => layerOf(record) === "task").length,
    keptScratch: records.filter(isPromoted).length,
    neverUsed: records.filter((record) => !(uses.get(record.id) ?? 0)).length,
    archived, capacity,
  };
}
