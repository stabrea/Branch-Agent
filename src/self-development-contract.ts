import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit, auditOrigins, type AuditOrigin } from "./audit.js";
import type { ToolContext } from "./contracts.js";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import { cwdOf } from "./never-break/protected.js";
import { isReadOnlyPermission } from "./policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * Q12: Branch changing its own source is bound to a contract written down before the first change.
 *
 * `branch.prepare_source_change` asks the model to propose the terms (which paths, which tools, which
 * tests, what "done" means, what else it touches, how to undo it). Branch adds what the model may not
 * choose: the exact source commit and the worktree. The contract is stored once, with a hash of its
 * contents, in a table that refuses edits and removals. Every call that could change something inside
 * `branch-agent-source` is then checked against it (`contractGuard`, run by `ToolRegistry.execute`).
 * A call outside the contract is refused and written in the audit record. A wider contract is a new
 * revision, made only by `branch.widen_source_contract`, which the owner is asked about every time.
 */
export const sourceFolder = "branch-agent-source";
export const prepareToolName = "branch.prepare_source_change";
export const widenToolName = "branch.widen_source_contract";
export const widenReason = "Branch asks you every time before it widens what it may change in its own source";
const worktreePattern = /^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/;
const shaPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const relativeGlob = z.string().trim().min(1).max(200).refine(
  (value) => !value.startsWith("/") && !/[\\:\0]/.test(value) && !value.split("/").includes(".."),
  "Use a path inside the worktree, written with forward slashes and without ..",
);
export const ContractTermsSchema = z.object({
  allowedPaths: z.array(relativeGlob).min(1).max(50),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)).min(1).max(50),
  expectedTests: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  definitionOfDone: z.string().trim().min(1).max(2000),
  sideEffects: z.array(z.string().trim().min(1).max(300)).max(30),
  rollbackPlan: z.string().trim().min(1).max(2000),
}).strict();
export type ContractTerms = z.infer<typeof ContractTermsSchema>;

export interface SelfDevelopmentContract extends ContractTerms {
  taskRunId: string;
  sourceSha: string;
  worktreePath: string;
  revision: number;
  createdAt: string;
  /** Empty for the first revision; the owner who allowed a widening afterwards. */
  approvedBy: string;
  reason: string;
}

/** JSON with every object's keys in order, so the same contract always hashes the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const contractHash = (contract: SelfDevelopmentContract): string =>
  createHash("sha256").update(canonical(contract)).digest("hex");

/** Makes the contracts table and the two rules that refuse any change or removal, once. */
export function ensureContractTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS self_development_contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL, worktree TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(owner, worktree, revision));
    CREATE TRIGGER IF NOT EXISTS self_development_contracts_no_update BEFORE UPDATE ON self_development_contracts
      BEGIN SELECT RAISE(ABORT, 'A self-development contract cannot be changed; widen it with a new revision'); END;
    CREATE TRIGGER IF NOT EXISTS self_development_contracts_no_delete BEFORE DELETE ON self_development_contracts
      BEGIN SELECT RAISE(ABORT, 'A self-development contract cannot be removed'); END;`);
}

/** The written contracts: one row per revision, never changed or removed once written. */
export class ContractBook {
  constructor(private readonly db: DatabaseSync) {
    ensureContractTable(this.db);
  }
  /** Writes the first revision. Refused when the worktree already has a contract. */
  create(owner: string, input: { taskRunId: string; sourceSha: string; worktreePath: string; terms: ContractTerms }): SelfDevelopmentContract {
    if (!worktreePattern.test(input.worktreePath)) throw new Error("A contract is only for a Branch Agent self-development worktree.");
    if (!shaPattern.test(input.sourceSha)) throw new Error("A contract needs the exact source commit.");
    if (this.history(owner, input.worktreePath).length)
      throw new Error(`${input.worktreePath} already has a contract. Widening it needs ${widenToolName} and the owner's yes.`);
    return this.insert(owner, { ...ContractTermsSchema.parse(input.terms), taskRunId: input.taskRunId.slice(0, 64),
      sourceSha: input.sourceSha, worktreePath: input.worktreePath, revision: 1, createdAt: new Date().toISOString(), approvedBy: "", reason: "" });
  }
  /**
   * Writes the next revision with the changed terms. Only `branch.widen_source_contract` calls this,
   * after the owner said yes to that exact request; the revisions before stay as they were.
   */
  widen(owner: string, worktreePath: string, input: { taskRunId: string; terms: { [K in keyof ContractTerms]?: ContractTerms[K] | undefined }; approvedBy: string; reason: string }): SelfDevelopmentContract {
    const current = this.current(owner, worktreePath);
    if (!current) throw new Error(`${worktreePath} has no contract to widen.`);
    if (!input.approvedBy.trim()) throw new Error("Widening a contract needs the owner's approval.");
    const terms: ContractTerms = { allowedPaths: current.allowedPaths, permissions: current.permissions, expectedTests: current.expectedTests,
      definitionOfDone: current.definitionOfDone, sideEffects: current.sideEffects, rollbackPlan: current.rollbackPlan };
    const changed = Object.fromEntries(Object.entries(input.terms).filter(([, value]) => value !== undefined));
    const next = ContractTermsSchema.parse({ ...terms, ...changed });
    return this.insert(owner, { ...next, taskRunId: input.taskRunId.slice(0, 64), sourceSha: current.sourceSha, worktreePath,
      revision: current.revision + 1,
      createdAt: new Date().toISOString(), approvedBy: input.approvedBy.slice(0, 120), reason: input.reason.slice(0, 500) });
  }
  /** The newest revision, or null. Throws when any revision no longer matches its hash. */
  current(owner: string, worktreePath: string): SelfDevelopmentContract | null {
    return this.history(owner, worktreePath).at(-1) ?? null;
  }
  /** Every revision, oldest first, each checked against the hash written beside it. */
  history(owner: string, worktreePath: string): SelfDevelopmentContract[] {
    const rows = this.db.prepare("SELECT revision, body, hash FROM self_development_contracts WHERE owner=? AND worktree=? ORDER BY revision")
      .all(owner, worktreePath);
    return rows.map((row, at) => {
      const contract = JSON.parse(String(row.body)) as SelfDevelopmentContract;
      if (contractHash(contract) !== String(row.hash) || contract.revision !== at + 1 || Number(row.revision) !== at + 1
        || contract.worktreePath !== worktreePath)
        throw new Error(`The contract for ${worktreePath} (revision ${String(row.revision)}) does not match its hash; it was changed after it was written.`);
      return contract;
    });
  }
  private insert(owner: string, contract: SelfDevelopmentContract): SelfDevelopmentContract {
    this.db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
      .run(owner, contract.worktreePath, contract.revision, JSON.stringify(contract), contractHash(contract), contract.createdAt);
    return contract;
  }
}

export const firstContractReason = "Branch asks you every time before it starts changing its own source";

/** The paths and tools a proposed contract asks for, in plain words, for the owner's question. */
function askedFor(terms: unknown): string {
  const asked = (terms ?? {}) as { allowedPaths?: unknown; permissions?: unknown };
  const list = (value: unknown, none: string): string =>
    Array.isArray(value) && value.length ? value.map(String).join(", ").slice(0, 400) : none;
  return `It would be allowed to change ${list(asked.allowedPaths, "no new paths")}, using ${list(asked.permissions, "no new tools")}.`;
}

/**
 * The first contract and every wider one are put to the owner, once each, whatever the rules say,
 * so a model can never give itself `**` and every tool. The question names the paths and tools asked for.
 */
export function contractHold(tool: string, args: unknown): { reason: string; onceOnly: true } | null {
  const input = (args ?? {}) as { contract?: unknown; changes?: unknown };
  if (tool === prepareToolName) return { reason: `${firstContractReason}. ${askedFor(input.contract)}`, onceOnly: true };
  if (tool === widenToolName) return { reason: `${widenReason}. ${askedFor(input.changes)}`, onceOnly: true };
  return null;
}

/** A path glob: `**` spans folders, `*` and `?` stay inside one name, a trailing `/` means the whole folder. */
export function globFits(pattern: string, path: string): boolean {
  const whole = pattern.endsWith("/") ? `${pattern}**` : pattern;
  const source = whole.split(/(\*\*\/|\*\*|\*|\?)/).map((part) =>
    part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
      : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${source}$`, "s").test(path);
}

const tidy = (value: string): string => value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
/** A path with its links followed: the nearest part that exists is read back from the disk, the rest kept as written. */
function onDisk(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  try { return join(realpathSync.native(existing), ...rest); } catch { return path; }
}
/**
 * The one spelling of a path inside the source folder. macOS and Windows find `Branch-Agent-Source`,
 * `BRANCH-AGENT-SOURCE` and (on Windows) `branch-agent-source.` or `branch-agent-source ` as the same
 * folder, so the folder, `.branch-worktrees` and the worktree's name are compared lowercased with
 * trailing dots and spaces taken off, on every platform: a spelling that is not the same folder on
 * this disk is still held to the contract, which fails closed. The rest keeps its case, so a
 * differently spelled file inside the worktree must still fit the allowed paths as written.
 */
function sourceSpelling(path: string): string {
  const parts = path.split("/").map((part) => part.replace(/[. ]+$/, "") || part);
  if (parts[0]?.toLowerCase() !== sourceFolder) return path;
  return [...parts.slice(0, 3).map((part) => part.toLowerCase()), ...parts.slice(3)].join("/");
}
/** Where a path named from `scope` really is, from the workspace, or null when it is outside it. */
export function workspacePath(workspace: string, scope: string, path: string): string | null {
  const root = onDisk(resolve(workspace));
  const full = onDisk(resolve(workspace, scope, path));
  const inside = relative(root, full);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  return sourceSpelling(tidy(inside));
}
const insideSource = (path: string): boolean => path === sourceFolder || path.startsWith(`${sourceFolder}/`);
/** The self-development worktree a workspace path is in, or "" for the protected checkout itself. */
export function worktreeOf(path: string): string {
  const match = /^branch-agent-source\/\.branch-worktrees\/[^/]+/.exec(path);
  return match && worktreePattern.test(match[0]) ? match[0] : "";
}

export interface ContractGuardDeps {
  store: Store;
  owner: string;
  workspace: string;
  registry: ToolRegistry;
  book: ContractBook;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
}

/** The workspace paths (forward slashes, from the workspace) a call names. */
function pathsOf(deps: ContractGuardDeps, name: string, args: unknown, context: ToolContext, scope: string): string[] {
  const named: string[] = [];
  const many = deps.registry.targetsOf(name, args, context);
  if (many) for (const one of many) { if (one.path) named.push(one.path); }
  else {
    const target = deps.registry.targetOf(name, args, context);
    const resource = target ? deps.registry.resourceOf(name, target, args) : null;
    if (resource?.kind === "path") named.push(resource.value);
  }
  // A command's working folder counts too, so a command started from the workspace inside a worktree is held to it.
  const cwd = cwdOf(args).cwd;
  if (cwd) named.push(cwd);
  return named.map((path) => workspacePath(deps.workspace, scope, path)).filter((path): path is string => path !== null);
}

/** Why the call breaks the contract's worktree, tools or paths, or null when it keeps to them. */
function termsBroken(contract: SelfDevelopmentContract, name: string, paths: string[]): string | null {
  if (!contract.permissions.includes(name))
    return `${name} is not one of the tools this contract allows (${contract.permissions.join(", ")}).`;
  for (const path of paths) {
    const worktree = worktreeOf(path);
    if (worktree !== contract.worktreePath) return `${path} is outside the contract's worktree ${contract.worktreePath}.`;
    const inside = path.slice(worktree.length + 1);
    if (inside && !contract.allowedPaths.some((pattern) => globFits(pattern, inside)))
      return `${inside} is outside the contract's allowed paths (${contract.allowedPaths.join(", ")}).`;
  }
  return null;
}

/** Why a remote step breaks the contract (the source commit, or a changed file outside it), or null. */
async function remoteBroken(deps: ContractGuardDeps, contract: SelfDevelopmentContract, signal: AbortSignal): Promise<string | null> {
  const cwd = resolve(deps.workspace, contract.worktreePath);
  const git = (args: string[]) => deps.git({ cwd, args, timeoutMs: 60_000 }, signal);
  if ((await git(["merge-base", "--is-ancestor", contract.sourceSha, "HEAD"])).status !== "completed")
    return `This worktree no longer starts from the contract's source commit ${contract.sourceSha.slice(0, 12)}.`;
  const changed = await git(["diff", "--name-only", "-z", contract.sourceSha]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (changed.status !== "completed" || untracked.status !== "completed") return "Branch could not list what changed in this worktree.";
  const files = `${changed.stdout}\0${untracked.stdout}`.split("\0").map(tidy).filter(Boolean);
  const outside = files.filter((file) => !contract.allowedPaths.some((pattern) => globFits(pattern, file)));
  return outside.length ? `These changed files are outside the contract's allowed paths: ${outside.slice(0, 10).join(", ")}.` : null;
}

/**
 * Writes the refusal down, then refuses the call. The refusal is Branch's own ("system"), made
 * against the task named as the actor; what started that task goes in the origin column. The owner
 * did not do this, so the row does not say they did.
 */
function refuse(deps: ContractGuardDeps, context: ToolContext, name: string, worktree: string, why: string): never {
  // A task says nothing of where it came from when the owner started it, as elsewhere (`context.source ?? "owner"`).
  const from = context.source ?? "owner";
  const started = (auditOrigins as readonly string[]).includes(from) ? { origin: from as AuditOrigin } : {};
  audit(deps.store, deps.owner, { action: "self_development.contract", actor: context.runId ? `task:${context.runId}`.slice(0, 120) : "Branch",
    subject: `${name} in ${worktree || sourceFolder}`.slice(0, 300), reason: why.slice(0, 500), source: "system", ...started,
    runId: context.runId ? context.runId.slice(0, 64) : null, outcome: "refused" });
  throw new Error(`Refused by the self-development contract: ${why}`);
}

const remotePermissions = new Set(["git.remote", "github.manage"]);

/**
 * The check `ToolRegistry.execute` runs before a tool does anything. Calls that only look, and calls
 * that touch nothing inside `branch-agent-source`, pass untouched. Everything else needs the
 * worktree's contract and must keep to it; a remote step also needs the contract's source commit
 * underneath it and no changed file outside the allowed paths.
 */
export function contractGuard(deps: ContractGuardDeps): (name: string, args: unknown, context: ToolContext) => Promise<void> {
  return async (name, args, context) => {
    if (name === prepareToolName || name === widenToolName) return;
    const permission = deps.registry.permissionOf(name);
    if (isReadOnlyPermission(permission)) return;
    const scope = workspacePath(deps.workspace, "", deps.registry.pathScope() || ".") ?? "";
    let paths: string[];
    try { paths = pathsOf(deps, name, args, context, scope); } catch (error) {
      // Outside the source the approval policy already refuses a call whose targets cannot be told.
      if (!insideSource(scope)) return;
      refuse(deps, context, name, worktreeOf(scope), `Branch could not tell what this call would change: ${(error as Error).message}`);
    }
    if (!insideSource(scope) && !paths.some(insideSource)) return;
    const worktree = worktreeOf(insideSource(scope) ? scope : paths.find(insideSource)!);
    if (!worktree) refuse(deps, context, name, "", "The protected Branch Agent source checkout is never changed directly; work in a self-development worktree.");
    let contract: SelfDevelopmentContract | null;
    try { contract = deps.book.current(deps.owner, worktree); } catch (error) { refuse(deps, context, name, worktree, (error as Error).message); }
    if (!contract) refuse(deps, context, name, worktree, `no contract: ${worktree} has no self-development contract, so nothing in it may be changed.`);
    const broken = termsBroken(contract, name, paths)
      ?? (remotePermissions.has(permission) ? await remoteBroken(deps, contract, context.signal) : null);
    if (broken) refuse(deps, context, name, worktree, broken);
  };
}
