import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { protectedWorkspaceNames } from "./sandbox-seatbelt.js";

/**
 * Telling a command that failed because the wall stopped it apart from one that simply failed, so
 * the task says "the wall stopped this writing to X — allow it once?" instead of the model guessing.
 *
 * There is no certain way to know: a program can print "permission denied" for its own reasons.
 * So the check is conservative, as Codex's `sandboxing/src/denial.rs` is (Apache-2.0, see
 * THIRD_PARTY_NOTICES.md): a clean exit is never a denial, the exit codes that mean "wrong usage" or
 * "no such program" are never one, and otherwise the output has to carry one of the words systems
 * use when they refuse. A path is taken from the output only when it is a full path, and the
 * narrowest widening is that one file — never a folder, never a place the wall always protects.
 */

const plainFailures = new Set([2, 126, 127]);
const refusalWords = ["operation not permitted", "permission denied", "read-only file system", "sandbox-exec", "bwrap:", "seccomp", "deny(1)"];
const networkWords = ["could not resolve host", "network is unreachable", "name or service not known",
  "nodename nor servname", "temporary failure in name resolution", "getaddrinfo", "enotfound", "eai_again"];

export interface WallDenial {
  kind: "write" | "network" | "unknown";
  /** The one file the owner could let the program write to, when the output named one. */
  path?: string;
  /** What the task is told, in plain words. */
  message: string;
}

/** Full paths the output names next to a refusal, most likely first. */
function pathsIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|[\s'"`(])(\/[^\s'"`:),]+)['"`]?\s*[:,)]?\s*(?:operation not permitted|permission denied|read-only file system)/gim,
    /(?:operation not permitted|permission denied|read-only file system)[^\n/]*?['"`]?(\/[^\s'"`),]+)/gim,
    /deny\(1\) file-write[\w-]* (\/[^\s]+)/gim,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  return [...new Set(found)];
}

/**
 * Whether the wall is the likely reason, and what could be let through. The workspace's `.git`,
 * `.branch` and `.agents`, and every hidden place, are never offered as a widening.
 */
export function explainDenial(
  result: { exitCode: number | null; stdout: string; stderr: string },
  options: { network: string; workspace: string; hidden: readonly string[] },
): WallDenial | null {
  if (result.exitCode === 0 || (result.exitCode !== null && plainFailures.has(result.exitCode))) return null;
  const text = `${result.stderr}\n${result.stdout}`.slice(-64_000);
  const lower = text.toLowerCase();
  if (options.network === "none" && networkWords.some((word) => lower.includes(word)))
    return { kind: "network", message: "The wall around programs stopped this command reaching the internet. Programs have no network in your settings; the owner can change that under Settings, Computer." };
  if (!refusalWords.some((word) => lower.includes(word))) return null;
  const blocked = pathsIn(text).map((path) => normalize(path)).find((path) => isAbsolute(path));
  if (!blocked) return { kind: "unknown", message: "The command was refused something by the wall around programs, but did not say what. Try writing only inside the workspace." };
  if (!widenable(blocked, options))
    return { kind: "write", message: `The wall around programs stopped this command changing ${blocked}. That place is always protected, so Branch will not ask to open it.` };
  return { kind: "write", path: blocked, message: `The wall around programs stopped this command writing to ${blocked}.` };
}

/**
 * Places that start programs by themselves later (at sign-in, on a timer, in every new terminal).
 * A program that printed one of these as "blocked" is never offered a way in: one yes would outlive
 * the wall.
 */
export const neverWidened = (home: string): string[] => [
  "Library/LaunchAgents", "Library/LaunchDaemons", "Library/Application Support/com.apple.backgroundtaskmanagementagent",
  ".config/autostart", ".config/systemd", ".local/share/systemd", ".config/fish",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".login",
  ".ssh", ".gitconfig", ".config/git", ".npmrc", ".pip", ".config/pip",
].map((place) => join(home, place)).concat(["/Library/LaunchAgents", "/Library/LaunchDaemons", "/etc", "/private/etc", "/usr", "/bin", "/sbin"]);

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Whether a single file may be offered as a widening at all. */
export function widenable(path: string, options: { workspace: string; hidden: readonly string[]; home?: string }): boolean {
  if (!isAbsolute(path) || path.includes("\0") || path.split(sep).includes("..")) return false;
  const full = resolve(path);
  if (full === sep || full.length < 3) return false;
  const kept = protectedWorkspaceNames.map((name) => resolve(options.workspace, name));
  return ![...kept, ...options.hidden, ...neverWidened(options.home ?? homedir())].some((root) => inside(full, resolve(root)));
}

/** The question the task stops on. */
export const widenQuestion = (): string =>
  "the wall around programs stopped a command writing to this file; let the next try write to it, once";
export const siteQuestion = (): string => "let programs behind the wall reach this site";
