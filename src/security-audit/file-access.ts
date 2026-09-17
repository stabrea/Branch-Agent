import { chmod, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { FixPlan, FixResult, PathFact, PathRole } from "./types.js";

/**
 * Who besides the owner can reach a file, and taking that away again.
 *
 * On macOS and Linux this is the permission bits: anything for the group or everybody else counts.
 * Changing them is Node's own `chmod`, so no program is started. On Windows it is the file's access
 * list, read and changed with `icacls`, always as an argument list and never as a line of shell.
 * The shape of the Windows repair — drop the inherited entries, give the owner and the system full
 * control, take the broad groups off — follows OpenClaw's `src/security/windows-acl.ts` (MIT).
 */

/** Runs a program with arguments and hands back what it printed. Tests pass a fake. */
export type Runner = (file: string, args: string[]) => Promise<string>;

export const runProgram: Runner = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 1048576 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));

/** Groups that stand for "other people on this computer" in icacls output (English, French, German). */
const broadNames = [
  "everyone", "builtin\\users", "nt authority\\authenticated users",
  "tout le monde", "builtin\\utilisateurs", "autorite nt\\utilisateurs authentifiés", "autorité nt\\utilisateurs authentifiés",
  "jeder", "vordefiniert\\benutzer", "nt-autorität\\authentifizierte benutzer",
];
/** Well-known ids for Everyone, Authenticated Users and Users, the same in every language. */
export const broadSids = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"];

/**
 * Reads `icacls <path>` output: the path on the first line, then one "WHO:(rights)" per line.
 * Answers which broad groups appear, and whether any of them may change the file.
 */
export function readIcacls(output: string, path: string): { groups: string[]; write: boolean } {
  const groups: string[] = [];
  let write = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = (raw.startsWith(path) ? raw.slice(path.length) : raw).trim();
    const hit = /^(.+?):((?:\([A-Z,]+\))+)$/i.exec(line);
    if (!hit) continue;
    const who = hit[1]!.trim();
    const rights = hit[2]!.slice(1, -1).split(")(").flatMap((part) => part.split(","));
    if (!broadNames.includes(who.toLowerCase()) || rights.includes("DENY")) continue;
    if (!groups.includes(who)) groups.push(who);
    if (rights.some((right) => changeRights.has(right))) write = true;
  }
  return { groups, write };
}
/** icacls rights that let somebody change, replace or remove a file. */
const changeRights = new Set(["F", "M", "W", "D", "WD", "AD", "WEA", "WA", "DC", "DE", "WDAC", "WO", "GA", "GW"]);

/** Looks at one path; never follows a link, never changes anything. */
export async function inspectPath(
  role: PathRole, path: string, platform: NodeJS.Platform, run: Runner = runProgram,
): Promise<PathFact> {
  const info = await lstat(path).catch(() => null);
  const base = { role, path, mode: null, othersRead: false, othersWrite: false };
  if (!info) return { ...base, kind: "missing" };
  const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : "file";
  if (platform !== "win32") {
    const mode = info.mode & 0o777;
    // A folder others may list or pass through is open to them; a file is open when they may read it.
    const readBits = kind === "folder" ? 0o055 : 0o044;
    return { ...base, kind, mode, othersRead: (mode & readBits) !== 0, othersWrite: (mode & 0o022) !== 0 };
  }
  if (kind === "link") return { ...base, kind };
  const output = await run("icacls", [path]).catch(() => "");
  const { groups, write } = readIcacls(output, path);
  return { ...base, kind, othersRead: groups.length > 0, othersWrite: write, broadGroups: groups };
}

/** The two icacls calls that leave a path to its owner and the system alone. */
export function icaclsRepair(path: string, target: "file" | "folder", user: string): string[][] {
  const inherit = target === "folder" ? "(OI)(CI)" : "";
  return [
    [path, "/inheritance:r", "/grant:r", `${user}:${inherit}(F)`, `*S-1-5-18:${inherit}(F)`],
    [path, "/remove:g", ...broadSids],
  ];
}

/** The account name icacls should give the file to, from the environment Windows sets. */
export function windowsUser(env: NodeJS.ProcessEnv): string {
  const name = env.USERNAME ?? "";
  if (!/^[^"\\/:*?<>|]{1,104}$/.test(name)) throw new Error("Windows did not say who is signed in, so the access list was left alone");
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

async function tightenPosix(plan: FixPlan): Promise<FixResult> {
  const wanted = plan.target === "folder" ? 0o700 : 0o600;
  const info = await lstat(plan.path);
  if (info.isSymbolicLink()) return { path: plan.path, outcome: "skipped", reason: "It is a link to somewhere else, so it was left alone." };
  if (plan.target === "folder" ? !info.isDirectory() : !info.isFile())
    return { path: plan.path, outcome: "skipped", reason: "It is no longer the kind of thing it was when it was checked." };
  if ((info.mode & 0o777) === wanted) return { path: plan.path, outcome: "already", reason: "Only you could reach it already." };
  await chmod(plan.path, wanted);
  return { path: plan.path, outcome: "fixed", reason: "Now only you can reach it." };
}

async function tightenWindows(plan: FixPlan, run: Runner, env: NodeJS.ProcessEnv): Promise<FixResult> {
  const info = await lstat(plan.path);
  if (info.isSymbolicLink()) return { path: plan.path, outcome: "skipped", reason: "It is a link to somewhere else, so it was left alone." };
  for (const args of icaclsRepair(plan.path, plan.target, windowsUser(env))) await run("icacls", args);
  return { path: plan.path, outcome: "fixed", reason: "Now only you and Windows itself can reach it." };
}

/**
 * Takes other people's access away from one path. Only paths the check itself proposed reach here,
 * and a path that turned into a link since it was looked at is refused.
 */
export async function tightenPath(
  plan: FixPlan, platform: NodeJS.Platform, run: Runner = runProgram, env: NodeJS.ProcessEnv = process.env,
): Promise<FixResult> {
  try {
    return platform === "win32" ? await tightenWindows(plan, run, env) : await tightenPosix(plan);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { path: plan.path, outcome: "skipped", reason: "It is not there any more." };
    return { path: plan.path, outcome: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}
