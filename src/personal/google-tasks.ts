import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { clip, outsideTextNote, requirePersonal } from "./settings.js";
import { signedCall, type SignIn } from "./signin.js";

/**
 * FQ-interop.personal-connectors: the owner's Google Tasks, alongside Gmail and Google Calendar
 * (google.ts), through Google's official REST API and the owner's own sign-in. Read-only, gated by
 * the same "google" switch and the same owner-only guard as the rest of that connector.
 *
 *   Tasks  https://tasks.googleapis.com/tasks/v1/users/@me/lists
 *          https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks
 */
const tasksApi = "https://tasks.googleapis.com/tasks/v1";
/** A task list id, or "@default" for the owner's default list. */
const listId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9@_-]{1,200}$/, "Not a Google Tasks list id");

export const TaskListsSchema = z.object({}).strict();
export const TasksSchema = z.object({
  list: listId.default("@default"),
  max: z.number().int().min(1).max(100).default(20),
  /** Off by default: a briefing wants what is still outstanding, not what is already done. */
  includeCompleted: z.boolean().default(false),
}).strict();

const TaskList = z.object({ id: z.string(), title: z.string().optional() }).passthrough();
const Task = z.object({ id: z.string(), title: z.string().optional(), notes: z.string().optional(), status: z.string().optional(),
  due: z.string().optional(), completed: z.string().optional() }).passthrough();

export class GoogleTasksConnector {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly signIn: SignIn) {}
  private call(url: string): Promise<unknown> {
    requirePersonal(this.store, this.owner, "google");
    return signedCall(this.fetcher, this.signIn, "Google Tasks", url);
  }

  /** The owner's task lists, so the model can ask for the right one by id. */
  async lists(input: unknown) {
    TaskListsSchema.parse(input);
    const body = z.object({ items: z.array(TaskList).default([]) }).passthrough()
      .parse(await this.call(`${tasksApi}/users/@me/lists`));
    return { lists: body.items.map((l) => ({ id: l.id, title: clip(l.title ?? "(untitled)", 200) })), note: outsideTextNote };
  }

  /** The tasks in one list, outstanding first unless completed ones were asked for too. */
  async tasks(input: unknown) {
    const { list, max, includeCompleted } = TasksSchema.parse(input);
    const query = new URLSearchParams({ maxResults: String(max), showCompleted: String(includeCompleted), showHidden: String(includeCompleted) });
    const body = z.object({ items: z.array(Task).default([]) }).passthrough()
      .parse(await this.call(`${tasksApi}/lists/${encodeURIComponent(list)}/tasks?${query}`));
    return { list, note: outsideTextNote, tasks: body.items.map((t) => ({ id: t.id, title: clip(t.title ?? "(untitled)", 300),
      notes: clip(t.notes ?? "", 2000), due: t.due ?? null, done: t.status === "completed", completedAt: t.completed ?? null })) };
  }
}

export function registerGoogleTasks(registry: Pick<ToolRegistry, "register">, tasks: GoogleTasksConnector): void {
  const tool = (name: string, description: string, parameters: z.ZodType, run: (input: unknown) => Promise<unknown>) =>
    registry.register({ name, permission: "personal.read", description, parameters, execute: async (input) => run(input) });
  tool("gtasks.lists", "List the owner's Google Tasks lists, by id and title.", TaskListsSchema, (input) => tasks.lists(input));
  tool("gtasks.list", "List the tasks in one of the owner's Google Tasks lists (their default list unless another id is given).",
    TasksSchema, (input) => tasks.tasks(input));
}
