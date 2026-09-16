import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { WorkspaceHistory } from "./workspace-history.js";

/**
 * Points you can come back to. A checkpoint keeps the exact bytes of every file the assistant has
 * changed in this conversation, under a name; undo puts the last change back, and redo puts it
 * forward again. All three work on the versions the file history already keeps, so nothing new is
 * copied around and the bytes that come back are the bytes that were there.
 */
export interface UndoSummary { path: string; added: number; removed: number; diff: string }

/** The conversation a task belongs to; a task outside a conversation stands on its own. */
export function sessionOf(store: Store, context: ToolContext): string {
  const session = context.runId ? store.run(context.runId)?.sessionId : undefined;
  if (!session) throw new Error("This only works inside a conversation.");
  return session;
}

export function registerCheckpoints(registry: ToolRegistry, store: Store, history: WorkspaceHistory): void {
  registry.register({
    name: "workspace.checkpoint", permission: "files.write", group: "files",
    description: "Keep a point you can come back to: the exact bytes of every file changed in this conversation so far, under a name. Nothing is changed by taking one.",
    parameters: z.object({ label: z.string().trim().min(1).max(120).default("Checkpoint") }).strict(),
    target: () => "",
    execute: async (args, context) => history.checkpoint(sessionOf(store, context), args.label),
  });
  registry.register({
    name: "workspace.points", permission: "files.read", group: "files",
    description: "The points kept so far — checkpoints and whole-workspace snapshots — newest first, with how many files each holds.",
    parameters: z.object({}).strict(),
    execute: async () => ({ points: history.snapshots() }),
  });
  registry.register({
    name: "workspace.restore_point", permission: "files.write", group: "files",
    description: "Put every file in a kept point back to its exact bytes. Files made since are left where they are.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    target: (args) => `restore point ${args.id}`,
    execute: async (args) => history.restoreSnapshot(args.id),
  });
  registerUndo(registry, store, history);
}

function registerUndo(registry: ToolRegistry, store: Store, history: WorkspaceHistory): void {
  registry.register({
    name: "workspace.undo", permission: "files.write", group: "files",
    description: "Put the last file change in this conversation back as it was. Ask with preview first to see which file it is and what would change.",
    parameters: z.object({ preview: z.boolean().default(false) }).strict(),
    target: (args) => (args.preview ? "" : "undo the last change"),
    execute: async (args, context) => {
      const session = sessionOf(store, context);
      if (args.preview) return { preview: true, change: await history.undoPlan(session) };
      return history.undo(session);
    },
  });
  registry.register({
    name: "workspace.redo", permission: "files.write", group: "files",
    description: "Put the last undone change forward again. Ask with preview first to see what would change.",
    parameters: z.object({ preview: z.boolean().default(false) }).strict(),
    target: (args) => (args.preview ? "" : "redo the last undone change"),
    execute: async (args, context) => {
      const session = sessionOf(store, context);
      if (args.preview) return { preview: true, change: await history.redoPlan(session) };
      return history.redo(session);
    },
  });
}
