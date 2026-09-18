import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { gb } from "./local-hardware.js";
import { runtimeInfo, type Exists, type LaunchEnv, type Runner, type RuntimeId } from "./local-launch.js";

/**
 * mac7/one-click (issue #107): installing the program that runs the models, when the computer has
 * none. This is the one place Branch changes the owner's computer, so it is the most careful part
 * of the whole feature.
 *
 *   - Each system is installed its own way: Homebrew on a Mac, winget on Windows, and otherwise the
 *     publisher's own signed download. Nothing is ever fetched from anywhere but the publisher.
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
const ollamaAsset: Record<string, string | null> = {
  darwin: "Ollama-darwin.zip", win32: "OllamaSetup.exe", linux: "install.sh",
};
/** Where Ollama's Linux script fetches the program itself, once Branch has checked the script. */
const ollamaLinuxPayload = "https://ollama.com/download";
/**
 * About how much really crosses the wire, measured from the publishers' own releases on 2026-09-18.
 * The owner agrees to a size, so it is the size that is really transferred: on Linux that is the
 * program the script fetches, not the 16 KB script. An estimate that drifts with a release is fine;
 * one that is out by a hundredfold is not, because it is what the owner said yes to.
 */
const ollamaDownloadSize: Record<string, number> = {
  darwin: 190 * 1024 ** 2,        // Ollama-darwin.zip
  win32: 1500 * 1024 ** 2,        // OllamaSetup.exe, which is what winget installs too
  linux: 1400 * 1024 ** 2,        // install.sh, then ollama-linux-<arch>.tar.zst from ollama.com
};

export interface ToolsPresent {
  /** Where `brew` is, when this Mac (or Linux) has Homebrew. */
  homebrew: string | null;
  /** Where `winget` is, on Windows. */
  winget: string | null;
}

/** One thing to run, as an argument list. `{file}` and `{unpacked}` are filled in when it runs. */
export interface InstallStep { what: string; command: string[] }
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
    plan.verify, plan.fetch, plan.steps, plan.instead]);
  return createHash("sha256").update(facts).digest("hex").slice(0, 32);
}
const finish = (plan: Omit<InstallPlan, "fingerprint">): InstallPlan => ({ ...plan, fingerprint: planFingerprint(plan) });

const noWay = (runner: InstallableRunner, platform: string, instead: string): InstallPlan => finish({
  runner, name: runtimeInfo[runner].name, platform, via: "none", ...mac(runner),
  source: runtimeInfo[runner].installPage, approxBytes: 0, verify: "", fetch: null, steps: [], after: "", instead,
});

/**
 * What installing this program means on this computer. Pure, so every system is checked on every
 * machine and a test never has to have Homebrew, winget or a package manager.
 */
export function installPlan(runner: InstallableRunner, at: LaunchEnv, tools: ToolsPresent): InstallPlan {
  if (tools.homebrew && at.platform === "darwin") return homebrewPlan(runner, at, tools.homebrew);
  if (tools.winget && at.platform === "win32") return wingetPlan(runner, at, tools.winget);
  if (runner === "lm-studio") return noWay(runner, at.platform, lmStudioByHand(at.platform));
  const asset = ollamaAsset[at.platform];
  if (!asset) return noWay(runner, at.platform, `Branch does not know how to install Ollama on ${at.platform}. Install it from ${runtimeInfo.ollama.installPage}.`);
  return downloadPlan(at, asset);
}

const lmStudioByHand = (platform: string): string => platform === "darwin"
  ? "Branch installs LM Studio through Homebrew, and this Mac has no Homebrew. Install LM Studio from lmstudio.ai yourself, open it once, then come back here."
  : platform === "win32"
    ? "Branch installs LM Studio through winget, and this computer has no winget. Install LM Studio from lmstudio.ai yourself, open it once, then come back here."
    : "LM Studio publishes no checksum for its Linux download, so Branch will not install it for you. Install it from lmstudio.ai yourself, open it once, then come back here.";

const openOnce = "Open LM Studio once so it puts its `lms` command in place, then come back here.";

function homebrewPlan(runner: InstallableRunner, at: LaunchEnv, brew: string): InstallPlan {
  const command = runner === "ollama" ? [brew, "install", "ollama"] : [brew, "install", "--cask", "lm-studio"];
  return finish({
    runner, name: runtimeInfo[runner].name, platform: at.platform, via: "homebrew", ...mac(runner),
    source: `Homebrew (${runner === "ollama" ? "the ollama formula" : "the lm-studio cask"})`,
    approxBytes: runner === "ollama" ? 30 * 1024 ** 2 : 600 * 1024 ** 2,
    verify: "Homebrew checks the download against the checksum in its own package description before it installs anything.",
    fetch: null, steps: [{ what: `Install ${runtimeInfo[runner].name} with Homebrew`, command }],
    after: runner === "lm-studio" ? openOnce : "", instead: null,
  });
}

function wingetPlan(runner: InstallableRunner, at: LaunchEnv, winget: string): InstallPlan {
  const id = runner === "ollama" ? "Ollama.Ollama" : "ElementLabs.LMStudio";
  const command = [winget, "install", "--id", id, "--exact", "--source", "winget",
    "--accept-package-agreements", "--accept-source-agreements"];
  return finish({
    runner, name: runtimeInfo[runner].name, platform: at.platform, via: "winget", ...mac(runner),
    source: `winget (${id})`, approxBytes: runner === "ollama" ? ollamaDownloadSize.win32! : 600 * 1024 ** 2,
    verify: "winget checks the download against the checksum in Microsoft's package list before it installs anything.",
    fetch: null, steps: [{ what: `Install ${runtimeInfo[runner].name} with winget`, command }],
    after: runner === "lm-studio" ? openOnce : "", instead: null,
  });
}

/** Ollama from Ollama's own release, checked against the checksum published beside it. */
function downloadPlan(at: LaunchEnv, asset: string): InstallPlan {
  const fetch: InstallFetch = { url: `${ollamaRelease}/${asset}`, checksums: `${ollamaRelease}/sha256sum.txt`, asset };
  const common = { runner: "ollama" as const, name: "Ollama", platform: at.platform, via: "download" as const, ...mac("ollama"),
    source: `${ollamaRelease}/${asset}`, approxBytes: ollamaDownloadSize[at.platform] ?? 0, fetch, instead: null };
  if (at.platform === "darwin") return finish({
    ...common,
    verify: "Branch checks the download against the SHA-256 Ollama publishes beside it, then asks macOS itself whether the program is signed by its publisher and notarised by Apple. Anything that does not match is thrown away.",
    steps: [
      { what: "Unpack it", command: ["/usr/bin/ditto", "-x", "-k", "{file}", "{unpacked}"] },
      { what: "Check the signature", command: ["/usr/bin/codesign", "--verify", "--strict", "--deep", "{unpacked}/Ollama.app"] },
      { what: "Check macOS accepts it", command: ["/usr/sbin/spctl", "--assess", "--type", "execute", "{unpacked}/Ollama.app"] },
      { what: "Put it in Applications", command: ["/usr/bin/ditto", "{unpacked}/Ollama.app", "/Applications/Ollama.app"] },
    ],
    after: "Open Ollama once from your Applications folder if macOS asks you to allow it.",
  });
  if (at.platform === "win32") return finish({
    ...common,
    verify: "Branch checks the download against the SHA-256 Ollama publishes beside it, and throws it away if it does not match.",
    steps: [{ what: "Open Ollama's own installer", command: ["{file}"] }],
    after: "Ollama's own installer opens. Branch waits while you click through it, then checks that Ollama really arrived.",
  });
  // The script Branch checks is 16 KB; the program it then fetches from ollama.com is most of a
  // gigabyte and a half. The owner is told the size and the address of both, because they agree to
  // the whole of it, not to the part Branch happens to download itself.
  return finish({
    ...common,
    source: `${ollamaRelease}/${asset}, which then fetches Ollama itself from ${ollamaLinuxPayload}`,
    verify: "Branch checks Ollama's install script against the SHA-256 Ollama publishes beside it, saves it to a file, and runs that file. Nothing is piped into a shell. The script then fetches Ollama itself from ollama.com over its own secure connection and checks it the way its publisher does.",
    steps: [{ what: "Run Ollama's install script", command: ["/bin/sh", "{file}"] }],
    after: "The script may ask for your password so it can put Ollama in place.",
  });
}

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
  const ran: string[][] = [];
  for (const step of plan.steps) {
    deps.signal?.throwIfAborted();
    const command = step.command.map((part) => part.replaceAll("{file}", file).replaceAll("{unpacked}", unpacked));
    ran.push(command);
    try {
      await deps.run(command[0]!, command.slice(1), { timeout: 20 * 60 * 1000, windowsHide: true });
    } catch (error) {
      return { installed: false, ran, message: stepFailure(plan, step, error) };
    }
  }
  return { installed: true, ran, message: `${plan.name} was installed${plan.after ? `. ${plan.after}` : "."}` };
}

function stepFailure(plan: InstallPlan, step: InstallStep, error: unknown): string {
  const said = String((error as { stderr?: string })?.stderr ?? (error as Error)?.message ?? "").trim().slice(0, 300);
  return `Branch could not install ${plan.name}: the step "${step.what}" did not work${said ? `. It said: ${said}` : "."} `
    + `Nothing was left half-installed by Branch. You can install it yourself from ${runtimeInfo[plan.runner].installPage}.`;
}

/** How big the download is, in plain words, for the sentence the owner reads before saying yes. */
export const planSize = (plan: Pick<InstallPlan, "approxBytes">): string => plan.approxBytes >= 1024 ** 3
  ? `about ${gb(plan.approxBytes)} GB`
  : plan.approxBytes >= 1024 ** 2 ? `about ${Math.round(plan.approxBytes / 1024 ** 2)} MB`
    : `about ${Math.round(plan.approxBytes / 1024)} KB`;
