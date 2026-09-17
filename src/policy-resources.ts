import { z } from "zod";
import { sandboxSentences, type SandboxChoice } from "./sandbox.js";

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
  })
  .strict();
export type ResourceMatcher = z.infer<typeof ResourceMatcherSchema>;

/** What a call is actually about, worked out from the tool and its arguments. */
export interface PolicyResource {
  kind: ResourceKind;
  value: string;
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Pattern matching for rules: `*` stands for any text (a path separator included); everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  return new RegExp("^" + pattern.split("*").map(escaped).join(".*") + "$", "i").test(value);
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

/** The first word of a command, which is the program being run: "git status" is the command "git". */
export const commandAlias = (command: string): string => (command.trim().split(/[\s]+/)[0] ?? "").replace(/^.*[\\/]/, "");

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
  if (tool === "remote.run") return { kind: "command", value: commandAlias(target.split(": ").slice(1).join(": ") || target) };
  if (tool === "shell.execute" || /^(shell|terminal)\./.test(tool)) return { kind: "command", value: commandAlias(target) };
  if (/^(channels|email)\./.test(tool) || /^(channels|email)\./.test(permission))
    return { kind: "channel", value: String(a.channel ?? a.to ?? a.chat ?? target) };
  // Otherwise the target itself says what kind of thing it is. Going by the target rather than the
  // arguments means a tool that reports what it touches through its own `target()` — which is how a
  // tool with no top-level `path` is meant to do it — is covered by a folder rule like any other.
  return looksLikeHost(target) ? { kind: "host", value: target } : { kind: "path", value: target };
}

/** Whether a rule's resource matcher fits what the call is about. A different kind never matches. */
export function resourceMatches(matcher: ResourceMatcher, resource: PolicyResource | null | undefined): boolean {
  if (!resource || matcher.kind !== resource.kind) return false;
  if (matcher.kind === "path") return pathMatches(matcher.pattern, resource.value);
  if (matcher.kind === "host") return hostMatches(matcher.pattern, resource.value);
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
