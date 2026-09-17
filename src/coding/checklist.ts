import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Message, ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { codingOn, requireCoding } from "./settings.js";

/**
 * R17-039: a checklist for each conversation's work. The assistant writes its steps down and ticks
 * them off; the owner can add, change, tick or remove a step while the task is still working. The
 * list is sent with every round and never stored in the conversation, so compaction cannot lose it,
 * and when the owner has changed it the assistant is told their version wins. The idea is Cline's
 * "focus chain" (Apache-2.0, `apps/vscode/src/core/task/focus-chain/`); this is written for Branch.
 */
export const maxSteps = 40;
const sessionId = z.string().uuid();
const StepSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
}).strict();
export const ChecklistWriteSchema = z.object({ steps: z.array(StepSchema).max(maxSteps) }).strict();
export const OwnerChecklistSchema = z.object({ sessionId, steps: z.array(StepSchema).max(maxSteps) }).strict();

export interface Step { id: string; text: string; done: boolean; by: "owner" | "assistant" }
export interface Checklist { sessionId: string; steps: Step[]; ownerChangedAt: string | null; updatedAt: string | null }
const SavedSchema = z.object({
  steps: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean(), by: z.enum(["owner", "assistant"]) })).default([]),
  ownerChangedAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  /** When the assistant last saw the owner's change, so it is told about it once. */
  seenAt: z.string().nullable().default(null),
});
const key = (id: string): string => `coding-checklist:${id}`;

export class Checklists {
  constructor(private readonly store: Store, private readonly owner: string) {}

  private saved(id: string) {
    const parsed = SavedSchema.safeParse(this.store.get("settings", this.owner, key(id))?.data ?? {});
    return parsed.success ? parsed.data : SavedSchema.parse({});
  }

  get(id: string): Checklist {
    const value = sessionId.parse(id);
    if (!this.store.ownsSession(this.owner, value)) throw new Error("Conversation not found");
    const { steps, ownerChangedAt, updatedAt } = this.saved(value);
    return { sessionId: value, steps, ownerChangedAt, updatedAt };
  }

  private write(id: string, steps: z.infer<typeof StepSchema>[], by: Step["by"]): Checklist {
    const before = this.saved(id), now = new Date().toISOString();
    const known = new Map(before.steps.map((step) => [step.id, step]));
    const next: Step[] = steps.map((step) => {
      const old = step.id ? known.get(step.id) : undefined;
      const same = old && old.text === step.text;
      return { id: old?.id ?? randomUUID(), text: step.text, done: step.done, by: same ? old.by : by };
    });
    const ownerChangedAt = by === "owner" ? now : before.ownerChangedAt;
    this.store.save("settings", this.owner, key(id), { steps: next, ownerChangedAt, updatedAt: now, seenAt: by === "owner" ? before.seenAt : now });
    return { sessionId: id, steps: next, ownerChangedAt, updatedAt: now };
  }

  /** The owner's own edit, from the window, while a task may be working. */
  saveByOwner(input: unknown): Checklist {
    requireCoding(this.store, this.owner, "checklist");
    const { sessionId: id, steps } = OwnerChecklistSchema.parse(input);
    this.get(id);
    return this.write(id, steps, "owner");
  }

  /** The assistant's list, for the conversation the calling task belongs to. */
  saveByAssistant(input: z.infer<typeof ChecklistWriteSchema>, context: Pick<ToolContext, "runId">): Checklist {
    return this.write(this.sessionOf(context), input.steps, "assistant");
  }

  sessionOf(context: Pick<ToolContext, "runId">): string {
    const run = this.store.run(context.runId);
    if (!run || run.owner !== this.owner) throw new Error("This task has no conversation to keep a checklist for.");
    return run.sessionId;
  }

  /** The list as the model sees it each round, or null when there is none or the part is off. */
  roundNote(id: string): Message | null {
    if (!codingOn(this.store, this.owner, "checklist")) return null;
    const saved = this.saved(id);
    if (!saved.steps.length) return null;
    const lines = saved.steps.map((step, index) => `${index + 1}. [${step.done ? "x" : " "}] ${step.text}`);
    const changed = saved.ownerChangedAt && saved.ownerChangedAt !== saved.seenAt;
    if (changed) this.store.save("settings", this.owner, key(id), { ...saved, seenAt: saved.ownerChangedAt });
    const head = changed
      ? "The person changed this task's checklist while you worked. Their version is the plan now; follow it and keep it up to date with checklist.write:"
      : "This task's checklist (keep it up to date with checklist.write as you finish steps):";
    return { role: "system", content: `${head}\n${lines.join("\n")}` };
  }
}

export function registerChecklist(registry: ToolRegistry, lists: Checklists): void {
  registry.register({
    name: "checklist.write", permission: "memory.write", group: "core",
    description: "Write this task's checklist: every step in order, each with done true or false. Keep the ids of steps you already have. The person can edit it while you work; their version wins.",
    parameters: ChecklistWriteSchema,
    execute: async (input, context) => lists.saveByAssistant(input, context),
  });
  registry.register({
    name: "checklist.read", permission: "memory.read", group: "core",
    description: "Read this task's checklist, with the id of each step and who wrote it.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => lists.get(lists.sessionOf(context)),
  });
}
