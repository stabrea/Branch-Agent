import { join, posix } from "node:path";
import type { ToolContext } from "../contracts.js";
import type { TaskPlace } from "../coding/worktrees.js";

/**
 * FQ-routing.isolated-agents: per-agent file roots.
 *
 * Memory already narrows what a Trunk's turn can read and write to its own scope (`agent:<id>`,
 * src/trunks/memory-scope.ts). Files had no such wall: every Trunk's turn resolved paths against the
 * same active project as the owner and every other Trunk (`files.scope` in src/index.ts), so one Trunk
 * could read, list or overwrite what another Trunk (or the owner) had just written.
 *
 * This gives a Trunk's own top-level turn its own folder under the workspace, `.branch-agents/<id>`,
 * using the same seam a coding fork already uses to work in its own copy of the project
 * (`WorktreePlaces.placeTask` / `inWorktree`, src/coding/worktrees.ts): `files.scope` reads
 * `worktreeScope()` first, so once a Trunk's turn is wrapped in that folder, `files.checked()` refuses
 * anything outside it exactly as it already refuses `..` and symlinks. A child task (a delegated
 * specialist, a tool call) inherits the same folder because it runs inside the same async chain; only
 * a fresh top-level turn (`parent` unset) is ever placed here, so a room turn — still a fresh turn,
 * just flagged `delegated` — gets its Trunk's own folder too, and a helper spawned mid-task does not
 * get a folder of its own but stays inside the Trunk's.
 */
export const trunkFilesHome = ".branch-agents";

/** The id inside a Trunk's memory-scope agent string (`trunk:<id>`), or undefined for anything else
 *  (the owner's own turn, a delegated specialist's `agent`, no agent at all). Kept narrow on purpose:
 *  a specialist already shares its parent's files by design, so only a Trunk gets its own root. */
export function trunkIdOf(agent: string | undefined): string | undefined {
  if (!agent?.startsWith("trunk:")) return undefined;
  // Trunk ids are UUIDs (src/trunks/record.ts), but a folder name built from one is still sanitised
  // defensively rather than trusted, the same caution `files.checked` takes with any workspace path.
  const id = agent.slice("trunk:".length).replace(/[^a-zA-Z0-9_-]/g, "");
  return id || undefined;
}

/**
 * Where a Trunk's own turn works, when it is not already working somewhere of its own (a coding
 * fork). `null` for anything but a Trunk's fresh top-level turn, so the owner's own conversation, a
 * delegated specialist and a helper task all keep working in the shared project exactly as before.
 */
export function trunkFilePlace(root: string, context: Pick<ToolContext, "agent" | "trunk">, parent: unknown): TaskPlace | null {
  if (parent) return null;
  // Q114: work a Trunk set going without a turn of its own (a workflow's prompt step, a flow box) is its work too.
  const id = context.agent ? trunkIdOf(context.agent) : trunkIdOf(context.trunk ? `trunk:${context.trunk}` : undefined);
  if (!id) return null;
  const scope = posix.join(trunkFilesHome, id);
  return { scope, workspace: join(root, scope), release: async () => undefined };
}
