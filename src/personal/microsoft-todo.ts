import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { stripTags } from "./mime.js";
import { clip, outsideTextNote, requirePersonal } from "./settings.js";
import { signedCall, type SignIn } from "./signin.js";

/**
 * FQ-interop.personal-connectors: the owner's Microsoft To Do, alongside Outlook mail and calendar
 * (microsoft.ts), through Microsoft Graph v1.0 and the owner's own sign-in. Read-only, gated by the
 * same "microsoft" switch and the same owner-only guard as the rest of that connector.
 */
const graph = "https://graph.microsoft.com/v1.0/me";
/** A Graph object id: base64-ish, sometimes with "=", "+", "/", "-", "_". */
const graphId = z.string().trim().min(1).max(400).regex(/^[A-Za-z0-9_=+/-]{1,400}$/, "Not a Microsoft To Do id");

export const TodoListsSchema = z.object({}).strict();
export const TodoTasksSchema = z.object({
  /** A list id from mstodo.lists; the owner's default list ("Tasks") when left out. */
  list: graphId.optional(),
  max: z.number().int().min(1).max(100).default(20),
  /** Off by default: a briefing wants what is still outstanding, not what is already done. */
  includeCompleted: z.boolean().default(false),
}).strict();

const TodoList = z.object({ id: z.string(), displayName: z.string().optional(), wellknownListName: z.string().optional() }).passthrough();
const TodoTask = z.object({ id: z.string(), title: z.string().optional(), status: z.string().optional(),
  dueDateTime: z.object({ dateTime: z.string().optional() }).passthrough().optional(),
  body: z.object({ content: z.string().optional(), contentType: z.string().optional() }).passthrough().optional() }).passthrough();

export class MicrosoftTodoConnector {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly signIn: SignIn) {}
  private call(path: string): Promise<unknown> {
    requirePersonal(this.store, this.owner, "microsoft");
    return signedCall(this.fetcher, this.signIn, "Microsoft To Do", `${graph}${path}`);
  }

  /** The owner's task lists, so the model can ask for the right one by id. */
  async lists(input: unknown) {
    TodoListsSchema.parse(input);
    const body = z.object({ value: z.array(TodoList).default([]) }).passthrough()
      .parse(await this.call("/todo/lists?$select=id,displayName,wellknownListName"));
    return { lists: body.value.map((l) => ({ id: l.id, title: clip(l.displayName ?? "(untitled)", 200), default: l.wellknownListName === "defaultList" })),
      note: outsideTextNote };
  }

  /** The default list's id, found once so callers do not have to look it up themselves. */
  private async defaultListId(): Promise<string> {
    const body = z.object({ value: z.array(TodoList).default([]) }).passthrough()
      .parse(await this.call("/todo/lists?$select=id,wellknownListName"));
    const found = body.value.find((l) => l.wellknownListName === "defaultList") ?? body.value[0];
    if (!found) throw new Error("No Microsoft To Do list was found for the owner.");
    return found.id;
  }

  /** The tasks in one list (the owner's default list unless another id is given), outstanding first. */
  async tasks(input: unknown) {
    const { list, max, includeCompleted } = TodoTasksSchema.parse(input);
    const id = list ?? await this.defaultListId();
    const select = "$select=id,title,status,dueDateTime,body";
    const filter = includeCompleted ? "" : "&$filter=status ne 'completed'";
    const body = z.object({ value: z.array(TodoTask).default([]) }).passthrough()
      .parse(await this.call(`/todo/lists/${encodeURIComponent(id)}/tasks?$top=${max}&${select}${filter}`));
    return { list: id, note: outsideTextNote, tasks: body.value.map((t) => ({ id: t.id, title: clip(t.title ?? "(untitled)", 300),
      notes: clip(t.body?.contentType?.toLowerCase() === "html" ? stripTags(t.body.content ?? "") : (t.body?.content ?? ""), 2000),
      due: t.dueDateTime?.dateTime ?? null, done: t.status === "completed" })) };
  }
}

export function registerMicrosoftTodo(registry: Pick<ToolRegistry, "register">, todo: MicrosoftTodoConnector): void {
  const tool = (name: string, description: string, parameters: z.ZodType, run: (input: unknown) => Promise<unknown>) =>
    registry.register({ name, permission: "personal.read", description, parameters, execute: async (input) => run(input) });
  tool("mstodo.lists", "List the owner's Microsoft To Do lists, by id and title.", TodoListsSchema, (input) => todo.lists(input));
  tool("mstodo.list", "List the tasks in one of the owner's Microsoft To Do lists (their default list unless another id is given).",
    TodoTasksSchema, (input) => todo.tasks(input));
}
