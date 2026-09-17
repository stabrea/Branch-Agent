import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import type { ToolContext } from "./contracts.js";
import { folderTrustMode } from "./folder-trust.js";
import { lockedDown } from "./lockdown.js";
import type { RunSource } from "./policy.js";
import type { RunGuards } from "./run-guards.js";
import type { PolicyCheck } from "./runtime.js";
import type { Store } from "./store.js";

/**
 * mac5/manual-actions: the one gate a tool run outside a conversation goes through
 * (`Runtime.executeTool`). A conversation's own calls keep their gate in the runtime; this is for
 * the rest — a tool pressed by hand in the app window, the code editor's save, a saved workflow's
 * step, a flow box, a live voice call, the pull-request hook.
 *
 * - "owner": the owner pressed it in the app window, so the owner is the one asking and an
 *   "ask first" rule they wrote does not stop it. Everything else still does: a refusing rule,
 *   Branch's own files (never-break), Lockdown and an untrusted folder for anything that changes
 *   something, and the sandbox a rule asks for.
 * - "policy": work that runs by itself is held exactly as a task is — "ask" comes back as
 *   `ApprovalRequiredError`, bound to the exact bytes, for the caller to put to the owner.
 */
export type ToolGateMode = "owner" | "policy";

export interface ToolGateOptions {
  mode?: ToolGateMode;
  /** Who set the work going; decides how far the approval rules are capped. Owner by default. */
  source?: RunSource;
  /** Where yeses already given are remembered (a workflow's or conversation's key). */
  approvalKey?: string;
}

export interface ToolGateHost {
  readonly store: Store;
  readonly owner: string;
  readonly guards: RunGuards;
  checkPolicy(tool: string, args: unknown, context: ToolContext, fingerprint?: string): PolicyCheck;
  /** The OS sandbox wall, decided exactly as for a task's call: the owner's switch, tightened by rules. */
  wallFor(tool: string, args: unknown, context: ToolContext, choice: PolicyCheck["sandbox"]): Pick<ToolContext, "osSandbox">;
}

export const lockdownManualRefusal =
  "Lockdown is on, so nothing that changes anything is done by hand either. Turn Lockdown off in Settings to allow this again.";
export const untrustedManualRefusal =
  "This folder is not trusted, so nothing that changes anything in it is done by hand. Trust the folder in Settings first.";

function refused(tool: string, label: string, reason?: string): PolicyRefusedError {
  const error = new PolicyRefusedError(tool, label);
  if (reason) error.message = reason;
  return error;
}

/** Lockdown and an untrusted folder speak as "ask"; for a hand-pressed change they are a refusal. */
function ownerHold(host: ToolGateHost, check: PolicyCheck): string | null {
  if (check.readOnly) return null;
  if (lockedDown(host.store, host.owner)) return lockdownManualRefusal;
  if (folderTrustMode(host.store, host.owner) !== "off" && host.guards.trust() === "untrusted") return untrustedManualRefusal;
  return null;
}

export type SandboxScope = Pick<ToolContext, "sandbox" | "sandboxBackend" | "sandboxPaths" | "osSandbox">;

/** What the owner pressing a tool by hand gets: a refusal with its reason, a question, or a go. */
export interface ManualVerdict {
  decision: "allow" | "ask" | "deny";
  label: string;
  target: string;
  reason: string | null;
  scope: SandboxScope;
}

/** Where the call runs: the rule's own sandbox choice and the wall, never anything the caller brought. */
export function scopeOf(host: ToolGateHost, tool: string, args: unknown, context: ToolContext, check: PolicyCheck): SandboxScope {
  return {
    ...host.wallFor(tool, args, context, check.sandbox),
    ...(check.sandbox ? { sandbox: check.sandbox } : {}),
    ...(check.backend ? { sandboxBackend: check.backend } : {}),
    ...(check.paths?.length ? { sandboxPaths: check.paths } : {}),
  };
}

/**
 * The owner's own hand-pressed call. "ask" is left only when a rule the owner wrote asked; Lockdown
 * and an untrusted folder, which speak as "ask", are a refusal here for anything that changes.
 */
export function manualVerdict(host: ToolGateHost, tool: string, args: unknown, context: ToolContext, fingerprint: string): ManualVerdict {
  const check = host.checkPolicy(tool, args, context, fingerprint);
  const base = { label: check.label, target: check.target, scope: scopeOf(host, tool, args, context, check) };
  if (check.decision === "deny") return { ...base, decision: "deny", reason: check.reason ?? null };
  const held = ownerHold(host, check);
  if (held) return { ...base, decision: "deny", reason: held };
  return { ...base, decision: check.decision, reason: null };
}

/**
 * Decides one call. Throws `PolicyRefusedError` or `ApprovalRequiredError`; otherwise answers with
 * the sandbox the matching rule wants, to be put on the context the tool runs with.
 */
export function gateToolUse(host: ToolGateHost, tool: string, args: unknown, context: ToolContext,
  fingerprint: string, mode: ToolGateMode = "owner"): SandboxScope {
  if (mode === "owner") {
    // The owner is the one asking, so an "ask first" rule of theirs does not stop it.
    const verdict = manualVerdict(host, tool, args, context, fingerprint);
    if (verdict.decision === "deny") throw refused(tool, verdict.label, verdict.reason ?? undefined);
    return verdict.scope;
  }
  const check = host.checkPolicy(tool, args, context, fingerprint);
  if (check.decision === "deny") throw refused(tool, check.label, check.reason);
  if (check.decision === "ask") throw new ApprovalRequiredError(tool, check.target, check.label, check.remember, fingerprint);
  return scopeOf(host, tool, args, context, check);
}
