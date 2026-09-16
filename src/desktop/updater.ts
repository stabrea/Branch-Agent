import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * One-button updates from GitHub Releases. The app downloads the published archive, checks it
 * against the published SHA-256, unpacks it beside the install, then hands over to a small script
 * that waits for the app to exit, mirrors the new files into place and starts the new version.
 */
export interface UpdaterOptions {
  repo: string;
  currentVersion: string;
  /** Folder that holds the running executable, or null when not running from an installed copy. */
  installDir: string | null;
  executableName: string;
  assetName: string;
  scratchDir: string;
  fetch?: typeof fetch;
  extract?: (archive: string, into: string) => Promise<void>;
  /**
   * Takes a safety copy of the person's saved work before the new files are put in place. When it
   * fails the update stops, because an update without something to go back to is not worth the risk.
   */
  backup?: () => Promise<void>;
  /**
   * Closes the engine that keeps working with the window closed, so the old program files are not
   * held open while they are replaced. Answers with the process id that was closed, or null when
   * nothing was working in the background.
   */
  stopDaemon?: () => Promise<number | null>;
}
export interface ReleaseInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  tag: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  assetUrl: string;
  checksumUrl: string;
  assetBytes: number;
  pageUrl: string;
}
export type UpdatePhase =
  | "idle" | "checking" | "current" | "available" | "downloading" | "verifying"
  | "unpacking" | "ready" | "applying" | "error" | "unsupported";
export interface UpdateStatus {
  phase: UpdatePhase;
  message: string;
  progress: number | null;
  release: ReleaseInfo | null;
  /** Download size so far and in total, while downloading. */
  bytes: { received: number; total: number } | null;
  updatedAt: string;
}
const releaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string().url(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number().int().nonnegative() })),
});

export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a), right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export class Updater {
  status: UpdateStatus = { phase: "idle", message: "Updates have not been checked yet.", progress: null, release: null, bytes: null, updatedAt: new Date().toISOString() };
  private busy = false;
  /** True while a download, check, unpack or hand-over is under way. */
  get inProgress(): boolean { return this.busy; }
  private readonly fetch: typeof fetch;
  private readonly extract: (archive: string, into: string) => Promise<void>;
  constructor(private readonly options: UpdaterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.extract = options.extract ?? expandArchive;
    if (!options.installDir)
      this.status = { phase: "unsupported", message: "Updates apply to the installed app only.", progress: null, release: null, bytes: null, updatedAt: new Date().toISOString() };
  }
  async check(): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    this.set("checking", "Checking GitHub for a newer version…");
    try {
      const release = await this.latestRelease();
      if (!release.available) return this.set("current", `You have the newest version (${release.currentVersion}).`, null, release);
      return this.set("available", `Version ${release.latestVersion} is ready to install.`, null, release);
    } catch (error) {
      return this.set("error", error instanceof Error ? error.message : String(error));
    }
  }
  /** Downloads, verifies and unpacks the release; returns the hand-over script for the caller to launch. */
  async install(): Promise<{ script: string; stagedDir: string }> {
    if (!this.options.installDir) throw new Error("Updates apply to the installed app only.");
    if (this.busy) throw new Error("An update is already in progress.");
    const release = this.status.release?.available ? this.status.release : (await this.check()).release;
    if (!release?.available) throw new Error("There is no newer version to install.");
    this.busy = true;
    try {
      await rm(this.options.scratchDir, { recursive: true, force: true });
      await mkdir(this.options.scratchDir, { recursive: true });
      const archive = join(this.options.scratchDir, this.options.assetName);
      await this.download(release, archive);
      await this.verify(archive, release);
      const stagedDir = await this.unpack(archive);
      await this.safetyCopy();
      const script = await this.writeScript(stagedDir, await this.stopBackground());
      this.set("ready", "Restarting to finish the update…", 1, release);
      return { script, stagedDir };
    } catch (error) {
      this.set("error", error instanceof Error ? error.message : String(error), null, release);
      throw error;
    } finally { this.busy = false; }
  }
  /** The safety copy taken just before the files are swapped; three are kept by the caller. */
  private async safetyCopy(): Promise<void> {
    if (!this.options.backup) return;
    this.set("unpacking", "Making a safety copy of your work before the update…", null, this.status.release);
    try {
      await this.options.backup();
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/\.?$/, ".");
      throw new Error(`The safety copy could not be made, so the update was stopped: ${why} Free some space on this drive, or move Branch's data folder somewhere it can write, then try the update again.`);
    }
  }
  /**
   * Closes the engine working in the background before the files are swapped, and answers with its
   * process id so the hand-over waits for it as well. A refusal never stops the update: the hand-over
   * script ends that process itself if it has to.
   */
  private async stopBackground(): Promise<number | null> {
    if (!this.options.stopDaemon) return null;
    this.set("unpacking", "Closing the part of Branch that keeps working with the window closed…", null, this.status.release);
    try { return await this.options.stopDaemon(); } catch { return null; }
  }
  private async latestRelease(): Promise<ReleaseInfo> {
    const response = await this.fetch(`https://api.github.com/repos/${this.options.repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `BranchAgent/${this.options.currentVersion}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) throw new Error("No release has been published yet.");
    if (!response.ok) throw new Error(`GitHub did not answer (HTTP ${response.status}). Try again later.`);
    const data = releaseSchema.parse(await response.json());
    const asset = data.assets.find((entry) => entry.name === this.options.assetName);
    const checksum = data.assets.find((entry) => entry.name === `${this.options.assetName}.sha256`);
    if (!asset || !checksum) throw new Error("The newest release is missing its Windows download or checksum.");
    const latestVersion = data.tag_name.replace(/^v/i, "");
    return {
      currentVersion: this.options.currentVersion, latestVersion, tag: data.tag_name,
      available: compareVersions(latestVersion, this.options.currentVersion) > 0,
      title: data.name || data.tag_name, notes: data.body ?? "", publishedAt: data.published_at ?? null,
      assetUrl: asset.browser_download_url, checksumUrl: checksum.browser_download_url, assetBytes: asset.size,
      pageUrl: data.html_url,
    };
  }
  private async download(release: ReleaseInfo, target: string): Promise<void> {
    this.set("downloading", "Downloading the new version…", 0, release);
    const response = await this.fetch(release.assetUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` } });
    if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get("content-length")) || release.assetBytes || 0;
    const file = createWriteStream(target, { flags: "wx" });
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > 1_500_000_000) throw new Error("The download is larger than expected.");
        if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
        if (total) this.set("downloading", "Downloading the new version…", Math.min(0.99, received / total), release, { received, total });
      }
    } finally { await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve())); }
  }
  private async verify(archive: string, release: ReleaseInfo): Promise<void> {
    this.set("verifying", "Checking the download is exactly what was published…", null, release);
    const response = await this.fetch(release.checksumUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` } });
    if (!response.ok) throw new Error("The published checksum could not be read.");
    const expected = /^([a-f0-9]{64})\b/i.exec((await response.text()).trim())?.[1]?.toLowerCase();
    if (!expected) throw new Error("The published checksum is not readable.");
    const hash = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expected) throw new Error("The download did not match the published checksum, so it was not installed.");
  }
  private async unpack(archive: string): Promise<string> {
    this.set("unpacking", "Unpacking…", null, this.status.release);
    const into = join(this.options.scratchDir, "unpacked");
    await mkdir(into, { recursive: true });
    await this.extract(archive, into);
    return findExecutableDir(into, this.options.executableName);
  }
  private async writeScript(stagedDir: string, daemonPid: number | null = null): Promise<string> {
    const script = join(this.options.scratchDir, "apply-update.cmd");
    const install = this.options.installDir!, image = this.options.executableName;
    const exe = join(install, image), previous = `${install}.previous`, log = join(this.options.scratchDir, "apply-update.log");
    // System32 paths: the script may inherit a PATH where "find" is a Unix tool. tasklist's image
    // filter misses names with spaces, so the CSV listing is searched instead.
    const sys = "%SystemRoot%\\System32\\";
    const mirror = (from: string, to: string) => `${sys}robocopy.exe "${from}" "${to}" /MIR /R:10 /W:1 /NP /NFL /NDL >>"${log}" 2>&1`;
    const running = `${sys}tasklist.exe /NH /FO CSV 2>NUL | ${sys}find.exe /I "${image}" >NUL`;
    // `ping` is used as a sleep because `timeout` exits at once when standard input is not a console.
    const sleep = (seconds: number) => `${sys}ping.exe -n ${seconds + 1} 127.0.0.1 >NUL`;
    const waitFor = (pid: string, label: string, counter: string, what: string) => [
      `set ${counter}=0`, `:${label}`, `${sys}tasklist.exe /FI "PID eq ${pid}" /NH /FO CSV 2>NUL | ${sys}find.exe ",""${pid}""," >NUL`,
      `if not errorlevel 1 if %${counter}% lss 60 ( set /a ${counter}+=1 & ${sleep(1)} & goto ${label} )`,
      `if not errorlevel 1 ( echo [%time%] ${what} still open after %${counter}% waits; ending it >>"${log}" & ${sys}taskkill.exe /PID ${pid} /T /F >NUL 2>&1 & ${sleep(2)} )`,
      `echo [%time%] ${what} closed >>"${log}"`,
    ];
    await writeFile(script, [
      "@echo off", "setlocal", 'set "PID=%~1"', "set TRIES=0", `echo [%date% %time%] update started for pid %PID% >>"${log}"`,
      // The app asked itself to close; if it has not gone within about two minutes, end it so the update still lands.
      ...waitFor("%PID%", "wait", "WAITED", "app"),
      // The engine that keeps working with the window closed holds the same files open, so it is
      // waited for too; it was already asked to close before this script was started.
      ...(daemonPid ? waitFor(String(daemonPid), "engine", "EWAITED", "background engine") : []),
      "set DRAIN=0", ":drain", running, `if not errorlevel 1 if %DRAIN% lss 15 ( set /a DRAIN+=1 & ${sleep(1)} & goto drain )`, sleep(2),
      `echo [%time%] keeping previous version >>"${log}"`, mirror(install, previous), "if errorlevel 8 exit /b 1",
      ":copy", "set /a TRIES+=1", `echo [%time%] copying new version, attempt %TRIES% >>"${log}"`, mirror(stagedDir, install),
      `if errorlevel 8 ( if %TRIES% lss 3 ( ${sleep(3)} & goto copy ) else goto restore )`,
      'if "%~2"=="stay" exit /b 0',
      `echo [%time%] starting new version >>"${log}"`, `start "" "${exe}"`, sleep(20), running, "if not errorlevel 1 exit /b 0",
      sleep(15), running, "if not errorlevel 1 exit /b 0",
      ":restore", `echo [%time%] new version did not start; restoring previous >>"${log}"`,
      mirror(previous, install), `start "" "${exe}"`, "exit /b 1", "",
    ].join("\r\n"), "utf8");
    return script;
  }
  private set(phase: UpdatePhase, message: string, progress: number | null = null, release: ReleaseInfo | null = this.status.release, bytes: UpdateStatus["bytes"] = null): UpdateStatus {
    this.status = { phase, message, progress, release, bytes, updatedAt: new Date().toISOString() };
    return this.status;
  }
  /** Marks the hand-over as running once the script has been launched; the app is about to close. */
  applying(): UpdateStatus {
    this.busy = true;
    return this.set("applying", "Closing to finish the update. The app opens again by itself in a moment.", 1, this.status.release);
  }
}

async function findExecutableDir(root: string, executableName: string): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === executableName)) return dir;
    for (const entry of entries) if (entry.isDirectory()) queue.push(join(dir, entry.name));
  }
  throw new Error("The download did not contain the app.");
}
/** Unpacks with the built-in tar (fast) and falls back to PowerShell's Expand-Archive when tar is missing. */
async function expandArchive(archive: string, into: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Automatic updates are available on Windows only.");
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const tar = join(root, "System32", "tar.exe");
  try {
    await stat(tar);
    await promisify(execFile)(tar, ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 1048576 });
  } catch {
    await promisify(execFile)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:BRANCH_ARCHIVE -DestinationPath $env:BRANCH_INTO -Force",
    ], { env: { ...process.env, BRANCH_ARCHIVE: archive, BRANCH_INTO: into }, windowsHide: true, maxBuffer: 1048576 });
  }
  await stat(into);
}
