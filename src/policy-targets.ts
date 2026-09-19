import type { ToolContext, ToolTarget } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { evaluatePolicy, type Policy, type PolicyDecision, type PolicyRule } from "./policy.js";
import { globMatches, resourceOf, tidyPath } from "./policy-resources.js";

/**
 * mac7/multi-target: a call that touches several things — a patch across files, two documents
 * compared, a knowledge base made from a list of folders, a repository folder — is judged on every
 * one of them. Each is weighed by the owner's rules as if the call touched only it, and the call goes
 * ahead only when every one is allowed: the strictest answer wins, and a refusal names the thing that
 * was refused. The call as a whole is still judged as it always was; this only ever adds to that.
 */

/** What the rules see of one target: the path as written, or a web address's host. */
export function targetText(target: ToolTarget): string {
  if (target.path !== undefined) return target.path;
  if (target.url === undefined) return "";
  try { return new URL(target.url).host; } catch { return target.url.slice(0, 300); }
}

const strictness: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };
/** Whether `a` is a stricter answer than `b`. */
export const stricterThan = (a: PolicyDecision, b: PolicyDecision): boolean => strictness[a] > strictness[b];

export interface TargetsVerdict {
  decision: PolicyDecision;
  /** The rule that gave the strictest answer, when a rule did. */
  rule: PolicyRule | null;
  /** The first target that got the strictest answer; null when every one was allowed. */
  target: ToolTarget | null;
}

export interface TargetsCall { tool: string; permission: string; callTarget: string; args: unknown }

/** Every target weighed by the rules; the strictest answer, and which target gave it. */
export function judgeTargets(policy: Policy, call: TargetsCall, targets: readonly ToolTarget[]): TargetsVerdict {
  let worst: TargetsVerdict = { decision: "allow", rule: null, target: null };
  for (const target of targets) {
    const text = targetText(target);
    const outcome = evaluatePolicy(policy, {
      tool: call.tool, target: text, readOnly: target.kind === "read",
      resource: resourceOf(call.tool, call.permission, text, call.args), callTarget: call.callTarget,
    });
    if (stricterThan(outcome.decision, worst.decision)) worst = { decision: outcome.decision, rule: outcome.rule, target };
    const inner = innerFolderRule(policy, call, target);
    if (inner && stricterThan(inner.decision, worst.decision))
      worst = { decision: inner.decision, rule: inner, target: { kind: target.kind, path: inner.resource!.pattern } };
    if (worst.decision === "deny") break;
  }
  return worst;
}

/**
 * Integration (multi-target): a target that is a whole folder also reaches every folder inside it, so
 * a rule that asks about or refuses one of those counts: "never anything under finance" refuses a
 * repository diff of the workspace that holds finance, which would show finance's lines. Only rules
 * that ask or refuse are read this way; an allow for a folder inside never lets the whole one through.
 */
function innerFolderRule(policy: Policy, call: TargetsCall, target: ToolTarget): PolicyRule | null {
  if (!target.folder || target.path === undefined) return null;
  const folder = tidyPath(target.path).toLowerCase();
  return policy.rules.find((rule) => rule.resource?.kind === "path" && rule.decision !== "allow"
    && !(rule.applies === "changes" && target.kind === "read")
    && globMatches(rule.tool, call.tool) && globMatches(rule.match, target.path!)
    && couldBeInside(tidyPath(rule.resource.pattern).toLowerCase(), folder)) ?? null;
}

/** Whether a folder pattern ("finance", "*.csv", "fin*") can name something inside `folder` ("" is the workspace). */
function couldBeInside(pattern: string, folder: string): boolean {
  if (folder === "" || folder === ".") return true;
  const within = `${folder}/`, star = pattern.indexOf("*");
  // A plain folder name is a whole name: "fin" is not inside "finance".
  if (star < 0) return `${pattern}/`.startsWith(within) || within.startsWith(`${pattern}/`);
  const fixed = pattern.slice(0, star);
  return within.startsWith(fixed) || fixed.startsWith(within);
}

const verbs: Record<ToolTarget["kind"], string> = { read: "read", write: "change", delete: "delete" };
/** What doing it to one target means, in plain words: "change finance/q1.csv". */
export const targetAction = (target: ToolTarget): string => `${verbs[target.kind]} ${targetText(target)}`;

/** The refusal when one of several targets is not allowed, naming it. */
export const targetRefusal = (label: string, target: ToolTarget): string =>
  `Your settings do not allow this: ${label}, because it would ${targetAction(target)}. Nothing was done. Tell the person what you wanted to do, and why.`;

/** The refusal when what a call would touch cannot be worked out. */
export const unknownTargetsRefusal = (problem: string): string =>
  `Branch could not tell every file this would touch, so it was not done: ${problem}`;

/**
 * For the places that weigh only the rules (another AI tool's dry run, "Try a tool" without the
 * runtime's gate): the whole call's answer made stricter by every thing it touches. A call whose
 * targets cannot be told is refused, as it would be when run.
 */
export function everyTargetDecision(
  registry: Pick<ToolRegistry, "targetsOf">, policy: Policy, call: TargetsCall, context: ToolContext, whole: PolicyDecision,
): { decision: PolicyDecision; targets: ToolTarget[] } {
  let targets: ToolTarget[] | null;
  try { targets = registry.targetsOf(call.tool, call.args, context); } catch { return { decision: "deny", targets: [] }; }
  if (!targets) return { decision: whole, targets: [] };
  const spread = judgeTargets(policy, call, targets).decision;
  return { decision: stricterThan(spread, whole) ? spread : whole, targets };
}
