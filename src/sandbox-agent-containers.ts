import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sliceFor, type SandboxSlice } from "./sandbox-backends.js";

/**
 * FQ-security.containers: a container is picked per approval rule (src/sandbox-backends.ts), the
 * same way for every caller — nothing before this kept one Trunk's container away from another's.
 * A folder under the workspace, one per agent (`context.agent`: "trunk:<id>", "mode:<slug>", the
 * owner's own turns have none), is what a container mounts instead of the shared workspace. Docker
 * hides everything else of the host already (`--read-only`, nothing bound but this one folder), so
 * giving each agent its own folder under here is what keeps a container run for one agent from ever
 * seeing another agent's files, without waiting on the workspace itself to be split up per agent.
 */
const containersFolder = ".branch-agent-containers";

/** An agent id made safe for a folder name: nothing a path could read specially survives. */
export function agentFolderName(agent: string): string {
  const safe = agent.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return safe || "agent";
}

/** Where one agent's container folder lives, under the workspace, before it is made. */
export function agentContainerRoot(workspace: string, agent: string): string {
  return join(workspace, containersFolder, agentFolderName(agent));
}

/**
 * The slice a container run mounts. With no agent (the owner's own turn, or a caller that never set
 * one) this is exactly `sliceFor` on the workspace, unchanged. With one, the container's `/work` is
 * that agent's own folder — made if it is not there yet — and a rule's folder list, if any, narrows
 * inside it exactly as it always narrowed inside the workspace. Nothing outside that one folder is
 * ever mounted, so another agent's folder alongside it is not a permission the container lacks —
 * it is a path that, inside the container, does not exist at all.
 */
export async function agentContainerSlice(
  workspace: string, agent: string | undefined, folders: readonly string[],
): Promise<SandboxSlice> {
  if (!agent) return sliceFor(workspace, folders);
  const root = agentContainerRoot(workspace, agent);
  await mkdir(root, { recursive: true });
  return sliceFor(root, folders);
}
