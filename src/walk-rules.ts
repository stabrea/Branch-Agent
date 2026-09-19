import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { evaluatePolicy, type Policy, type PolicyRule } from "./policy.js";
import { globMatches, type PolicyResource } from "./policy-resources.js";

/**
 * mac7/walk-rules: a tool that walks a folder (a search, a listing, a map, a knowledge base's
 * folder, a snapshot) is judged by the rules for every file and folder it lists or reads, not only
 * for the folder it starts from. "Never anything under finance" keeps `finance` out of a search of
 * the whole workspace: the folder is not gone into and its files are neither listed nor read. What
 * was left out is said once, in plain words, naming the folder and never what is in it.
 *
 * The runtime builds the check for one walk (`Runtime.pathCheck`): the task's rules as they are now
 * — the owner's rules, the conversation's mode, folder trust, a task from outside held to "Ask
 * before changes", a household person's role, Lockdown — read once, then weighed per entry here.
 */

/** Listing a name, or reading what is inside. */
export type PathAccess = "list" | "read";
/** May this task list (or read) this path, written from the folder the file tools work in? */
export type PathCheck = (path: string, kind: PathAccess) => boolean;
/** No rules to weigh: the owner's own window, and anything that is not a task's walk. */
export const allowAll: PathCheck = () => true;

/** The file tools a listing and a reading are, so a rule about either holds inside any walker. */
const accessTools: Record<PathAccess, string> = { list: "files.list", read: "files.read" };

/** One name per folder, forward slashes, no "." steps: the form rules compare paths in. */
export function tidyWalkPath(value: string): string {
  const kept: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(part);
  }
  return kept.join("/");
}
const parentOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export interface WalkCheckInput {
  policy: Policy;
  /** The walking tool itself; its own rules count as well as those about reading and listing files. */
  tool: string;
  /** What a path is, for the rules (the registry's answer, with the workspace-written form). */
  resourceOf: (tool: string, path: string) => PolicyResource | null;
  /** The folder of the workspace paths are read inside ("" for the workspace itself). */
  scope?: string;
  /** True for Branch's own files, which no task may read whatever the rules say. */
  guarded?: (path: string) => boolean;
}

/**
 * The check for one walk. A path is left out when a rule refuses it, or when a rule about that path
 * asks first (a walk cannot stop to ask about each file; the task can still ask for it by name). A
 * question every call gets anyway — the broad rules — was already answered for the walk itself.
 * Folders no rule can single out anything inside are remembered, so their files cost nothing more.
 */
export function walkCheck(input: WalkCheckInput): PathCheck {
  const specific = input.policy.rules.filter((rule) => singlesOut(rule, input.tool));
  const broad = new Map<string, PolicyRule | null>();
  const baseline = (tool: string): PolicyRule | null => {
    if (!broad.has(tool)) broad.set(tool, evaluatePolicy(input.policy, { tool, target: "", readOnly: true, resource: null }).rule);
    return broad.get(tool) ?? null;
  };
  const clear = new Map<string, boolean>();
  const folderIsClear = (folder: string): boolean => {
    if (!clear.has(folder)) clear.set(folder, !specific.some((rule) => couldReachInside(rule, folder, input.scope ?? "")));
    return clear.get(folder)!;
  };
  return (path, kind) => {
    const tidy = tidyWalkPath(path);
    if (input.guarded?.(tidy)) return false;
    if (!specific.length || folderIsClear(parentOf(tidy))) return true;
    return [...new Set([input.tool, accessTools[kind]])].every((tool) => {
      const outcome = evaluatePolicy(input.policy, { tool, target: tidy, readOnly: true, resource: input.resourceOf(tool, tidy) });
      return outcome.decision === "allow" || (outcome.decision === "ask" && outcome.rule === baseline(tool));
    });
  };
}

/** A rule that can ask about or refuse a particular path while this walk reads or lists. */
function singlesOut(rule: PolicyRule, tool: string): boolean {
  if (rule.decision === "allow" || rule.applies === "changes") return false;
  if (![tool, ...Object.values(accessTools)].some((name) => globMatches(rule.tool, name))) return false;
  return rule.resource ? rule.resource.kind === "path" : rule.match !== "*";
}

/** Whether a rule's folder or path pattern could name something inside `folder` ("" is the top). */
function couldReachInside(rule: PolicyRule, folder: string, scope: string): boolean {
  const pattern = tidyWalkPath(rule.resource?.pattern ?? rule.match).toLowerCase();
  const here = folder.toLowerCase();
  const inWorkspace = scope ? tidyWalkPath(`${scope}/${folder}`).toLowerCase() : here;
  return reaches(pattern, here) || reaches(pattern, inWorkspace);
}
function reaches(pattern: string, folder: string): boolean {
  if (folder === "") return true;
  const within = `${folder}/`, star = pattern.indexOf("*");
  if (star < 0) return `${pattern}/`.startsWith(within) || within.startsWith(`${pattern}/`);
  const fixed = pattern.slice(0, star);
  return within.startsWith(fixed) || fixed.startsWith(within);
}

/**
 * One walk's bookkeeping: each folder is decided once, and what was left out is gathered so the
 * answer can say so once. Paths are as the walker writes them (from the folder the file tools use).
 */
export class WalkRules {
  private readonly folders = new Map<string, boolean>();
  private readonly leftOut = new Map<string, { folder: boolean; files: number }>();
  constructor(private readonly check: PathCheck = allowAll) {}

  /** A walk that starts inside a place the rules keep this task out of is refused outright. */
  start(path: string): void {
    const tidy = tidyWalkPath(path);
    if (tidy && !this.folder(tidy)) throw new Error(walkRefusal(tidy));
  }
  /** May this folder be gone into (and named)? Decided once per walk. */
  folder(path: string): boolean {
    const tidy = tidyWalkPath(path);
    if (!this.folders.has(tidy)) {
      const allowed = this.check(tidy, "list");
      this.folders.set(tidy, allowed);
      if (!allowed) this.leftOut.set(tidy, { folder: true, files: 0 });
    }
    return this.folders.get(tidy)!;
  }
  /** May this file be listed, or read? A file left out is counted against its folder, never named. */
  file(path: string, kind: PathAccess = "read"): boolean {
    const tidy = tidyWalkPath(path), key = `${kind}:${tidy}`;
    const known = this.files.get(key);
    if (known !== undefined) return known;
    const allowed = this.check(tidy, kind);
    this.files.set(key, allowed);
    if (allowed) return true;
    const folder = parentOf(tidy), seen = this.leftOut.get(folder) ?? { folder: false, files: 0 };
    this.leftOut.set(folder, { ...seen, files: seen.files + 1 });
    return false;
  }
  /** Each file is decided once per walk, so a file seen twice (two passages of it) is counted once. */
  private readonly files = new Map<string, boolean>();
  /** Whether anything was left out. */
  get anyLeftOut(): boolean {
    return this.leftOut.size > 0;
  }
  /** The one plain sentence about what was left out, or undefined when nothing was. */
  note(): string | undefined {
    if (!this.leftOut.size) return undefined;
    const places = [...this.leftOut].map(([folder, what]) => what.folder
      ? `the folder ${folder}`
      : `${what.files} ${what.files === 1 ? "file" : "files"} in ${folder || "the top folder"}`);
    const shown = places.slice(0, 5).join("; ") + (places.length > 5 ? `; and ${places.length - 5} more places` : "");
    return `Some things were left out because the owner's rules keep this task out of them: ${shown}. Nothing from them is shown here.`;
  }
  /** The answer with the note added when something was left out. */
  noted<T extends object>(result: T): T & { leftOut?: string } {
    const note = this.note();
    return note ? { ...result, leftOut: note } : result;
  }
}

/** The refusal for a walk that starts in a place the rules keep the task out of. */
export const walkRefusal = (path: string): string =>
  `Your settings do not allow looking in ${path}. Nothing was read. Tell the person what you wanted to look for, and why.`;

/** Whether a passage kept from a file may be handed back under `rules`; an accepted fact card has no file. */
export const passageVisible = (rules: WalkRules, docId: string): boolean => docId.startsWith("card:") || rules.file(docId);

/**
 * The same rules for a walker that goes by full addresses (a notes folder the owner named): a place
 * inside `base` is judged by its path from there; a place outside it is not the workspace's, so the
 * rules, which are about the workspace's folders, have nothing to say about it.
 */
export function byFullAddress(rules: WalkRules, base: string): (absolute: string, folder: boolean) => boolean {
  let root = base;
  try { root = realpathSync(base); } catch { /* a folder that is not there yet is compared as written */ }
  return (absolute, folder) => {
    const from = relative(root, absolute);
    if (!from || from.startsWith("..") || isAbsolute(from)) return true;
    const path = from.split(/[\\/]/).join("/");
    return folder ? rules.folder(path) : rules.file(path);
  };
}
