import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Dev update channel: like Hermes Desktop, Branch follows its own main line of work and builds the newest
 * merged change on this computer, instead of waiting for a published Stable or Beta release. It needs git and
 * Node here, and each build takes minutes (the first one longer: it downloads Electron).
 *
 * The source is Branch's own clone in its data folder, never a folder the owner works in, so it is reset to
 * the exact commit that was looked up; nothing the owner wrote can be in it. Every program runs hidden, never
 * asks for a password or sign-in (the repository is public), and is given a time limit.
 */
export const devBranch = "mac/cross-platform";

export interface Run {
  (file: string, args: string[], options: { cwd?: string; timeoutMs: number }): Promise<string>;
}
export type DevPhase = "fetching" | "installing" | "building";

const minutes = (count: number) => count * 60_000;
const quietGit = ["-c", "credential.helper=", "-c", "core.askPass="];

/** The real runner: hidden, no prompts, npm through the command shell Windows needs for `npm.cmd`. */
export function realRun(platform: NodeJS.Platform = process.platform): Run {
  const extraPath = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "",
    PATH: [...extraPath, process.env.PATH ?? ""].filter(Boolean).join(platform === "win32" ? ";" : ":"),
  };
  return (file, args, options) => new Promise((resolve, reject) => {
    const [program, programArgs] = platform === "win32" && file === "npm"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "npm", ...args]]
      : [file, args];
    execFile(program, programArgs, { cwd: options.cwd, env, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const lastLine = String(stderr).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
        reject(new Error(`${file} ${args[0] ?? ""} did not finish${error.killed ? " in time" : ""}${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`));
      });
  });
}

/** Whether this computer has what a Dev build needs; the reason in plain words when it does not. */
export async function devToolsMissing(run: Run): Promise<string | null> {
  const missing: string[] = [];
  for (const [tool, args] of [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]]] as const) {
    try { await run(tool, [...args], { timeoutMs: 20_000 }); } catch { missing.push(tool); }
  }
  if (!missing.length) return null;
  return `The Dev channel builds Branch on this computer, and ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found. Install git and Node.js (which includes npm), then check again, or choose Stable or Beta.`;
}

/** The newest commit on Branch's main line, read with git (not GitHub's rate-limited web API). */
export async function remoteHead(run: Run, repo: string): Promise<string> {
  const out = await run("git", [...quietGit, "ls-remote", `https://github.com/${repo}.git`, `refs/heads/${devBranch}`], { timeoutMs: 60_000 });
  const sha = /^([0-9a-f]{40})\s+refs\/heads\//m.exec(out)?.[1];
  if (!sha) throw new Error("GitHub did not say what the newest change is. Check the internet connection and try again.");
  return sha;
}

/**
 * Brings Branch's own clone to exactly `commit` and builds the release download from it. Returns the download's
 * path and the version the source says it is. A failure leaves the installed app untouched.
 */
export async function buildDev(run: Run, plan: { repo: string; sourceDir: string; commit: string; assetName: string; onPhase: (phase: DevPhase) => void }):
Promise<{ archive: string; checksumFile: string; version: string }> {
  const { repo, sourceDir, commit, assetName, onPhase } = plan;
  onPhase("fetching");
  const cloned = await access(join(sourceDir, ".git")).then(() => true, () => false);
  if (!cloned) await run("git", [...quietGit, "clone", "--no-tags", "--single-branch", "--branch", devBranch, `https://github.com/${repo}.git`, sourceDir], { timeoutMs: minutes(15) });
  else await run("git", [...quietGit, "fetch", "--no-tags", "origin", devBranch], { cwd: sourceDir, timeoutMs: minutes(15) });
  await run("git", ["reset", "--hard", commit], { cwd: sourceDir, timeoutMs: minutes(2) });
  await run("git", ["clean", "-fdx", "-e", "node_modules"], { cwd: sourceDir, timeoutMs: minutes(2) });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceDir, timeoutMs: 30_000 })).trim();
  if (head !== commit) throw new Error("The source did not arrive at the change that was looked up, so nothing was built.");
  onPhase("installing");
  await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: sourceDir, timeoutMs: minutes(30) });
  onPhase("building");
  await run("npm", ["run", "package:desktop", "--", "--release"], { cwd: sourceDir, timeoutMs: minutes(30) });
  const version = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")).version;
  if (typeof version !== "string") throw new Error("The built source has no version, so nothing was changed.");
  return { archive: join(sourceDir, "release", assetName), checksumFile: join(sourceDir, "release", `${assetName}.sha256`), version };
}
