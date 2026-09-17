import { z } from "zod";
import type { Store } from "./store.js";
import type { ActionKind } from "./fly-core/circuit.js";
import { flyCoreSettings, type FlyCoreSettings } from "./fly-core/settings.js";
import { FlyState } from "./fly-core/state.js";
import { dropIndex } from "./fly-core/fast-index.js";

/**
 * The owner's side of the learning core (src/fly-core): the three-way switch, what it has learned
 * in plain terms, and forgetting all of it. The web routes are one block in src/server.ts.
 *
 *   GET  /api/learning-core            the switch, how much is kept, and the top habits
 *   POST /api/learning-core/settings   { mode: "off" | "when-needed" | "on" }
 *   POST /api/learning-core/forget     { confirm: "forget" }
 *
 * Reading never creates the core's tables: with the switch off and nothing learned, nothing is made.
 */
export interface Habit {
  kind: ActionKind;
  /** What the owner would call it: the tool's name, the skill's name, or the start of the note. */
  name: string;
  /** Tasks it was part of. */
  uses: number;
  /** How those tasks tended to go: mostly well, mostly badly, or mixed. */
  leaning: "well" | "badly" | "mixed";
}
export interface LearningCoreView {
  settings: FlyCoreSettings;
  kept: { actions: number; traces: number; patterns: number };
  habits: Habit[];
}
export const habitsShown = 12;
/** Uses before a habit is shown: one task is not a habit. */
export const habitUsesNeeded = 2;

export class LearningCoreApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const hasTables = (store: Store): boolean =>
  !!store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fly_synapses'").get();

function leaningOf(net: number, uses: number): Habit["leaning"] {
  const average = uses ? net / uses : 0;
  return average >= 0.3 ? "well" : average <= -0.3 ? "badly" : "mixed";
}

/** A name the owner recognises, or nothing when the thing it was about is gone. */
function nameOf(store: Store, owner: string, kind: ActionKind, action: string, skills: Map<string, string>): string | null {
  if (kind === "tool") return action;
  if (kind === "skill") return skills.get(action) ?? null;
  const text = String((store.get("memory", owner, action)?.data as { text?: unknown } | undefined)?.text ?? "").replace(/\s+/g, " ").trim();
  return text ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : null;
}

export function learningCoreView(store: Store, owner: string): LearningCoreView {
  const settings = flyCoreSettings(store, owner);
  if (!hasTables(store)) return { settings, kept: { actions: 0, traces: 0, patterns: 0 }, habits: [] };
  const state = new FlyState(store.sqlite);
  const skills = new Map(store.skills.list(owner).map((skill) => [skill.id, skill.name]));
  const habits: Habit[] = [];
  for (const habit of state.habits(owner)) {
    if (habits.length >= habitsShown) break;
    if (habit.uses < habitUsesNeeded) continue;
    const name = nameOf(store, owner, habit.kind, habit.action, skills);
    if (name) habits.push({ kind: habit.kind, name, uses: habit.uses, leaning: leaningOf(habit.net, habit.uses) });
  }
  return { settings, kept: state.counts(owner), habits };
}

/** Clears every `fly_*` row for the owner, the wiring seed included. */
export function forgetLearning(store: Store, owner: string): { removed: number } {
  if (!hasTables(store)) return { removed: 0 };
  const removed = new FlyState(store.sqlite).forget(owner);
  dropIndex(store.sqlite, owner);
  return { removed };
}

const ForgetSchema = z.object({ confirm: z.literal("forget") }).strict();
export interface LearningCoreDeps {
  store: Store;
  owner: string;
  configure: (input: unknown) => FlyCoreSettings;
}

export const handlesLearningCorePath = (path: string): boolean =>
  path === "/api/learning-core" || path.startsWith("/api/learning-core/");

export async function learningCoreApi(deps: LearningCoreDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (method === "GET" && path === "/api/learning-core") return learningCoreView(deps.store, deps.owner);
  if (method === "POST" && path === "/api/learning-core/settings") {
    deps.configure(await body());
    return learningCoreView(deps.store, deps.owner);
  }
  if (method === "POST" && path === "/api/learning-core/forget") {
    const parsed = ForgetSchema.safeParse(await body());
    if (!parsed.success) throw new LearningCoreApiError(400, "Say { \"confirm\": \"forget\" } to forget what the learning core has learned");
    return { ...forgetLearning(deps.store, deps.owner), ...learningCoreView(deps.store, deps.owner) };
  }
  throw new LearningCoreApiError(404, "Endpoint not found");
}
