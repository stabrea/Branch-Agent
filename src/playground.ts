/**
 * "Try a tool": run one tool by hand, on its own, through exactly the same approval rules a task
 * would go through. Nothing here bypasses the gate — a tool the settings say to ask about comes
 * back as a question the owner must answer before it is run at all.
 */
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import { evaluatePolicy, isReadOnlyPermission, policyTarget, readPolicy } from "./policy.js";

export const TryToolSchema = z
  .object({
    name: z.string().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()).default({}),
    /** Set after the owner has answered the question this call raised the first time round. */
    confirm: z.boolean().default(false),
  })
  .strict();

/** Every tool with the shape of the form to fill in, so the page can draw one without guessing. */
export function toolForms(registry: ToolRegistry): { name: string; description: string; permission: string; readOnly: boolean; schema: Record<string, unknown> }[] {
  const byName = new Map(registry.descriptions(new Set(registry.permissions())).map((description) => [description.name, description.parameters] as const));
  return registry.inventory().map((tool) => ({
    name: tool.name,
    description: tool.description,
    permission: tool.permission,
    readOnly: isReadOnlyPermission(tool.permission),
    schema: (byName.get(tool.name) ?? {}) as Record<string, unknown>,
  }));
}

export type TryOutcome =
  | { status: "asked"; question: string; tool: string; target: string }
  | { status: "refused"; reason: string; tool: string; target: string }
  | { status: "ran"; tool: string; target: string; milliseconds: number; result: unknown }
  | { status: "failed"; tool: string; target: string; milliseconds: number; error: string };

/**
 * Checks the approval policy, then runs the tool. "ask" comes back as a question the first time and
 * only goes ahead when the caller sends the same request again with `confirm`.
 */
export async function tryTool(
  registry: ToolRegistry,
  store: Store,
  owner: string,
  context: ToolContext,
  input: z.infer<typeof TryToolSchema>,
): Promise<TryOutcome> {
  const permission = registry.permissionOf(input.name);
  if (!permission) return { status: "refused", reason: `There is no tool called ${input.name}.`, tool: input.name, target: "" };
  const target = registry.targetOf(input.name, input.arguments, context) || policyTarget(input.name, input.arguments);
  const { decision } = evaluatePolicy(readPolicy(store, owner), { tool: input.name, target, readOnly: isReadOnlyPermission(permission) });
  if (decision === "deny")
    return { status: "refused", reason: `Your settings do not allow ${input.name}${target ? ` on ${target}` : ""}.`, tool: input.name, target };
  if (decision === "ask" && !input.confirm)
    return { status: "asked", question: `Before I go ahead: run ${input.name}${target ? ` on ${target}` : ""}. Is that all right?`, tool: input.name, target };
  const started = Date.now();
  try {
    const result = await registry.execute(input.name, input.arguments, context);
    return { status: "ran", tool: input.name, target, milliseconds: Date.now() - started, result };
  } catch (error) {
    return { status: "failed", tool: input.name, target, milliseconds: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
