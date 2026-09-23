import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
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
  const env = buildEnv(process.env, platform);
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

/**
 * What the build's programs see: this computer's own environment without the running app's own switches (a
 * BRANCH_* or ELECTRON_* value meant for this app must not steer the build), with prompts off, and on a Mac the
 * places Homebrew puts git and Node, which an app started from the Dock is not told about.
 */
export function buildEnv(from: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(from).filter(([key]) => !/^(BRANCH|ELECTRON)_/i.test(key)));
  const extraPath = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return {
    ...kept,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "",
    PATH: [...extraPath, from.PATH ?? ""].filter(Boolean).join(platform === "win32" ? ";" : ":"),
  };
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
export async function buildDev(run: Run, plan: { repo: string; sourceDir: string; commit: string; running: string | null; assetName: string; onPhase: (phase: DevPhase) => void }):
Promise<{ archive: string; checksumFile: string; version: string }> {
  const { repo, sourceDir, commit, running, assetName, onPhase } = plan;
  onPhase("fetching");
  const cloned = await access(join(sourceDir, ".git")).then(() => true, () => false);
  if (!cloned) await run("git", [...quietGit, "clone", "--no-tags", "--single-branch", "--branch", devBranch, `https://github.com/${repo}.git`, sourceDir], { timeoutMs: minutes(15) });
  else await run("git", [...quietGit, "fetch", "--no-tags", "origin", devBranch], { cwd: sourceDir, timeoutMs: minutes(15) });
  await run("git", ["reset", "--hard", commit], { cwd: sourceDir, timeoutMs: minutes(2) });
  await run("git", ["clean", "-fdx", "-e", "node_modules"], { cwd: sourceDir, timeoutMs: minutes(2) });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceDir, timeoutMs: 30_000 })).trim();
  if (head !== commit) throw new Error("The source did not arrive at the change that was looked up, so nothing was built.");
  // Never back: the change offered must already contain the one running (a Beta can be built from a newer change
  // than the main line's head for a while). A running change this clone has never heard of cannot be compared.
  if (running && running !== commit) {
    const shared = await run("git", ["merge-base", running, commit], { cwd: sourceDir, timeoutMs: 30_000 }).then((out) => out.trim(), () => "");
    if (shared && shared !== running)
      throw new Error(`The newest Dev change does not include the version running now (change ${running.slice(0, 7)}), so installing it would go back. Nothing was changed; it is offered again once it catches up.`);
  }
  onPhase("installing");
  await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: sourceDir, timeoutMs: minutes(30) });
  const committedAt = Number((await run("git", ["show", "-s", "--format=%ct", commit], { cwd: sourceDir, timeoutMs: 30_000 })).trim());
  const version = await stampDevVersion(sourceDir, committedAt);
  onPhase("building");
  await run("npm", ["run", "package:desktop", "--", "--release"], { cwd: sourceDir, timeoutMs: minutes(30) });
  return { archive: join(sourceDir, "release", assetName), checksumFile: join(sourceDir, "release", `${assetName}.sha256`), version };
}

/**
 * Like Beta's stamp (scripts/beta-release.mjs), only for the build: a Dev build of 0.19.2's line is
 * 0.19.3-dev.<commit time>. So every Dev build has its own version, later changes have higher ones, the update's
 * record can tell whether the swap landed, and Beta (0.19.3-beta.N sorts below it) never offers older code.
 */
export async function stampDevVersion(sourceDir: string, committedAt: number): Promise<string> {
  const manifestPath = join(sourceDir, "package.json"), lockPath = join(sourceDir, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), lock = JSON.parse(await readFile(lockPath, "utf8"));
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest.version));
  if (manifest.name !== "branch-agent" || !match || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || !Number.isSafeInteger(committedAt) || committedAt < 1)
    throw new Error("The source's version could not be read, so nothing was built.");
  const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-dev.${committedAt}`;
  manifest.version = lock.version = lock.packages[""].version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}
