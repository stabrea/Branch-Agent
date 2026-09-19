import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { gb } from "./local-hardware.js";
import { branchModelsFolder, branchRunnerRoot, runtimeInfo, type Exists, type LaunchEnv, type Runner, type RuntimeId } from "./local-launch.js";

/**
 * mac7/one-click (issue #107): installing the program that runs the models, when the computer has
 * none. This is the one place Branch changes the owner's computer, so it is the most careful part
 * of the whole feature.
 *
 *   - mac7/clean-uninstall: by default every system gets the publisher's own plain archive, unpacked
 *     inside Branch's own data folder, so removing Branch removes the program too. Homebrew and
 *     winget are only for LM Studio, which publishes no archive with a checksum, and for an owner
 *     who deliberately asks for a system-wide copy; those plans say plainly that they will be left
 *     behind. Nothing is ever fetched from anywhere but the publisher.
 *   - Nothing is downloaded unverified. Homebrew and winget check their own package before they
 *     install it; a direct download is checked against the checksum the publisher publishes beside
 *     the file, and on a Mac the unpacked program is checked against Apple's own signature and
 *     notarisation check as well. A file that does not match is thrown away and nothing is installed.
 *   - Every command is an argument list. There is no shell line anywhere here, so nothing a name or
 *     an address carries can ever become a command.
 *   - Branch says what it cannot do rather than half-doing it: where there is no way to install a
 *     program safely on this system, the plan says so and names the page to install it from by hand.
 *
 * A plan is worked out first and shown to the owner — what will be installed, from where, how big,
 * and how it is checked — and only the exact plan they saw is carried out (`fingerprint`).
 */

/** The programs Branch can install. llama.cpp and MLX are built or installed by hand, so not these. */
export const installableRunners = ["ollama", "lm-studio"] as const;
export type InstallableRunner = (typeof installableRunners)[number];
export const isInstallable = (id: RuntimeId): id is InstallableRunner =>
  (installableRunners as readonly string[]).includes(id);

/** The publishers' own addresses. Nothing outside this list is ever downloaded by this file. */
const installerHosts = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|ollama\.com)$/i;

/** Ollama publishes a checksum for every file beside the files themselves, in each release. */
const ollamaRelease = "https://github.com/ollama/ollama/releases/latest/download";

/**
 * mac7/clean-uninstall: the plain archive for this computer, never a system installer. Each one is
 * unpacked into Branch's own folder, so removing Branch removes the program with it.
 */
export function ollamaAssetFor(at: LaunchEnv): string | null {
  const cpu = at.arch === "arm64" ? "arm64" : at.arch === "x64" ? "amd64" : null;
  if (at.platform === "darwin") return "Ollama-darwin.zip";
  if (!cpu) return null;
  if (at.platform === "linux") return `ollama-linux-${cpu}.tar.zst`;
  if (at.platform === "win32") return `ollama-windows-${cpu}.zip`;
  return null;
}
/**
 * About how much really crosses the wire, per archive, read from Ollama's own release (v0.34.2) on
 * 2026-09-18. The owner agrees to a size, so it is the size that is really transferred. An estimate
 * that drifts with a release is fine; one that is out by a hundredfold is not.
 */
const ollamaDownloadSize: Record<string, number> = {
  "Ollama-darwin.zip": 190 * 1024 ** 2,
  "ollama-linux-amd64.tar.zst": 1400 * 1024 ** 2,
  "ollama-linux-arm64.tar.zst": 1500 * 1024 ** 2,
  "ollama-windows-amd64.zip": 1400 * 1024 ** 2,
  "ollama-windows-arm64.zip": 200 * 1024 ** 2,
};

export interface ToolsPresent {
  /** Where `brew` is, when this Mac (or Linux) has Homebrew. */
  homebrew: string | null;
  /** Where `winget` is, on Windows. */
  winget: string | null;
}

/** One thing to run, as an argument list. `{file}` and `{unpacked}` are filled in when it runs. */
export interface InstallStep {
  what: string;
  command: string[];
  /**
   * mac7/clean-uninstall: a hint to the system that is nice to have but must never decide whether
   * the install worked. One that fails is reported and stepped over; a checked, unpacked program is
   * never thrown away because a backup hint did not take.
   */
  advisory?: boolean;
}
export interface InstallFetch {
  /** The file to download, at the publisher's own address. */
  url: string;
  /** Where the publisher lists that file's SHA-256. */
  checksums: string;
  /** The file's name inside that list. */
  asset: string;
}

export interface InstallPlan {
  runner: InstallableRunner;
  name: string;
  platform: string;
  /** Homebrew, winget, or the publisher's own download. */
  via: "homebrew" | "winget" | "download" | "none";
  /** Who publishes it, in plain words. */
  publisher: string;
  /** Where it comes from, in plain words. */
  source: string;
  /** About how much will be downloaded, in bytes. An estimate; the real size is shown as it goes. */
  approxBytes: number;
  /** How Branch knows the file is the publisher's, in plain words. */
  verify: string;
  fetch: InstallFetch | null;
  steps: InstallStep[];
  /** What is still left for the person afterwards, in plain words; empty when there is nothing. */
  after: string;
  /**
   * mac7/clean-uninstall: the folder this goes into, inside Branch's own data folder. Empty when a
   * system installer puts it somewhere of its own choosing.
   */
  where: string;
  /** True when a system installer puts this outside Branch, so removing Branch cannot take it away. */
  leavesBehind: boolean;
  /** Why it is outside Branch and what that means, in plain words; empty when it is inside Branch. */
  leavesBehindNote: string;
  /** Set when Branch cannot install it here: the plain sentence saying what to do instead. */
  instead: string | null;
  /** The exact plan, in one line. The owner's yes carries it back, and only this plan then runs. */
  fingerprint: string;
}

const mac = (runner: InstallableRunner) => ({ publisher: runner === "ollama" ? "Ollama (ollama.com)" : "LM Studio (lmstudio.ai)" });

/** The plan as one line, so a yes can only ever agree to the plan that was shown. */
export function planFingerprint(plan: Omit<InstallPlan, "fingerprint">): string {
  // How big it is and how Branch knows it is the publisher's are part of the plan the owner read, so
  // a yes that was given for 190 MB checked against a signature cannot carry to something else.
  const facts = JSON.stringify([plan.runner, plan.platform, plan.via, plan.source, plan.approxBytes,
    plan.verify, plan.fetch, plan.steps, plan.instead, plan.where]);
  return createHash("sha256").update(facts).digest("hex").slice(0, 32);
}
const finish = (plan: Omit<InstallPlan, "fingerprint">): InstallPlan => ({ ...plan, fingerprint: planFingerprint(plan) });

const inside = { where: "", leavesBehind: false, leavesBehindNote: "" };

const noWay = (runner: InstallableRunner, platform: string, instead: string): InstallPlan => finish({
  runner, name: runtimeInfo[runner].name, platform, via: "none", ...mac(runner), ...inside,
  source: runtimeInfo[runner].installPage, approxBytes: 0, verify: "", fetch: null, steps: [], after: "", instead,
});

/**
 * mac7/clean-uninstall: what installing this program means on this computer. Pure, so every system
 * is checked on every machine and a test never has to have Homebrew, winget or a package manager.
 *
 * The default is always the publisher's plain archive unpacked inside Branch's own folder
 * (`dataDir`), never a system installer: that way removing Branch removes the program too, and
 * nothing asks the person for permissions of its own. Homebrew and winget are still here, but only
 * where they are the only honest option (LM Studio publishes no archive with a checksum) or where
 * the owner deliberately asked for a system-wide copy; either way the plan says plainly that it
 * will be left behind.
 */
export function installPlan(
  runner: InstallableRunner, at: LaunchEnv, tools: ToolsPresent, dataDir: string, systemWide = false,
): InstallPlan {
  const onlyWaySystemWide = runner === "lm-studio";
  if (systemWide || onlyWaySystemWide) {
    if (tools.homebrew && at.platform === "darwin") return homebrewPlan(runner, at, tools.homebrew);
    if (tools.winget && at.platform === "win32") return wingetPlan(runner, at, tools.winget);
    if (onlyWaySystemWide) return noWay(runner, at.platform, lmStudioByHand(at.platform));
  }
  const asset = ollamaAssetFor(at);
  if (!asset) return noWay(runner, at.platform, `Branch does not know how to install Ollama on ${at.platform} (${at.arch}). Install it from ${runtimeInfo.ollama.installPage}.`);
  return downloadPlan(at, asset, branchRunnerRoot(dataDir, "ollama", at.platform));
}

const lmStudioByHand = (platform: string): string => platform === "darwin"
  ? "Branch installs LM Studio through Homebrew, and this Mac has no Homebrew. Install LM Studio from lmstudio.ai yourself, open it once, then come back here."
  : platform === "win32"
    ? "Branch installs LM Studio through winget, and this computer has no winget. Install LM Studio from lmstudio.ai yourself, open it once, then come back here."
    : "LM Studio publishes no checksum for its Linux download, so Branch will not install it for you. Install it from lmstudio.ai yourself, open it once, then come back here.";

const openOnce = "Open LM Studio once so it puts its `lms` command in place, then come back here.";

/**
 * mac7/clean-uninstall: the plain sentence every system-installer plan carries. This is the one
 * thing Branch installs that removing Branch cannot take away again, so it says so before it runs.
 */
const leftBehind = (name: string, by: string): string =>
  `${name} is installed by ${by}, which puts it outside Branch. Removing Branch will not remove it: `
  + `the danger zone in Settings will name it and you can remove it yourself afterwards. `
  + `It may also ask you for permissions of its own and start by itself when you sign in.`;

function homebrewPlan(runner: InstallableRunner, at: LaunchEnv, brew: string): InstallPlan {
  const command = runner === "ollama" ? [brew, "install", "ollama"] : [brew, "install", "--cask", "lm-studio"];
  return finish({
    runner, name: runtimeInfo[runner].name, platform: at.platform, via: "homebrew", ...mac(runner),
    source: `Homebrew (${runner === "ollama" ? "the ollama formula" : "the lm-studio cask"})`,
    approxBytes: runner === "ollama" ? 30 * 1024 ** 2 : 600 * 1024 ** 2,
    verify: "Homebrew checks the download against the checksum in its own package description before it installs anything.",
    fetch: null, steps: [{ what: `Install ${runtimeInfo[runner].name} with Homebrew`, command }],
    after: runner === "lm-studio" ? openOnce : "", instead: null,
    where: "", leavesBehind: true, leavesBehindNote: leftBehind(runtimeInfo[runner].name, "Homebrew"),
  });
}

function wingetPlan(runner: InstallableRunner, at: LaunchEnv, winget: string): InstallPlan {
  const id = runner === "ollama" ? "Ollama.Ollama" : "ElementLabs.LMStudio";
  const command = [winget, "install", "--id", id, "--exact", "--source", "winget",
    "--accept-package-agreements", "--accept-source-agreements"];
  return finish({
    runner, name: runtimeInfo[runner].name, platform: at.platform, via: "winget", ...mac(runner),
    source: `winget (${id})`, approxBytes: runner === "ollama" ? ollamaDownloadSize["ollama-windows-amd64.zip"]! : 600 * 1024 ** 2,
    verify: "winget checks the download against the checksum in Microsoft's package list before it installs anything.",
    fetch: null, steps: [{ what: `Install ${runtimeInfo[runner].name} with winget`, command }],
    after: runner === "lm-studio" ? openOnce : "", instead: null,
    where: "", leavesBehind: true, leavesBehindNote: leftBehind(runtimeInfo[runner].name, "winget"),
  });
}

/**
 * mac7/clean-uninstall: Ollama from Ollama's own release, checked against the checksum published
 * beside it and unpacked into `{root}` — a folder inside Branch. No system installer runs, so
 * nothing is asked for an administrator's password, nothing is registered to start by itself, and
 * removing Branch removes the program. Branch runs the program straight out of that folder and
 * never opens the bundle, which is what keeps macOS from registering it as an installed app.
 */
function downloadPlan(at: LaunchEnv, asset: string, root: string): InstallPlan {
  const fetch: InstallFetch = { url: `${ollamaRelease}/${asset}`, checksums: `${ollamaRelease}/sha256sum.txt`, asset };
  const common = { runner: "ollama" as const, name: "Ollama", platform: at.platform, via: "download" as const, ...mac("ollama"),
    source: `${ollamaRelease}/${asset}`, approxBytes: ollamaDownloadSize[asset] ?? 0, fetch, instead: null, where: root, leavesBehind: false, leavesBehindNote: "" };
  const after = `Nothing else. Ollama lives in ${root} and is removed with Branch.`;
  if (at.platform === "darwin") return finish({
    ...common,
    verify: "Branch checks the download against the SHA-256 Ollama publishes beside it, then asks macOS itself whether the program is signed by its publisher and notarised by Apple. Anything that does not match is thrown away.",
    steps: [
      { what: "Unpack it", command: ["/usr/bin/ditto", "-x", "-k", "{file}", "{unpacked}"] },
      { what: "Check the signature", command: ["/usr/bin/codesign", "--verify", "--strict", "--deep", "{unpacked}/Ollama.app"] },
      { what: "Check macOS accepts it", command: ["/usr/sbin/spctl", "--assess", "--type", "execute", "{unpacked}/Ollama.app"] },
      { what: "Put it inside Branch", command: ["/usr/bin/ditto", "{unpacked}/Ollama.app", "{root}/Ollama.app"] },
      // Gigabytes of models must not be swept into Time Machine by surprise; this needs no administrator.
      { what: "Keep the models out of Time Machine", command: ["/usr/bin/tmutil", "addexclusion", "{models}"], advisory: true },
    ],
    after,
  });
  if (at.platform === "win32") return finish({
    ...common,
    verify: "Branch checks the download against the SHA-256 Ollama publishes beside it, and throws it away if it does not match.",
    steps: [{ what: "Unpack it inside Branch", command: [windowsTar(at), "-xf", "{file}", "-C", "{root}"] }],
    after,
  });
  // The script Branch checks is 16 KB; the program it then fetches from ollama.com is most of a
  // gigabyte and a half. The owner is told the size and the address of both, because they agree to
  // the whole of it, not to the part Branch happens to download itself.
  return finish({
    ...common,
    verify: "Branch checks the download against the SHA-256 Ollama publishes beside it, and throws it away if it does not match. No install script runs and nothing asks for your password.",
    steps: [{ what: "Unpack it inside Branch", command: ["tar", "--zstd", "-xf", "{file}", "-C", "{root}"] }],
    after,
  });
}

/** Windows ships bsdtar as `tar.exe`, which unpacks a zip; it is named in full, never found on PATH. */
const windowsTar = (at: LaunchEnv): string =>
  win32.join(at.env.SystemRoot ?? at.env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");

/* ---------------------------------------------------------------- what this computer has */

const brewPaths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const wingetPaths = (at: LaunchEnv): string[] => {
  const local = at.env.LOCALAPPDATA ?? win32.join(at.home, "AppData", "Local");
  return [win32.join(local, "Microsoft", "WindowsApps", "winget.exe")];
};

/** Whether this computer has Homebrew or winget, looked for only where they really live. */
export async function detectTools(at: LaunchEnv, exists: Exists): Promise<ToolsPresent> {
  const first = async (paths: string[]): Promise<string | null> => {
    for (const path of paths) if (await exists(path)) return path;
    return null;
  };
  return {
    homebrew: at.platform === "win32" ? null : await first(brewPaths),
    winget: at.platform === "win32" ? await first(wingetPaths(at)) : null,
  };
}

/* ---------------------------------------------------------------- carrying a plan out */

const checksumLine = /^([a-f0-9]{64})\s+\.?\/?(\S+)$/;
/** The SHA-256 the publisher lists for one file. Throws in plain words when it is not listed. */
export function checksumFor(list: string, asset: string): string {
  for (const line of list.split(/\r?\n/)) {
    const hit = checksumLine.exec(line.trim());
    if (hit && hit[2] === asset) return hit[1]!.toLowerCase();
  }
  throw new Error(`${asset} is not in the list of checksums its publisher published, so Branch will not install it.`);
}

export interface InstallDeps {
  at: LaunchEnv;
  run: Runner;
  exists: Exists;
  /** Reaches the publishers, under the ordinary network rules. */
  library: typeof globalThis.fetch;
  /** A folder of Branch's own that the download goes into. */
  scratchDir: string;
  /** mac7/clean-uninstall: Branch's own data folder, where the program and its models end up. */
  dataDir?: string;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

// GitHub hands a release download on to a signed address about 900 characters long, so the bound is
// the publisher's own length, not a guess. It is still a bound: an address is input like any other.
const HttpsUrl = z.string().max(2000).refine((value) => {
  try { const url = new URL(value); return url.protocol === "https:" && installerHosts.test(url.hostname); } catch { return false; }
}, "A program is only ever downloaded from its own publisher");

/** The address, or a plain sentence. Never a validation error: the owner reads this. */
function publisherUrl(value: string): string {
  const seen = HttpsUrl.safeParse(value);
  if (!seen.success) throw new Error("A program is only ever downloaded from its own publisher, and that address is not one of theirs, so Branch stopped.");
  return seen.data;
}

/** Fetches one address from a publisher, following its redirects by hand and checking each hop. */
async function openPublisher(url: string, call: typeof globalThis.fetch, signal?: AbortSignal): Promise<Response> {
  let next = publisherUrl(url);
  for (let hop = 0; hop < 6; hop++) {
    const response = await call(next, { redirect: "manual", ...(signal ? { signal } : {}) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      next = publisherUrl(new URL(location, next).href);
      continue;
    }
    if (!response.ok) throw new Error(`${new URL(next).hostname} answered ${response.status}`);
    return response;
  }
  throw new Error("The publisher sent Branch round too many redirects");
}

/** Marks a refusal that already says everything the owner needs, so nothing wraps it again. */
class CheckedRefusal extends Error {}

/** Downloads the file into Branch's own folder and refuses it unless its checksum matches. */
export async function fetchInstaller(plan: InstallPlan, deps: InstallDeps): Promise<string> {
  const want = plan.fetch;
  if (!want) throw new Error("This plan downloads nothing");
  const join = deps.at.platform === "win32" ? win32.join : posix.join;
  const target = join(deps.scratchDir, want.asset.replace(/[^A-Za-z0-9._-]/g, "_"));
  await mkdir(deps.scratchDir, { recursive: true });
  await rm(target, { force: true });
  const list = await (await openPublisher(want.checksums, deps.library, deps.signal)).text();
  const sha256 = checksumFor(list.slice(0, 200_000), want.asset);
  const response = await openPublisher(want.url, deps.library, deps.signal);
  const total = Number(response.headers.get("content-length")) || plan.approxBytes;
  await writeTo(response, target, total, deps);
  const got = await sha256Of(target);
  if (got !== sha256) {
    await rm(target, { force: true });
    throw new CheckedRefusal(`The ${plan.name} download did not match the checksum its publisher published, so it was thrown away and nothing was installed.`);
  }
  return target;
}

/**
 * The download, with anything half-written cleared away and whatever went wrong said in the same
 * plain words a failed step uses. A network that is not there threw "fetch failed" at the owner.
 */
async function downloadFor(plan: InstallPlan, deps: InstallDeps): Promise<string> {
  try {
    return await fetchInstaller(plan, deps);
  } catch (error) {
    if (error instanceof CheckedRefusal) throw error;
    const join = deps.at.platform === "win32" ? win32.join : posix.join;
    if (plan.fetch) await rm(join(deps.scratchDir, plan.fetch.asset.replace(/[^A-Za-z0-9._-]/g, "_")), { force: true });
    const said = String((error as Error)?.message ?? error).trim().slice(0, 200);
    throw new CheckedRefusal(`Branch could not download ${plan.name}${said ? `: ${said}` : "."}. `
      + `Nothing was left half-installed by Branch. You can install it yourself from ${runtimeInfo[plan.runner].installPage}.`);
  }
}

async function writeTo(response: Response, target: string, total: number, deps: InstallDeps): Promise<void> {
  if (!response.body) throw new Error("The publisher sent nothing");
  const out = createWriteStream(target, { flags: "w" });
  let completed = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      deps.signal?.throwIfAborted();
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      completed += chunk.byteLength;
      if (completed > 4 * 1024 ** 3) throw new Error("That download is far larger than any installer should be, so Branch stopped it.");
      deps.onProgress?.(completed, Math.max(total, completed));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  if ((await stat(target)).size === 0) throw new Error("The publisher sent an empty file");
}

async function sha256Of(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface InstallOutcome { installed: boolean; message: string; ran: string[][] }

/**
 * Carries out a plan the owner agreed to: download and check first, then each step in order. A step
 * that fails stops the rest, and the sentence says which one and what the program said.
 */
export async function runInstall(plan: InstallPlan, deps: InstallDeps): Promise<InstallOutcome> {
  if (plan.instead) return { installed: false, message: plan.instead, ran: [] };
  const join = deps.at.platform === "win32" ? win32.join : posix.join;
  let file = "";
  if (plan.fetch) {
    try { file = await downloadFor(plan, deps); }
    catch (error) { return { installed: false, ran: [], message: (error as Error).message }; }
  }
  const unpacked = join(deps.scratchDir, "unpacked");
  if (plan.fetch && plan.platform === "darwin") await rm(unpacked, { recursive: true, force: true });
  // mac7/clean-uninstall: a fresh folder inside Branch for the program, and one for its models, so
  // the unpacking step has somewhere to land and a half-finished earlier try is not built upon.
  const models = deps.dataDir ? join(branchModelsFolder(deps.dataDir, deps.at.platform), plan.runner) : "";
  if (plan.where) {
    await rm(plan.where, { recursive: true, force: true });
    await mkdir(plan.where, { recursive: true });
    if (models) await mkdir(models, { recursive: true });
  }
  const ran: string[][] = [], notes: string[] = [];
  for (const step of plan.steps) {
    deps.signal?.throwIfAborted();
    const command = step.command.map((part) =>
      part.replaceAll("{file}", file).replaceAll("{unpacked}", unpacked).replaceAll("{root}", plan.where).replaceAll("{models}", models));
    ran.push(command);
    try {
      await deps.run(command[0]!, command.slice(1), { timeout: 20 * 60 * 1000, windowsHide: true });
    } catch (error) {
      if (step.advisory) { notes.push(step.what); continue; }
      // Nothing half-unpacked is left inside Branch when a step fails.
      if (plan.where) await rm(plan.where, { recursive: true, force: true });
      return { installed: false, ran, message: stepFailure(plan, step, error) };
    }
  }
  const missed = notes.length ? ` One thing did not take, and ${plan.name} works without it: ${notes.join("; ")}.` : "";
  return { installed: true, ran, message: `${plan.name} was installed${plan.after ? `. ${plan.after}` : "."}${missed}` };
}

/**
 * What to say when a step did not work. merge-queue: a program Branch fetched itself is unpacked
 * into Branch's own folder, which is cleared again when a step fails, so that is a promise Branch can
 * keep. Homebrew and winget tidy up after a step of theirs that fails.
 */
function stepFailure(plan: InstallPlan, step: InstallStep, error: unknown): string {
  // winget says why on its ordinary output, not on the error one, so both are looked at.
  const told = error as { stderr?: string; stdout?: string };
  const said = String(told?.stderr?.trim() || told?.stdout?.trim() || (error as Error)?.message || "").trim().slice(0, 300);
  const page = runtimeInfo[plan.runner].installPage;
  const after = plan.fetch
    ? `What Branch had unpacked was cleared away again, and nothing outside Branch was touched. You can install it yourself from ${page}.`
    : `Nothing was left half-installed by Branch. You can install it yourself from ${page}.`;
  return `Branch could not install ${plan.name}: the step "${step.what}" did not work${said ? `. It said: ${said}` : "."} ${after}`;
}

/** How big the download is, in plain words, for the sentence the owner reads before saying yes. */
export const planSize = (plan: Pick<InstallPlan, "approxBytes">): string => plan.approxBytes >= 1024 ** 3
  ? `about ${gb(plan.approxBytes)} GB`
  : plan.approxBytes >= 1024 ** 2 ? `about ${Math.round(plan.approxBytes / 1024 ** 2)} MB`
    : `about ${Math.round(plan.approxBytes / 1024)} KB`;
