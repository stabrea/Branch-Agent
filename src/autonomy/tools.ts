import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Autonomy } from "./index.js";
import { catalogue } from "./blueprints.js";
import { OrderSchema } from "./orders.js";
import { ProcedureSchema } from "./procedures.js";
import type { AutonomyPart } from "./settings.js";

/**
 * R17-B: the assistant's side. Every tool here only reads, or puts a question to the owner; none of
 * them makes a schedule, an order, a procedure or an instruction. That takes the owner's yes in
 * Inbox › Needs you. The questions are capped (src/autonomy/ledger.ts) and a "no" is never re-asked.
 */
const read = "automations.read";
const propose = "automations.propose";
const values = z.record(z.string().regex(/^[a-z]{1,20}$/), z.string().max(300)).default({});

type Registrar = (registry: ToolRegistry, autonomy: Autonomy) => void;

const suggestions: Registrar = (registry, autonomy) => {
  registry.register({ name: "automation.ideas", permission: read, group: "automations",
    description: "The automation catalogue (blueprints with blanks) and the automations suggested for the owner right now. Reading only.",
    parameters: z.object({ starters: z.boolean().default(false) }).strict(),
    execute: async (args) => ({ catalogue: catalogue(), suggestions: autonomy.suggestions(args.starters) }) });
  registry.register({ name: "automation.propose", permission: propose, group: "automations",
    description: "Ask the owner whether to make an automation from a catalogue blueprint with its blanks filled. Nothing is scheduled until the owner says yes.",
    parameters: z.object({ blueprint: z.string().min(1).max(60), values, timezone: z.string().min(1).max(64).optional() }).strict(),
    execute: async (args) => autonomy.proposeBlueprint(args) });
};

const orders: Registrar = (registry, autonomy) => {
  registry.register({ name: "orders.list", permission: read, group: "automations",
    description: "The owner's standing orders: what each may do, when it runs, and how it last went.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.orders.list().map(({ id, order, status, pausedBecause, lastRun }) => ({ id, order, status, pausedBecause, lastRun })) });
  registry.register({ name: "orders.propose", permission: propose, group: "automations",
    description: "Ask the owner to hand over a standing order (a named programme with its authority, start, approval gate and escalation rules). It is made only on the owner's yes.",
    parameters: OrderSchema,
    execute: async (args) => autonomy.orders.propose(args) });
};

const procedures: Registrar = (registry, autonomy) => {
  registry.register({ name: "procedures.auto.list", permission: read, group: "automations",
    description: "The procedures that start themselves: their steps, level of autonomy, start and success rate.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.procedures.list() });
  registry.register({ name: "procedures.auto.propose", permission: propose, group: "automations",
    description: "Ask the owner to keep a procedure that starts itself (steps, start, and whether it asks before each step, before it starts, or runs on its own). It is kept only on the owner's yes.",
    parameters: ProcedureSchema,
    execute: async (args) => autonomy.procedures.propose(args) });
};

const readiness: Registrar = (registry, autonomy) => {
  registry.register({ name: "skills.readiness", permission: read, group: "skills",
    description: "Whether each installed skill that says what it needs has it on this computer (programs, keys, system), and how the owner could add what is missing.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.readiness() });
};

const instructions: Registrar = (registry, autonomy) => {
  registry.register({ name: "instructions.list", permission: read, group: "automations",
    description: "The standing instructions the owner has kept (\"from now on, ...\") and who each is for.",
    parameters: z.object({}).strict(),
    execute: async () => autonomy.instructions.list() });
  registry.register({ name: "instructions.propose", permission: propose, group: "automations",
    description: "When the owner asks you to always work a certain way from now on, ask them to keep it as a standing instruction (one short sentence in their words). It is kept only on their yes.",
    parameters: z.object({ text: z.string().trim().min(3).max(300), scope: z.string().max(100).default("assistant") }).strict(),
    execute: async (args) => autonomy.instructions.propose(args, "assistant") });
};

const registrars: Partial<Record<AutonomyPart, Registrar>> = { suggestions, orders, procedures, readiness, instructions };

export function registerAutonomyTools(registry: ToolRegistry, autonomy: Autonomy, part: AutonomyPart): void {
  registrars[part]?.(registry, autonomy);
}
