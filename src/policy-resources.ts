import { z } from "zod";
import { sandboxSentences, type SandboxChoice } from "./sandbox.js";
import { commandCovers, exactCommandPattern } from "./command-prefix.js";

/**
 * What a rule is *about*, beyond the tool's name: a folder in the workspace, a website, a messaging
 * account, or a command. A rule without one of these means "whatever this tool would touch", which
 * is how every rule written before this existed still behaves.
 */
export const resourceKinds = ["path", "host", "channel", "command"] as const;
export type ResourceKind = (typeof resourceKinds)[number];

export const ResourceMatcherSchema = z
  .object({
    kind: z.enum(resourceKinds),
    /** A folder or file pattern, a website name, a messaging account, or a command name. `*` fits any text. */
    pattern: z.string().trim().min(1).max(300),
    /**
     * Integration review (mac3/tool-safety): the pattern is the whole command, and `*` in it is only
     * a star. Used for a remembered command that could not be narrowed to its action.
     */
    exact: z.boolean().optional(),
  })
  .strict();
export type ResourceMatcher = z.infer<typeof ResourceMatcherSchema>;

/** What a call is actually about, worked out from the tool and its arguments. */
export interface PolicyResource {
  kind: ResourceKind;
  value: string;
  /**
   * Integration review (mac3/tool-safety): the call's target was shortened, so a rule matched against
   * the target alone must not let it through (src/policy.ts).
   */
  cut?: boolean;
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Pattern matching for rules: `*` stands for any text (a path separator included); everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  // Integration review (mac3/tool-safety): `*` fits line breaks too. Without the "s" flag a rule
  // matching "*" skipped any target with a line break in it, so `true\ngit push` walked past a refusal.
  return new RegExp("^" + pattern.split("*").map(escaped).join(".*") + "$", "is").test(value);
}

/** Paths are compared with forward slashes, without a leading or trailing slash, so Windows paths fit too. */
const tidyPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");

/** A folder pattern covers everything inside it: "finance" fits "finance/2026/q1.xlsx". */
export function pathMatches(pattern: string, value: string): boolean {
  const rule = tidyPath(pattern), path = tidyPath(value);
  return globMatches(rule, path) || globMatches(rule + "/*", path);
}

/** A website rule covers the site itself and anything under it: "example.com" fits "shop.example.com". */
export function hostMatches(pattern: string, value: string): boolean {
  const rule = pattern.trim().toLowerCase().replace(/^\*\./, ""), host = value.trim().toLowerCase();
  if (pattern.includes("*")) return globMatches(pattern.toLowerCase(), host);
  return host === rule || host.endsWith("." + rule);
}

/** Tools whose target is a command line: a program on this computer, or one kept open. */
export const isCommandTool = (tool: string): boolean => tool === "shell.execute" || /^(shell|terminal)\./.test(tool);

/** The longest command a rule reads in full; anything longer is treated as cut. */
const longestCommand = 8000;
const joined = (program: unknown, rest: unknown): string =>
  [program, ...(Array.isArray(rest) ? rest : [])].map((v) => String(v ?? "")).join(" ").trim();
/** The whole command a command tool's arguments hold, or null when they do not say. */
function fullCommand(tool: string, a: Record<string, unknown>): string | null {
  if (tool === "shell.execute" && typeof a.executable === "string") return joined(a.executable, a.args);
  if (tool === "shell.session.run" && typeof a.input === "string") return a.input;
  if ((tool === "shell.session.open" || tool === "remote.run") && typeof a.program === "string") return joined(a.program, a.args);
  return null;
}
/** A command resource: the whole command when the arguments hold it, marked when the target was shorter. */
function commandResource(fromTarget: string, whole: string | null): PolicyResource {
  const shown = fromTarget.trim();
  // The arguments are read only when they are the target's own command, carried on past its end.
  const value = whole !== null && whole.trim().startsWith(shown) ? whole.trim() : shown;
  // A command this file cannot read whole from its arguments may have been cut at 300 characters.
  const cut = value.length > longestCommand || value !== shown || (whole === null && shown.length >= 300);
  return { kind: "command", value: value.slice(0, longestCommand), ...(cut ? { cut } : {}) };
}

/**
 * Which kind of thing a call is about. The tool's own name decides first, because a browser click
 * is about a website whatever its arguments look like; the arguments decide after that.
 */
/** A bare host name and nothing else: no slash, no space, at least one dot or "localhost". */
const looksLikeHost = (value: string): boolean =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) || value.toLowerCase() === "localhost";

export function resourceOf(tool: string, permission: string, target: string, args: unknown): PolicyResource | null {
  if (!target) return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (/^(browser|web)\./.test(tool) || /^(browser|web)\./.test(permission)) return { kind: "host", value: target };
  // Batch 26 (wave 8): a program on another computer is a command like any other, but its target
  // reads "tower: make build", so the computer's name is taken off before the program is read.
  // Wave mac3 (tool-safety): the value is the whole command, tidied, so a rule can name a program
  // ("git") or one of its actions ("git status"); see src/command-prefix.ts.
  // Integration review: the value is the whole command read from the arguments, never the target,
  // which is cut at 300 characters and could hide `; rm -rf ~` after a harmless start.
  if (tool === "remote.run") return commandResource(target.split(": ").slice(1).join(": ") || target, fullCommand(tool, a));
  if (isCommandTool(tool)) return commandResource(target, fullCommand(tool, a));
  if (/^(channels|email)\./.test(tool) || /^(channels|email)\./.test(permission))
    return { kind: "channel", value: String(a.channel ?? a.to ?? a.chat ?? target) };
  // Otherwise the target itself says what kind of thing it is. Going by the target rather than the
  // arguments means a tool that reports what it touches through its own `target()` — which is how a
  // tool with no top-level `path` is meant to do it — is covered by a folder rule like any other.
  return looksLikeHost(target) ? { kind: "host", value: target } : { kind: "path", value: target };
}

/**
 * Whether a rule's resource matcher fits what the call is about. A different kind never matches.
 * A command rule covers the words it names and anything after them ("git" covers "git push",
 * "git status" does not); what a joined command can match depends on the rule's decision, so a
 * rule can only ever be made stricter by it (src/command-prefix.ts).
 */
export function resourceMatches(
  matcher: ResourceMatcher, resource: PolicyResource | null | undefined, decision: "allow" | "ask" | "deny" = "allow",
): boolean {
  if (!resource || matcher.kind !== resource.kind) return false;
  if (matcher.kind === "path") return pathMatches(matcher.pattern, resource.value);
  if (matcher.kind === "host") return hostMatches(matcher.pattern, resource.value);
  if (matcher.kind === "command")
    return matcher.exact ? !resource.cut && exactCommandPattern(resource.value) === matcher.pattern : commandCovers(matcher.pattern, resource.value, decision);
  return globMatches(matcher.pattern, resource.value);
}

/** Plain words for what a tool does, so a rule can be read as a sentence rather than a pattern. */
const actionWords: Record<string, { words: string; bareHost?: boolean }> = {
  "*": { words: "anything" },
  "files.*": { words: "changing files" },
  "files.write": { words: "writing files" },
  "files.delete": { words: "deleting files" },
  "shell.execute": { words: "running commands" },
  "remote.execute": { words: "running a program on another computer" },
  "terminal.*": { words: "running commands" },
  "browser.*": { words: "browsing", bareHost: true },
  "browser.navigate": { words: "opening", bareHost: true },
  "browser.click": { words: "clicking on" },
  "browser.fill": { words: "typing on" },
  "browser.upload": { words: "sending your files to" },
  "web.*": { words: "reading", bareHost: true },
  "channels.*": { words: "sending messages" },
  "email.*": { words: "sending email" },
};

function action(tool: string, applies: "any" | "changes"): { words: string; bareHost?: boolean } {
  if (tool === "*") return { words: applies === "changes" ? "changing anything" : "anything" };
  const known = actionWords[tool];
  if (known) return known;
  const group = actionWords[tool.replace(/\.[^.]+$/, ".*")];
  if (group) return group;
  return { words: `using ${tool}` };
}

const prepositions: Record<ResourceKind, string> = { path: "under", host: "on", channel: "in", command: "named" };

/**
 * One rule as a sentence a non-technical person can read: "Ask before writing files under finance",
 * "Never allow browsing example.com". The settings screen shows these instead of the raw patterns.
 */
export function ruleSentence(rule: {
  tool: string; match: string; applies: "any" | "changes"; decision: "allow" | "ask" | "deny";
  resource?: ResourceMatcher | undefined;
  /** How tightly a program the rule covers is held, when the owner chose. */
  sandbox?: SandboxChoice | undefined;
}): string {
  const opening = rule.decision === "allow" ? "Always allow" : rule.decision === "deny" ? "Never allow" : "Ask before";
  const { words, bareHost } = action(rule.tool, rule.applies);
  const where = rule.resource
    ? `${bareHost && rule.resource.kind === "host" ? "" : prepositions[rule.resource.kind] + " "}${rule.resource.pattern}`
    : rule.match && rule.match !== "*"
      ? `when it is ${rule.match}`
      : "";
  const held = rule.sandbox ? ` Run it ${sandboxSentences[rule.sandbox]}.` : "";
  return `${opening} ${words}${where ? " " + where : ""}.${held}`;
}
