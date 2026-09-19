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
import { resourceOf } from "./policy-resources.js";
import type { ManualVerdict } from "./tool-gate.js";

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
  /** Why the person at the keyboard may not have this done, from their profile's role. */
  personRefusal: (tool: string, permission: string) => string | null = () => null,
  /**
   * mac5/manual-actions: the runtime's hand-pressed gate (src/tool-gate.ts) — Branch's own files,
   * Lockdown, folder trust and the sandbox wall on top of the rules. Without it only the rules apply.
   */
  gate?: (tool: string, args: unknown, context: ToolContext) => ManualVerdict,
): Promise<TryOutcome> {
  const permission = registry.permissionOf(input.name);
  if (!permission) return { status: "refused", reason: `There is no tool called ${input.name}.`, tool: input.name, target: "" };
  // Somebody else in the house is held to their role here as well; running a tool by hand from the
  // developer screen must not be a way round what the owner said they may have Branch do.
  const held = personRefusal(input.name, permission);
  if (held) return { status: "refused", reason: held, tool: input.name, target: "" };
  // hardening-3: judged as the tool will run it, with the names it maps and the spaces it trims.
  const seen = registry.runArgs(input.name, input.arguments);
  const target = registry.targetOf(input.name, seen, context) || policyTarget(input.name, seen);
  // What the call is about goes in too, so trying a command by hand is decided exactly as a
  // command the assistant asked for would be — a command nobody has ruled on is asked about.
  const resource = resourceOf(input.name, permission, target, seen);
  const verdict = gate?.(input.name, seen, context);
  const decision = verdict?.decision
    ?? evaluatePolicy(readPolicy(store, owner), { tool: input.name, target, readOnly: isReadOnlyPermission(permission), resource }).decision;
  if (decision === "deny")
    return { status: "refused", reason: verdict?.reason ?? `Your settings do not allow ${input.name}${target ? ` on ${target}` : ""}.`, tool: input.name, target };
  if (decision === "ask" && !input.confirm)
    return { status: "asked", question: `Before I go ahead: run ${input.name}${target ? ` on ${target}` : ""}. Is that all right?`, tool: input.name, target };
  const started = Date.now();
  try {
    const result = await registry.execute(input.name, input.arguments, { ...context, ...verdict?.scope });
    return { status: "ran", tool: input.name, target, milliseconds: Date.now() - started, result };
  } catch (error) {
    return { status: "failed", tool: input.name, target, milliseconds: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
