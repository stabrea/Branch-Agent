/**
 * What another AI tool connected over MCP is allowed to reach, worked out before it asks.
 *
 * Two jobs live here. **Preflight** checks every tool the owner has shared against the approval
 * settings as soon as a client connects, so a tool the settings refuse outright is never offered at
 * all, and the client can read a plain-language note saying what was left out and why. **Dry run**
 * answers "what would this call do?" — the tool, what it would touch, whether it changes anything,
 * and what it would cost — without doing any of it.
 */
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import { Budget } from "./contracts.js";
import { everyTargetDecision } from "./policy-targets.js"; // mac7/multi-target
import {
  cappedPolicy, evaluatePolicy, isReadOnlyPermission, policyTarget, readPolicy, type PolicyDecision,
} from "./policy.js";

/** The note a client reads to find out why a tool it expected is not in the list. */
export const hiddenToolsUri = "policy://hidden-tools";

export interface PreflightEntry {
  name: string;
  permission: string;
  /** False when the tool only reads; true when it could write, run or send something. */
  changesThings: boolean;
  decision: PolicyDecision;
  reason: string;
}
export interface Preflight {
  allowed: PreflightEntry[];
  hidden: PreflightEntry[];
}

/**
 * Checks the shared tools against the owner's approval settings once, ahead of any call.
 *
 * Only a flat "no" hides a tool. A tool the settings want a question about stays in the list,
 * because with any preset chosen every tool that can change something becomes a question, and
 * hiding all of those would leave the other tool looking at an empty toolbox. Those calls are
 * stopped later, at the moment they are made, with a message saying the owner has to answer first.
 */
export function preflight(registry: ToolRegistry, store: Store, owner: string, exposed: ReadonlySet<string>): Preflight {
  const policy = cappedPolicy(readPolicy(store, owner), "mcp");
  const allowed: PreflightEntry[] = [];
  const hidden: PreflightEntry[] = [];
  for (const tool of registry.inventory()) {
    if (!exposed.has(tool.name)) continue;
    const readOnly = isReadOnlyPermission(tool.permission);
    // Nothing has been asked for yet, so there is no target to match a path or host rule against;
    // only a rule that refuses whatever the tool touches can decide this early.
    const { decision } = evaluatePolicy(policy, { tool: tool.name, target: "", readOnly });
    (decision === "deny" ? hidden : allowed).push({
      name: tool.name, permission: tool.permission, changesThings: !readOnly, decision,
      reason: reasonFor(tool.name, decision),
    });
  }
  return { allowed, hidden };
}

function reasonFor(name: string, decision: PolicyDecision): string {
  if (decision === "deny") return `Your approval settings do not allow ${name}, so it is not offered.`;
  if (decision === "ask") return `${name} is offered, but a call waits for your yes in Branch.`;
  return `${name} is offered and runs straight away.`;
}

/** The "what was left out and why" note, as plain sentences another tool can show a person. */
export function hiddenToolsText(result: Preflight): string {
  const names = (entries: PreflightEntry[]) =>
    entries.length === 0 ? "none" : entries.map((entry) => entry.name).join(", ");
  const lines = [
    "What Branch is offering this connection, and what it is holding back.",
    "",
    `Offered: ${names(result.allowed)}`,
    `Held back: ${names(result.hidden)}`,
    "",
  ];
  for (const entry of [...result.hidden, ...result.allowed]) lines.push(`${entry.name}: ${entry.reason}`);
  lines.push("", "Only a flat refusal hides a tool. A tool that needs your yes is still offered, and the call waits for you.");
  return lines.join("\n");
}

export const DryRunSchema = z
  .object({
    name: z.string().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export interface DryRunPlan {
  tool: string;
  description: string;
  /** What the call would touch: a file path, a command, or a web address's host. */
  target: string;
  /** Files this call names, so far as the arguments say. */
  files: string[];
  /** Web addresses' hosts this call names. */
  hosts: string[];
  changesThings: boolean;
  decision: PolicyDecision;
  /** What it would cost, in plain words. */
  cost: string;
  /** What would happen if this were run for real. */
  wouldHappen: string;
  /** Always true: nothing here runs anything. */
  dryRun: true;
}

const hostOf = (value: string): string | null => {
  try { return new URL(value).host; } catch { return null; }
};

/** Paths and web addresses named anywhere in the arguments, without following anything. */
function touched(args: Record<string, unknown>): { files: string[]; hosts: string[] } {
  const files = new Set<string>(), hosts = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string" || !item) continue;
      const host = hostOf(item);
      if (host) hosts.add(host);
      else if (/^(path|file|source|destination|target|folder|directory)$/i.test(key)) files.add(item.slice(0, 300));
    }
  }
  return { files: [...files].slice(0, 20), hosts: [...hosts].slice(0, 20) };
}

/** A context that can reach nothing, used only so a tool's own `target()` can read the arguments. */
function inertContext(owner: string, workspace: string): ToolContext {
  return {
    owner, workspace, runId: "dry-run", signal: AbortSignal.timeout(1000),
    budget: new Budget({ maxSteps: 1, maxTokens: 1 }), permissions: new Set<string>(), depth: 0, dryRun: true,
  };
}

const priceNote = (name: string): string =>
  name === "branch.ask"
    ? "Asking Branch in plain words goes to your chosen model, so it costs whatever that model charges for the answer."
    : "Nothing. This tool runs on this computer and no model is asked.";

const outcomeNote = (name: string, target: string, decision: PolicyDecision, readOnly: boolean): string => {
  const verb = readOnly ? "look at" : "change";
  const what = target || "what the arguments name";
  if (decision === "deny") return `Nothing. Your approval settings refuse ${name}${target ? ` on ${target}` : ""}.`;
  if (decision === "ask") return `Branch would ask you first, then ${verb} ${what}.`;
  return `Branch would ${verb} ${what} straight away.`;
};

/**
 * What the call would do, worked out from the tool's own description of its target and from the
 * arguments. No tool is executed, nothing is written, and no web address is opened.
 */
export function dryRunPlan(
  registry: ToolRegistry, store: Store, owner: string, workspace: string, input: z.infer<typeof DryRunSchema>,
): DryRunPlan {
  const tool = registry.inventory().find((entry) => entry.name === input.name);
  if (!tool) throw new Error(`There is no tool called ${input.name}.`);
  const seen = registry.runArgs(input.name, input.arguments); // hardening-3: as the tool will run it
  const target = registry.targetOf(input.name, seen, inertContext(owner, workspace))
    || policyTarget(input.name, seen);
  const readOnly = isReadOnlyPermission(tool.permission);
  // hardening-3: what the call is about goes in too, so a folder rule is weighed here as it is when the call runs.
  const resource = registry.resourceOf(input.name, target, seen);
  const policy = cappedPolicy(readPolicy(store, owner), "mcp");
  const whole = evaluatePolicy(policy, { tool: input.name, target, readOnly, resource }).decision;
  // mac7/multi-target: every file the call touches is weighed too, and listed.
  const { decision, targets } = everyTargetDecision(registry, policy,
    { tool: input.name, permission: tool.permission, callTarget: target, args: seen }, inertContext(owner, workspace), whole);
  const named = touched(seen as Record<string, unknown>), hosts = named.hosts;
  const files = [...new Set([...targets.flatMap((one) => (one.path ? [one.path] : [])), ...named.files])].slice(0, 20);
  return {
    tool: input.name, description: tool.description, target, files, hosts, changesThings: !readOnly, decision,
    cost: priceNote(input.name),
    wouldHappen: outcomeNote(input.name, target, decision, readOnly),
    dryRun: true,
  };
}
