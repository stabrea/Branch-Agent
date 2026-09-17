import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { errorText, type ToolContext } from "../contracts.js";
import { integrationsFileTrusted } from "../folder-trust.js";
import { isReadOnlyPermission } from "../policy.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import type { Store } from "../store.js";
import { requireInterop } from "./settings.js";

/**
 * Ways of working ("modes"): a named role with its own instructions and its own reach — which
 * toolboxes it may open, and whether it may change anything. Five come built in (Ask, Architect,
 * Code, Debug, Orchestrator); the owner adds their own in Customize, and a project folder the owner
 * trusts may add more in `.branch/modes.json`. A mode only ever narrows what the task that uses it
 * could already do.
 *
 * `mode.task` is the "boomerang": the task in front of the model sends a piece of work to another
 * mode, that mode works on it with its own reach and instructions, and its summary comes back to the
 * task that sent it, which carries on. The Orchestrator mode does nothing else. The ideas come from
 * Roo Code's custom modes and its new_task tool; this is an independent implementation.
 */
export const modesFile = join(".branch", "modes.json");
const maxModes = 30;

export const ModeSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "A mode's short name is lower-case letters, digits and dashes"),
  name: z.string().trim().min(1).max(60),
  /** Who the assistant is while working this way. */
  role: z.string().trim().min(1).max(2000),
  /** One line the orchestrator reads when choosing a mode. */
  whenToUse: z.string().trim().max(300).default(""),
  /** Toolboxes this mode may open; empty means every toolbox the task already has. */
  groups: z.array(z.string().regex(/^[a-z]+$/)).max(20).default([]),
  /** Looks and answers only; every permission that can change something is taken away. */
  readOnly: z.boolean().default(false),
  instructions: z.string().max(4000).default(""),
}).strict();
export type Mode = z.infer<typeof ModeSchema>;
export type ModeOrigin = "built-in" | "yours" | "this folder";
export interface ModeView extends Mode { origin: ModeOrigin }

const FileSchema = z.object({ modes: z.array(ModeSchema).max(maxModes) }).strict();

export const builtInModes: Mode[] = [
  { slug: "ask", name: "Ask", role: "You answer questions and explain things. You never change anything.",
    whenToUse: "Questions, explanations, looking something up.", groups: [], readOnly: true, instructions: "" },
  { slug: "architect", name: "Architect", role: "You plan before anything is built: you read, weigh the options and write a short plan with the steps in order.",
    whenToUse: "Designing or planning a change before it is made.", groups: [], readOnly: true, instructions: "End with a numbered plan." },
  { slug: "code", name: "Code", role: "You write and change code, one reversible change at a time.",
    whenToUse: "Writing, changing or refactoring code.", groups: ["code", "git", "files"], readOnly: false,
    instructions: "Read before you write, and say what the project's check said afterwards." },
  { slug: "debug", name: "Debug", role: "You find out why something is broken: reproduce it, narrow it down, then fix the cause.",
    whenToUse: "Something fails and the reason is not known.", groups: ["code", "git", "files"], readOnly: false,
    instructions: "Say what the cause was before you say what you changed." },
  { slug: "orchestrator", name: "Orchestrator", role: "You split a large job into pieces and send each piece to the mode best suited to it with mode.task. You do none of the pieces yourself.",
    whenToUse: "Large jobs with several different kinds of work.", groups: ["agents"], readOnly: false,
    instructions: "Send one piece at a time, read the summary that comes back, then decide the next piece. Finish with what was done." },
];

export class Modes {
  constructor(private readonly store: Store, private readonly owner: string, private readonly workspace: string) {}

  private saved(): Mode[] {
    const data = this.store.get("settings", this.owner, "interop-modes-list")?.data;
    const parsed = FileSchema.safeParse(data ?? { modes: [] });
    return parsed.success ? parsed.data.modes : [];
  }
  /** Modes a trusted project folder brings. A folder the owner has not trusted brings none. */
  folderModes(): Mode[] {
    const file = join(this.workspace, modesFile);
    try {
      if (statSync(file).size > 64 * 1024) return [];
      // A `.branch` that links out of the folder is not the folder's own file, and the trust check
      // below treats a file outside the workspace as the owner's, so it must not get that far.
      const inside = relative(realpathSync(this.workspace), realpathSync(file));
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) return [];
      if (!integrationsFileTrusted(this.store, this.owner, this.workspace, file)) return [];
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? parsed.data.modes : [];
    } catch { return []; }
  }
  /** Every mode, later ones replacing earlier ones of the same short name: built in, yours, then the folder's. */
  list(): ModeView[] {
    const all = new Map<string, ModeView>();
    for (const mode of builtInModes) all.set(mode.slug, { ...mode, origin: "built-in" });
    for (const mode of this.saved()) all.set(mode.slug, { ...mode, origin: "yours" });
    for (const mode of this.folderModes()) all.set(mode.slug, { ...mode, origin: "this folder" });
    return [...all.values()];
  }
  find(slug: string): ModeView {
    const mode = this.list().find((m) => m.slug === slug);
    if (!mode) throw new Error(`There is no mode called ${slug}. Known: ${this.list().map((m) => m.slug).join(", ")}`);
    return mode;
  }
  save(input: unknown): ModeView {
    const mode = ModeSchema.parse(input);
    const others = this.saved().filter((m) => m.slug !== mode.slug);
    if (others.length >= maxModes) throw new Error(`At most ${maxModes} modes of your own`);
    this.store.save("settings", this.owner, "interop-modes-list", { modes: [...others, mode] });
    return { ...mode, origin: "yours" };
  }
  remove(slug: string): { removed: boolean } {
    const before = this.saved();
    const after = before.filter((m) => m.slug !== slug);
    this.store.save("settings", this.owner, "interop-modes-list", { modes: after });
    return { removed: after.length < before.length };
  }
}

/**
 * What a mode may reach inside a task that already has `granted`: the permissions of the tools in
 * its toolboxes (every toolbox when it names none), always the core ones, never more than granted,
 * and only the look-only ones when it is read-only.
 */
export function modePermissions(mode: Mode, registry: ToolRegistry, granted: ReadonlySet<string>): string[] {
  const boxes = new Set([...mode.groups, "core"]);
  const reach = new Set<string>();
  for (const tool of registry.inventory())
    if (!mode.groups.length || boxes.has(registry.groupOf(tool.name))) reach.add(tool.permission);
  return [...reach].filter((p) => granted.has(p) && (!mode.readOnly || isReadOnlyPermission(p))).sort();
}

export function modeInstructions(mode: Mode): string {
  return `\n\nYou are working in the "${mode.name}" mode. ${mode.role}${mode.instructions ? `\n${mode.instructions}` : ""}` +
    "\nWhen you are done, reply with a short summary of what you did and found, for the task that sent you this work.";
}

const TaskSchema = z.object({
  mode: z.string().min(1).max(31),
  /** Everything the other mode needs to know; it does not see this conversation. */
  message: z.string().trim().min(1).max(8000),
}).strict();

/** Sends a piece of work to another mode and brings its summary back: the boomerang. */
export async function modeTask(runtime: Runtime, modes: Modes, registry: ToolRegistry, context: ToolContext, input: z.infer<typeof TaskSchema>) {
  requireInterop(runtime.store, context.owner, "modes");
  const mode = modes.find(input.mode);
  const permissions = modePermissions(mode, registry, context.permissions);
  if (context.runId) runtime.store.event(context.runId, "mode.task.sent", { mode: mode.slug, label: `Sent to ${mode.name}: ${input.message.slice(0, 80)}` });
  try {
    const run = await runtime.delegate(input.message, context, permissions, modeInstructions(mode), { agent: `mode:${mode.slug}` });
    if (context.runId) runtime.store.event(context.runId, "mode.task.returned", { mode: mode.slug, status: run.status, childRunId: run.id, label: `${mode.name} came back: ${run.status}` });
    return { mode: mode.slug, status: run.status, runId: run.id, summary: run.output.slice(0, 4000),
      next: "Read the summary, then decide the next piece of work or give the answer." };
  } catch (error) {
    if (context.runId) runtime.store.event(context.runId, "mode.task.returned", { mode: mode.slug, status: "failed", label: `${mode.name} could not finish` });
    return { mode: mode.slug, status: "failed", summary: "", error: errorText(error) };
  }
}

export function registerModeTools(registry: ToolRegistry, runtime: Runtime, modes: Modes): void {
  registry.register({
    name: "mode.list", group: "agents", permission: "specialists.read",
    description: "The ways of working (modes) you can send work to, with when to use each.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => {
      requireInterop(runtime.store, context.owner, "modes");
      return { modes: modes.list().map(({ slug, name, whenToUse, readOnly, origin }) => ({ slug, name, whenToUse, readOnly, origin })) };
    },
  });
  registry.register({
    name: "mode.task", group: "agents", permission: "specialists.use",
    description: "Send one piece of work to another mode; its summary comes back to you when it is done.",
    parameters: TaskSchema,
    execute: async (args, context) => modeTask(runtime, modes, registry, context, args),
  });
}
