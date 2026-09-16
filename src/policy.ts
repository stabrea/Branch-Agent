import { z } from "zod";
import type { Store } from "./store.js";

/**
 * The owner's approval policy: an ordered list of rules that says, for each tool and for what that
 * tool would touch, whether the assistant may go ahead, must ask first, or may not do it at all.
 * The first rule that matches wins. With no rules nothing is asked and nothing is refused, which is
 * how Branch Agent behaves until the owner picks a preset.
 */
export const PolicyDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export const PolicyRememberSchema = z.enum(["never", "session", "always"]);
export type PolicyRemember = z.infer<typeof PolicyRememberSchema>;

export const PolicyRuleSchema = z
  .object({
    /** A tool name, or a pattern where `*` stands for any text: "files.write", "browser.*", "*". */
    tool: z.string().min(1).max(100).default("*"),
    /** What the tool would touch: a file path, a command, or a web address's host. `*` matches anything. */
    match: z.string().min(1).max(500).default("*"),
    /** "changes" limits the rule to tools that can change something; "any" covers every tool. */
    applies: z.enum(["any", "changes"]).default("any"),
    decision: PolicyDecisionSchema,
    /** What a "yes" to this question is remembered as, unless the person picks differently. */
    remember: PolicyRememberSchema.default("session"),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyLimitsSchema = z
  .object({
    /** Most tool calls one conversation may make in a minute; 0 means no limit. */
    toolCallsPerMinute: z.number().int().min(0).max(1000).default(0),
    /** Most times one conversation may go back to the model in a minute; 0 means no limit. */
    modelRoundsPerMinute: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
export type PolicyLimits = z.infer<typeof PolicyLimitsSchema>;

export const PolicyPresetSchema = z.enum(["off", "ask-before-changes", "workspace", "read-only", "custom"]);
export type PolicyPresetName = z.infer<typeof PolicyPresetSchema>;
export const PolicySchema = z
  .object({
    preset: PolicyPresetSchema.default("off"),
    rules: z.array(PolicyRuleSchema).max(100).default([]),
    limits: PolicyLimitsSchema.prefault({}),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
export const PolicyInputSchema = z
  .object({
    preset: PolicyPresetSchema.optional(),
    rules: z.array(PolicyRuleSchema).max(100).optional(),
    limits: PolicyLimitsSchema.partial().optional(),
  })
  .strict();

/** Where a task came from. Anything but the owner's own app or command line is held to the "Ask before changes" preset. */
export type RunSource = "owner" | "trigger" | "schedule" | "mcp";

interface PresetDefinition { label: string; description: string; rules: z.input<typeof PolicyRuleSchema>[] }
const presetDefinitions: Record<Exclude<PolicyPresetName, "custom">, PresetDefinition> = {
  off: {
    label: "No approvals",
    description: "Branch Agent gets on with whatever its tools allow, without stopping to ask. This is how it behaves until you pick something else.",
    rules: [],
  },
  "ask-before-changes": {
    label: "Ask before changes",
    description: "Reading is free. Anything that changes a file, runs a command or acts on a web page waits for your yes.",
    rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }],
  },
  workspace: {
    label: "Just do it inside my workspace",
    description: "Writing files in your workspace is fine. Running commands and clicking or typing on web pages wait for your yes, and a new website is checked with you once.",
    rules: [
      { tool: "shell.execute", decision: "ask", remember: "session" },
      { tool: "browser.click", decision: "ask", remember: "session" },
      { tool: "browser.fill", decision: "ask", remember: "session" },
      // Sending one of your own files to a website is always worth a question, whatever site it is.
      { tool: "browser.upload", decision: "ask", remember: "session" },
      { tool: "browser.navigate", decision: "ask", remember: "always" },
      { tool: "web.*", decision: "ask", remember: "always" },
    ],
  },
  "read-only": {
    label: "Read only",
    description: "Branch Agent may look at things and answer, but may not change a file, run a command or act on a web page.",
    rules: [{ tool: "*", applies: "changes", decision: "deny" }],
  },
};

/** The rules a named preset expands to; the owner can edit them afterwards. */
export function presetRules(preset: PolicyPresetName): PolicyRule[] {
  if (preset === "custom") return [];
  return presetDefinitions[preset].rules.map((rule) => PolicyRuleSchema.parse(rule));
}
/** Every preset the owner can pick, with plain-language labels for the settings screen. */
export function policyPresets(): { id: PolicyPresetName; label: string; description: string; rules: PolicyRule[] }[] {
  return (Object.keys(presetDefinitions) as Exclude<PolicyPresetName, "custom">[]).map((id) => ({
    id,
    label: presetDefinitions[id].label,
    description: presetDefinitions[id].description,
    rules: presetRules(id),
  }));
}

/**
 * Permissions whose tools only look at things. Anything not listed here counts as a change, so a
 * tool added later (an MCP server's, for example) is treated as able to change something.
 */
const readOnlyPermissions = new Set([
  "files.read", "memory.read", "history.read", "skills.read",
  "documents.read", "web.read", "browser.read", "schedules.read", "user.ask",
  // Figures held only for this task, reports already written, watches, and the brief: all look-only.
  "data.read", "research.read", "monitors.read", "brief.read",
  // The shared scratch area is the task's own notepad: reading it touches nothing outside the task.
  "scratch.read",
]);
export const isReadOnlyPermission = (permission: string): boolean => readOnlyPermissions.has(permission);

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Pattern matching for rules: `*` stands for any text (a path separator included); everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  return new RegExp("^" + pattern.split("*").map(escaped).join(".*") + "$", "i").test(value);
}

/** What a call would touch, in the form rules match against: a path, a command, or a host. */
export function policyTarget(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (tool === "shell.execute")
    return [a.executable, ...(Array.isArray(a.args) ? a.args : [])].map((v) => String(v ?? "")).join(" ").trim().slice(0, 300);
  if (typeof a.url === "string") {
    try { return new URL(a.url).host; } catch { return a.url.slice(0, 300); }
  }
  if (typeof a.path === "string") return a.path.slice(0, 300);
  return "";
}

export interface PolicyRequest { tool: string; target: string; readOnly: boolean }
export interface PolicyOutcome { decision: PolicyDecision; rule: PolicyRule | null }
/** The first rule that matches decides; with no match the call goes ahead. */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyOutcome {
  for (const rule of policy.rules) {
    if (rule.applies === "changes" && request.readOnly) continue;
    if (!globMatches(rule.tool, request.tool)) continue;
    if (!globMatches(rule.match, request.target)) continue;
    return { decision: rule.decision, rule };
  }
  return { decision: "allow", rule: null };
}

/**
 * Tasks the owner did not start themselves (a trigger, a schedule, another AI tool over MCP) never
 * get more freedom than "Ask before changes": standing yeses do not apply to them. While no preset
 * is chosen there is nothing to hold them to, and they behave as before.
 */
export function cappedPolicy(policy: Policy, source: RunSource): Policy {
  if (source === "owner" || policy.preset === "off") return policy;
  return { ...policy, rules: [...policy.rules.filter((rule) => rule.decision !== "allow"), ...presetRules("ask-before-changes")] };
}

const policyKey = "policy";
/** The owner's saved policy, or the empty default when nothing is saved or the saved value is unreadable. */
export function readPolicy(store: Store, owner: string): Policy {
  const saved = PolicySchema.safeParse(store.get("settings", owner, policyKey)?.data ?? {});
  return saved.success ? saved.data : PolicySchema.parse({});
}
/** Saves a preset, a hand-edited rule list, or new limits; anything left out keeps its current value. */
export function savePolicy(store: Store, owner: string, input: unknown): Policy {
  const value = PolicyInputSchema.parse(input ?? {});
  const current = readPolicy(store, owner);
  const next: Policy = {
    preset: value.preset ?? (value.rules ? "custom" : current.preset),
    rules: value.rules ?? (value.preset ? presetRules(value.preset) : current.rules),
    limits: PolicyLimitsSchema.parse({ ...current.limits, ...value.limits }),
  };
  store.save("settings", owner, policyKey, next);
  return next;
}
/** Records a standing answer as a rule in front of the others, so it beats the broader ones. */
export function addPolicyRule(store: Store, owner: string, rule: z.input<typeof PolicyRuleSchema>): Policy {
  const current = readPolicy(store, owner);
  const next: Policy = { ...current, rules: [PolicyRuleSchema.parse(rule), ...current.rules].slice(0, 100) };
  store.save("settings", owner, policyKey, next);
  return next;
}
