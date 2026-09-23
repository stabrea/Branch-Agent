import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { aliasSchema } from "./remote/ssh-workspace.js";

/**
 * FQ-execution.host-bridge: the one door the owner presses to run a program on a computer they name
 * explicitly, and get back exactly which computer answered alongside what it said. `remote.run` (see
 * `src/remote/ssh-workspace.ts`) already does this for the agent's own tool calls; this is the same
 * call reachable directly from Settings, so the owner never has to start a conversation just to press
 * a button on the other end. The rule about which programs a computer may run is enforced once, by
 * `RemoteWorkspaces.execute`, not re-implemented here.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export class HostBridgeApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function handlesHostBridgePath(path: string): boolean {
  return path === "/api/host-bridge/run";
}

const RunSchema = z.object({
  computer: aliasSchema,
  program: z.string().trim().min(1).max(80),
  args: z.array(z.string().max(300)).max(32).default([]),
}).strict();

export async function hostBridgeApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
): Promise<{ computer: string; program: string; output: string }> {
  if (request.method !== "POST" || path !== "/api/host-bridge/run")
    throw new HostBridgeApiError(404, "Unknown address");
  const parsed = RunSchema.safeParse(await readBody(request));
  if (!parsed.success) throw new HostBridgeApiError(400, parsed.error.issues[0]?.message ?? "That is not a valid request.");
  const { computer, program, args } = parsed.data;
  try {
    // The identity of the host that actually answered travels back with the result, not just the
    // owner's own request: `computer` here is what `RemoteWorkspaces.execute` read off the run, so a
    // reply can never be mistaken for having come from a different computer than the one asked.
    return await app.remotes.execute(computer, program, args, AbortSignal.timeout(60_000));
  } catch (error) {
    throw new HostBridgeApiError(400, error instanceof Error ? error.message : String(error));
  }
}
