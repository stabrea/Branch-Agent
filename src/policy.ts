import { z } from "zod";
import { audit } from "./audit.js";
import { globMatches, ResourceMatcherSchema, resourceMatches, type PolicyResource } from "./policy-resources.js";
import { sandboxChoices } from "./sandbox.js";
import { sandboxBackends } from "./sandbox-backends.js";
import type { Store } from "./store.js";

export { globMatches } from "./policy-resources.js";

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
    /**
     * What the rule is about: a folder, a website, a messaging account or a command. Left out, the
     * rule covers whatever the tool would touch, which is how every rule written before this behaves.
     */
    resource: ResourceMatcherSchema.optional(),
    /**
     * How tightly a program this rule covers is held: in a box with no way out to the internet, in
     * a box, or with no box. Left out, the tool does exactly what it did before rules could say.
     */
    sandbox: z.enum(sandboxChoices).optional(),
    /**
     * Where a program this rule covers actually runs: on this computer, in a container, on the
     * Linux side, or in Windows' own throwaway desktop (see src/sandbox-backends.ts). Left out it
     * runs on this computer, which is what everything did before rules could say otherwise.
     */
    backend: z.enum(sandboxBackends).optional(),
    /**
     * The folders of the workspace a program this rule covers may see. Empty means the whole
     * workspace, which is what every rule written before this behaves as.
     */
    paths: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
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

/**
 * Most rules one policy may hold. It is well above the number of tools this app has, because
 * deciding a whole kind of thing at once (see src/tool-categories.ts) writes one rule per tool.
 */
export const maximumPolicyRules = 300;
export const PolicyPresetSchema = z.enum(["off", "ask-before-changes", "workspace", "read-only", "custom"]);
export type PolicyPresetName = z.infer<typeof PolicyPresetSchema>;
export const PolicySchema = z
  .object({
    preset: PolicyPresetSchema.default("off"),
    rules: z.array(PolicyRuleSchema).max(maximumPolicyRules).default([]),
    limits: PolicyLimitsSchema.prefault({}),
    /**
     * A command on this computer that no rule says anything about: ask first, which is the default,
     * or let it through the way everything else that nothing matches is let through. A command is
     * the one thing that can do absolutely anything, so it is the one thing not left to silence.
     */
    unmatchedCommands: z.enum(["ask", "allow"]).default("ask"),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
export const PolicyInputSchema = z
  .object({
    preset: PolicyPresetSchema.optional(),
    rules: z.array(PolicyRuleSchema).max(maximumPolicyRules).optional(),
    limits: PolicyLimitsSchema.partial().optional(),
    unmatchedCommands: z.enum(["ask", "allow"]).optional(),
  })
  .strict();

/** Where a task came from. Anything but the owner's own app or command line is held to the "Ask before changes" preset. */
export type RunSource = "owner" | "trigger" | "schedule" | "mcp" | "a2a" | "acp";

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
      // A command line kept open is still a command line: every command sent to it asks, exactly
      // as a one-off command does, rather than one yes at the moment it was opened covering the lot.
      { tool: "shell.session.*", decision: "ask", remember: "session" },
      // Batch 26 (wave 8): a program on somebody else's computer always asks, whatever the rule
      // for commands here says. It is a different computer.
      { tool: "remote.run", decision: "ask", remember: "session" },
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
  // Looking at a picture or a sound file the person already has changes nothing.
  "media.read",
  // Figures held only for this task, reports already written, watches, and the brief: all look-only.
  "data.read", "research.read", "monitors.read", "brief.read",
  // The shared scratch area is the task's own notepad: reading it touches nothing outside the task.
  "scratch.read",
  // Saying what a call would do, and how the connections to other AI tools are faring, changes
  // nothing at all: nothing is run and nothing is written.
  "mcp.read",
  // Looking at what a program left running has printed changes nothing; starting or stopping one does.
  "process.read",
  // GitLab is read-only here: issues, releases and how the checks went.
  "gitlab.read",
]);
export const isReadOnlyPermission = (permission: string): boolean => readOnlyPermissions.has(permission);

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

export interface PolicyRequest {
  tool: string; target: string; readOnly: boolean;
  /** What the call is about, for rules that name a folder, a website, an account or a command. */
  resource?: PolicyResource | null | undefined;
}
export interface PolicyOutcome { decision: PolicyDecision; rule: PolicyRule | null }
/** Whether one rule covers this call: the tool, what it would touch, and the thing it is about. */
function ruleCovers(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.applies === "changes" && request.readOnly) return false;
  if (!globMatches(rule.tool, request.tool)) return false;
  if (!globMatches(rule.match, request.target)) return false;
  return rule.resource ? resourceMatches(rule.resource, request.resource) : true;
}
/**
 * The first rule that matches decides, and rules that name a particular folder, website, account or
 * command are looked at before the broader ones, so "never under finance" beats "files are fine".
 * Within each of those two groups the owner's own order is kept, so an older rule list is unchanged.
 */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyOutcome {
  const named = policy.rules.filter((rule) => rule.resource);
  const broad = policy.rules.filter((rule) => !rule.resource);
  for (const rule of [...named, ...broad]) if (ruleCovers(rule, request)) return { decision: rule.decision, rule };
  return unmatched(policy, request);
}
/**
 * Nothing matched. Everywhere else that means "go ahead", which is how Branch Agent has always
 * behaved and still does. A command on this computer is the exception: it can do anything at all,
 * including things no tool of Branch's own offers, so a command nobody has decided about is put to
 * the person rather than run on a guess. Saying yes to it writes a standing rule for that command,
 * so it is one question the first time and nothing afterwards.
 */
function unmatched(policy: Policy, request: PolicyRequest): PolicyOutcome {
  if (request.resource?.kind !== "command" || policy.unmatchedCommands === "allow")
    return { decision: "allow", rule: null };
  return {
    decision: "ask",
    rule: { tool: request.tool, match: request.target || "*", applies: "any", decision: "ask", remember: "always" },
  };
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
export function savePolicy(store: Store, owner: string, input: unknown, reason = "The approval settings were saved"): Policy {
  const value = PolicyInputSchema.parse(input ?? {});
  const current = readPolicy(store, owner);
  const next: Policy = {
    preset: value.preset ?? (value.rules ? "custom" : current.preset),
    rules: value.rules ?? (value.preset ? presetRules(value.preset) : current.rules),
    limits: PolicyLimitsSchema.parse({ ...current.limits, ...value.limits }),
    unmatchedCommands: value.unmatchedCommands ?? current.unmatchedCommands,
  };
  store.save("settings", owner, policyKey, next);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `${next.preset}, ${next.rules.length} rules`, reason, outcome: "saved" });
  return next;
}
/** Records a standing answer as a rule in front of the others, so it beats the broader ones. */
export function addPolicyRule(store: Store, owner: string, rule: z.input<typeof PolicyRuleSchema>): Policy {
  const current = readPolicy(store, owner);
  const added = PolicyRuleSchema.parse(rule);
  const next: Policy = { ...current, rules: [added, ...current.rules].slice(0, maximumPolicyRules) };
  store.save("settings", owner, policyKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: `${added.tool} on ${added.match}`,
    reason: `A standing "${added.decision}" was remembered from a question you answered`, outcome: "saved",
  });
  return next;
}
