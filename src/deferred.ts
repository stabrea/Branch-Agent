import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Some things do not finish inside a tool call: a long upload, a person who has to do something by
 * hand, a service that will call back later. A tool may answer `{ deferred: true, id }` instead of a
 * result. The task carries on without it, the job is written down, and when the answer arrives it
 * comes back into the conversation as an ordinary follow-up message, so nothing is left hanging.
 */
export interface Deferral {
  id: string; runId: string; sessionId: string; tool: string; description: string;
  createdAt: string; settledAt: string | null; outcome: string | null;
}
/** What the runtime looks for in a tool's answer: `{ deferred: true }`, with an optional id. */
export function deferredCall(result: unknown): { id: string; description: string } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as { deferred?: unknown; id?: unknown; description?: unknown };
  if (value.deferred !== true) return null;
  const id = typeof value.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) ? value.id : randomUUID();
  return { id, description: String(value.description ?? "").slice(0, 500) };
}

export class Deferrals {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private key(id: string): string { return `deferred:${id}`; }
  open(entry: Omit<Deferral, "createdAt" | "settledAt" | "outcome">): Deferral {
    const full: Deferral = { ...entry, createdAt: new Date().toISOString(), settledAt: null, outcome: null };
    this.store.save("settings", this.owner, this.key(full.id), { ...full });
    return full;
  }
  get(id: string): Deferral | undefined {
    return this.store.get("settings", this.owner, this.key(id))?.data as unknown as Deferral | undefined;
  }
  /** Everything handed over, newest first; `waiting` leaves out the ones already answered. */
  list(options: { waiting?: boolean } = {}): Deferral[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("deferred:"))
      .map((row) => row.data as unknown as Deferral)
      .filter((entry) => !options.waiting || entry.settledAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Marks one as answered and gives back what it was, so the runtime can carry the answer in. */
  settle(id: string, outcome: string): Deferral {
    const entry = this.get(id);
    if (!entry) throw new Error("There is no handed-over job with that number");
    if (entry.settledAt) throw new Error("That job has already been answered");
    const settled: Deferral = { ...entry, settledAt: new Date().toISOString(), outcome: outcome.slice(0, 4000) };
    this.store.save("settings", this.owner, this.key(id), { ...settled });
    return settled;
  }
}

export const SettleDeferredSchema = z.object({
  id: z.string().min(1).max(64),
  outcome: z.string().trim().min(1).max(4000),
}).strict();

/**
 * A job for a person: the assistant hands it over and carries on, and the owner says what came of
 * it in the app. It is the plainest example of a deferred call, and what it does is what any other
 * deferring tool does.
 */
export function registerHumanTasks(registry: ToolRegistry): void {
  registry.register({
    name: "user.task", permission: "user.ask", group: "core",
    description: "Hand something to the person to do themselves (sign in somewhere, post a letter, check a machine). You are not made to wait: the task carries on without it, and their answer arrives as a new message in this conversation when they have done it.",
    parameters: z.object({ description: z.string().trim().min(1).max(500) }).strict(),
    execute: async ({ description }) => ({ deferred: true as const, description }),
  });
}
