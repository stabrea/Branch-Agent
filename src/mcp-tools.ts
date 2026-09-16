/**
 * Two tools Branch itself can use about its own connections to other AI tools: saying what a call
 * would do without doing it, and how the outside servers it talks to are faring. Neither changes
 * anything, so both only ever look.
 */
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { DryRunSchema, dryRunPlan } from "./mcp-policy.js";
import type { McpConnections } from "./mcp-lifecycle.js";

export function registerMcpTools(
  registry: ToolRegistry, store: Store, workspace: string, connections: McpConnections,
): void {
  registry.register({
    name: "mcp.dry_run",
    description: "Say what a tool call would do — what it would touch, whether it changes anything, and what it would cost — without doing it.",
    permission: "mcp.read",
    parameters: DryRunSchema,
    execute: async (args, context) => dryRunPlan(registry, store, context.owner, workspace, args),
  });
  registry.register({
    name: "mcp.servers",
    description: "How the connections to other AI tools' servers are doing: which are open, which are in use, and which are not answering.",
    permission: "mcp.read",
    parameters: z.object({}).strict(),
    execute: async () => ({ open: connections.openCount(), servers: connections.health() }),
  });
}
