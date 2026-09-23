import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { posixHandOverScript, windowsKeep, windowsKeepOut } from "./hand-over.js";
import { checksumAssetName } from "./release-assets.js";

/**
 * One-button updates from GitHub Releases. The app downloads the published archive, checks it
 * against the published SHA-256, unpacks it beside the install, then hands over to a small script
 * that waits for the app to exit, mirrors the new files into place and starts the new version.
 */
export interface UpdaterOptions {
  repo: string;
  currentVersion: string;
  /** Stable stays on GitHub's latest final release; beta also considers published prereleases. */
  channel?: UpdateChannel;
  /** Folder that holds the running executable, or null when not running from an installed copy. */
  installDir: string | null;
  /** Windows and Linux: the program file. macOS: the `.app` bundle's folder name. */
  executableName: string;
  /** The download for this computer, or null when none is published for it. */
  assetName: string | null;
  scratchDir: string;
  /** True for a built app (not a source checkout), even when it is not where updates can reach it. */
  packaged?: boolean;
  /** Which system the update is for; defaults to this computer's. */
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  extract?: (archive: string, into: string) => Promise<void>;
  /**
   * Takes a safety copy of the person's saved work before the new files are put in place. When it
   * fails the update stops, because an update without something to go back to is not worth the risk.
   */
  backup?: () => Promise<void>;
  /** Re-check all tasks at the last safe point, before a background engine can be stopped. */
  beforeStop?: () => Promise<void>;
  /**
   * Politely closes the engine that keeps working with the window closed. A refusal defers the
   * update; it must not be swallowed and followed by a hand-over that forcibly ends the engine.
   */
  stopDaemon?: () => Promise<number | null>;
  /**
   * mac3/never-break: tries the unpacked version on a copy of the owner's data before anything is
   * swapped. Throws a plain sentence when the new version did not pass; the update then stops.
   */
  canary?: (stagedDir: string, version: string) => Promise<void>;
  /** mac7/real-update: how long the download may go without a byte before it counts as dropped (60 s). */
  stallMs?: number;
  /** Windows: the registry key the update's recovery script is registered under (HKCU RunOnce); tests hand in their own. */
  runOnceKey?: string;
}
export type UpdateChannel = "stable" | "beta";
export class UpdateDeferredError extends Error {}
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
  channel: UpdateChannel;
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
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string().url(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number().int().nonnegative() })),
});

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`Invalid Branch version: ${value}`);
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
      pre: match[4]?.split(".") ?? [] };
  };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = left.numbers[index]! - right.numbers[index]!;
    if (difference) return Math.sign(difference);
  }
  if (!left.pre.length || !right.pre.length) return Number(right.pre.length > 0) - Number(left.pre.length > 0);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const one = left.pre[index], two = right.pre[index];
    if (one === undefined || two === undefined) return one === undefined ? -1 : 1;
    if (one === two) continue;
    const numericOne = /^\d+$/.test(one), numericTwo = /^\d+$/.test(two);
    if (numericOne && numericTwo) return Math.sign(Number(one) - Number(two));
    if (numericOne !== numericTwo) return numericOne ? -1 : 1;
    return one < two ? -1 : 1;
  }
  return 0;
}

/** Automatic updates accept only ordinary final SemVer tags, never aliases or prereleases. */
export function finalReleaseVersion(tag: string): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag);
  if (!match) throw new Error("The newest GitHub entry does not use a final release tag such as v1.2.3, so Branch did not offer it as an update.");
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
}

/** Rolling beta artifacts have one next-patch line and a monotonically increasing run number. */
export function betaReleaseVersion(tag: string): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/.exec(tag);
  if (!match) throw new Error("The beta release tag is not a Branch beta version.");
  return tag.slice(1);
}

function newestBetaCandidate(raw: unknown): z.infer<typeof releaseSchema> {
  const releases = z.array(releaseSchema).parse(raw);
  const accepted = releases.filter((entry) => {
    if (entry.draft) return false;
    try {
      if (entry.prerelease) betaReleaseVersion(entry.tag_name);
      else finalReleaseVersion(entry.tag_name);
      return true;
    } catch { return false; }
  });
  accepted.sort((one, two) => compareVersions(two.tag_name, one.tag_name));
  if (!accepted[0]) throw new Error("No published Branch beta or stable release is available yet.");
  return accepted[0];
}

function betaAssetMatches(release: z.infer<typeof releaseSchema>, repo: string,
  asset: { name: string; browser_download_url: string }): boolean {
  const url = new URL(asset.browser_download_url);
  return url.protocol === "https:" && url.hostname === "github.com" && !url.search && !url.hash &&
    url.pathname === `/${repo}/releases/download/${release.tag_name}/${asset.name}`;
}

export class Updater {
  status: UpdateStatus = { phase: "idle", message: "Updates have not been checked yet.", progress: null, release: null, bytes: null, updatedAt: new Date().toISOString() };
  private busy = false;
  private channel: UpdateChannel;
  private generation = 0;
  /** True while a download, check, unpack or hand-over is under way. */
  get inProgress(): boolean { return this.busy; }
  private readonly fetch: typeof fetch;
  private readonly extract: (archive: string, into: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  constructor(private readonly options: UpdaterOptions) {
    this.channel = options.channel ?? "stable";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.platform = options.platform ?? process.platform;
    const platform = this.platform;
    this.extract = options.extract ?? ((archive, into) => expandArchive(archive, into, platform));
    const reason = unsupportedReason(options, platform);
    if (reason)
      this.status = { phase: "unsupported", message: reason, progress: null, release: null, bytes: null, updatedAt: new Date().toISOString() };
  }
  get selectedChannel(): UpdateChannel { return this.channel; }
  setChannel(channel: UpdateChannel): UpdateStatus {
    if (this.busy) throw new Error("Wait for the current update before changing channels.");
    if (channel === this.channel) return this.status;
    this.channel = channel;
    this.generation++;
    return this.set("idle", `Checking ${channel} updates has not started yet.`, null, null);
  }
  async check(): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    return this.lookUp();
  }
  /** The look-up itself. An install that has already claimed the updater uses this, not `check`. */
  private async lookUp(): Promise<UpdateStatus> {
    const generation = ++this.generation;
    this.set("checking", "Checking GitHub for a newer version…");
    try {
      const release = await this.latestRelease();
      if (generation !== this.generation) return this.status;
      if (!release.available) return this.set("current", `You have the newest version (${release.currentVersion}).`, null, release);
      return this.set("available", `Version ${release.latestVersion} is ready to install.`, null, release);
    } catch (error) {
      if (generation !== this.generation) return this.status;
      return this.set("error", error instanceof Error ? error.message : String(error));
    }
  }
  /**
   * Downloads, verifies and unpacks the release; returns the hand-over script for the caller to launch.
   * CBQ-001: with `hold`, the claim is kept once this returns, because the caller still has the hand-over
   * to start - three scheduler calls of up to 15 s each - and a second request in that time would empty
   * the scratch folder the first hand-over is about to use and start a second one. `applying()` keeps
   * the claim from there; `release()` gives it back if the hand-over could not be started.
   */
  async install(options: { hold?: boolean } = {}): Promise<{ script: string; stagedDir: string }> {
    const reason = unsupportedReason(this.options, this.platform);
    if (reason) throw new Error(reason);
    if (this.busy) throw new Error("An update is already in progress.");
    // CBQ-001: claimed here, before anything is awaited. Looking the release up is a network round
    // trip, and `busy` used to be set only after it, so two requests arriving during that trip both
    // read `busy` as false and both went on. That is not two downloads of one file; the second one
    // empties the scratch folder the first is downloading into, and the first fails on its own
    // archive. Two hand-overs for one app is the multiplication this row forbids.
    this.busy = true;
    let release: ReleaseInfo | null | undefined;
    try {
      // Beta or Stable (#215): a release chosen for the other channel is looked up again.
      const selected = this.status.release;
      release = selected?.available && selected.channel === this.channel ? selected : (await this.lookUp()).release;
      if (!release?.available) throw new Error("There is no newer version to install.");
    } catch (error) {
      // Nothing has been touched yet, so the claim is simply given back: no status change and no
      // files removed, exactly as when these two refusals happened before the claim existed.
      this.busy = false;
      throw error;
    }
    let held = false;
    try {
      await rm(this.options.scratchDir, { recursive: true, force: true });
      await mkdir(this.options.scratchDir, { recursive: true });
      if (this.platform !== "win32") await ensurePrivateDir(this.options.scratchDir);
      const archive = join(this.options.scratchDir, this.options.assetName!);
      await this.download(release, archive);
      await this.verify(archive, release);
      const stagedDir = await this.unpack(archive);
      await validateStagedPackage(stagedDir, release.latestVersion, this.platform);
      await this.tryCanary(stagedDir, release.latestVersion); // mac3/never-break
      await this.safetyCopy();
      await this.options.beforeStop?.();
      const script = await this.writeScript(stagedDir, await this.stopBackground());
      this.set("ready", "Restarting to finish the update…", 1, release);
      held = options.hold === true;
      return { script, stagedDir };
    } catch (error) {
      this.set(error instanceof UpdateDeferredError ? "available" : "error",
        error instanceof Error ? error.message : String(error), null, release);
      // mac7/real-update: a download that went wrong is 130 MB or more of nothing; it is not kept.
      await rm(join(this.options.scratchDir, this.options.assetName!), { force: true }).catch(() => undefined);
      await rm(join(this.options.scratchDir, "unpacked"), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally { if (!held) this.busy = false; }
  }
  /** Gives back a claim `install({ hold: true })` kept, when the hand-over it was kept for did not start. */
  release(): void { this.busy = false; }
  /** mac3/never-break: the new version must pass its own check on a copy of the data first. */
  private async tryCanary(stagedDir: string, version: string): Promise<void> {
    if (!this.options.canary) return;
    this.set("verifying", "Trying the new version on a copy of your work before using it…", null, this.status.release);
    try { await this.options.canary(stagedDir, version); }
    catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/\.?$/, ".");
      throw new Error(`The new version did not pass its check, so nothing was changed. ${why}`);
    }
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
   * process id so the hand-over waits for it as well. A refusal stops this attempt.
   */
  private async stopBackground(): Promise<number | null> {
    if (!this.options.stopDaemon) return null;
    this.set("unpacking", "Closing the part of Branch that keeps working with the window closed…", null, this.status.release);
    return this.options.stopDaemon();
  }
  private async latestRelease(): Promise<ReleaseInfo> {
    const path = this.channel === "stable" ? "releases/latest" : "releases?per_page=100";
    const response = await this.fetch(`https://api.github.com/repos/${this.options.repo}/${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `BranchAgent/${this.options.currentVersion}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) throw new Error("No release has been published yet.");
    if (!response.ok) throw new Error(`GitHub did not answer (HTTP ${response.status}). Try again later.`);
    const raw = await response.json();
    const data = this.channel === "stable" ? releaseSchema.parse(raw) : newestBetaCandidate(raw);
    if (data.draft || (this.channel === "stable" && data.prerelease))
      throw new Error("The newest stable release is not a published final release.");
    const asset = data.assets.find((entry) => entry.name === this.options.assetName);
    const checksum = data.assets.find((entry) => entry.name === checksumAssetName(this.options.assetName ?? ""));
    if (!asset || !checksum) throw new Error(`The newest release is missing its ${systemName(this.platform)} download or checksum.`);
    if (this.channel === "beta" &&
      (!betaAssetMatches(data, this.options.repo, asset) || !betaAssetMatches(data, this.options.repo, checksum)))
      throw new Error("The beta download does not belong to the selected Branch release.");
    const latestVersion = data.prerelease ? betaReleaseVersion(data.tag_name) : finalReleaseVersion(data.tag_name);
    return {
      currentVersion: this.options.currentVersion, latestVersion, tag: data.tag_name,
      available: compareVersions(latestVersion, this.options.currentVersion) > 0,
      title: data.name || data.tag_name, notes: data.body ?? "", publishedAt: data.published_at ?? null,
      assetUrl: asset.browser_download_url, checksumUrl: checksum.browser_download_url, assetBytes: asset.size,
      pageUrl: data.html_url,
      channel: this.channel,
    };
  }
  private async download(release: ReleaseInfo, target: string): Promise<void> {
    this.set("downloading", "Downloading the new version…", 0, release);
    // mac7/real-update: a connection that drops shows up as "terminated" and one that goes quiet
    // hangs for minutes; both now end the same way, in plain words, with nothing changed.
    const stalled = new AbortController();
    let quiet: NodeJS.Timeout | undefined;
    const listen = () => { clearTimeout(quiet); quiet = setTimeout(() => stalled.abort(), this.options.stallMs ?? 60000); };
    const dropped = () => new Error("The download stopped before it finished, so nothing was changed. Check the internet connection and press Update again.");
    listen();
    let response: Response;
    try {
      response = await this.fetch(release.assetUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` }, signal: stalled.signal });
    } catch { clearTimeout(quiet); throw dropped(); }
    if (!response.ok || !response.body) { clearTimeout(quiet); throw new Error(`Branch could not download the new version (the server answered ${response.status}), so nothing was changed. Check this computer's internet connection and try the update again.`); }
    const total = Number(response.headers.get("content-length")) || release.assetBytes || 0;
    const file = createWriteStream(target, { flags: "wx" });
    let received = 0;
    const reader = response.body.getReader();
    // One listener for the whole download (one per chunk would pile up thousands on the same signal).
    const quietTooLong = new Promise<never>((_resolve, reject) => {
      stalled.signal.addEventListener("abort", () => reject(dropped()), { once: true });
    });
    quietTooLong.catch(() => undefined);
    const next = () => Promise.race([reader.read().catch(() => { throw dropped(); }), quietTooLong]);
    try {
      for (let part = await next(); !part.done; part = await next()) {
        listen();
        received += part.value.byteLength;
        if (received > 1_500_000_000) throw new Error("The download of the new version was larger than the release says it should be, so Branch stopped it and changed nothing. Try the update again.");
        if (!file.write(part.value)) await new Promise<void>((resolve) => file.once("drain", resolve));
        if (total) this.set("downloading", "Downloading the new version…", Math.min(0.99, received / total), release, { received, total });
      }
    } finally {
      clearTimeout(quiet);
      reader.cancel().catch(() => undefined);
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()));
    }
    if (total && received < total) throw dropped();
  }
  private async verify(archive: string, release: ReleaseInfo): Promise<void> {
    this.set("verifying", "Checking the download is exactly what was published…", null, release);
    const response = await this.fetch(release.checksumUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` } });
    if (!response.ok) throw new Error("Branch could not read the checksum published with the new version, so it did not install the download. Branch is still on the version it had, and nothing was changed. Check this computer's internet connection and try the update again.");
    const expected = /^([a-f0-9]{64})\b/i.exec((await response.text()).trim())?.[1]?.toLowerCase();
    if (!expected) throw new Error("The checksum published with the new version did not arrive in full, so Branch did not install it. Branch is still on the version it had. Try the update again in a moment.");
    const hash = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== expected) throw new Error("The download did not match the published checksum, so Branch did not install it. Branch is still on the version it had, and nothing was changed. Try the update again; if it keeps happening, download the new version from the releases page by hand.");
  }
  private async unpack(archive: string): Promise<string> {
    this.set("unpacking", "Unpacking…", null, this.status.release);
    const into = join(this.options.scratchDir, "unpacked");
    await mkdir(into, { recursive: true });
    await this.extract(archive, into);
    if (this.platform === "darwin") return findBundle(into, this.options.executableName);
    return findExecutableDir(into, this.options.executableName);
  }
  private async writeScript(stagedDir: string, daemonPid: number | null = null): Promise<string> {
    if (this.platform !== "win32") return this.writePosixScript(stagedDir, daemonPid);
    const script = join(this.options.scratchDir, "apply-update.cmd");
    const install = this.options.installDir!, image = this.options.executableName;
    const exe = join(install, image), previous = `${install}.previous`, log = join(this.options.scratchDir, "apply-update.log");
    const recover = join(this.options.scratchDir, "recover-update.cmd");
    const runOnceKey = this.options.runOnceKey ?? "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce";
    await writeFile(recover, windowsRecoveryScript({ install, previous, failed: `${install}.failed`, incoming: `${install}.incoming`, log, runOnceKey }), "utf8");
    // System32 paths: the script may inherit a PATH where "find" is a Unix tool. tasklist's image
    // filter misses names with spaces, so the CSV listing is searched instead.
    const sys = "%SystemRoot%\\System32\\";
    const mirror = (from: string, to: string, extra = "") => `${sys}robocopy.exe "${from}" "${to}" /MIR${extra} /R:10 /W:1 /NP /NFL /NDL >>"${log}" 2>&1`;
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
      // mac7/real-update: the first real update showed that mirroring the new files straight over the
      // program folder, when cut off part-way, leaves a folder that is neither version. The new version is
      // now copied in beside the old one and the two folders swap by renaming, which is all or nothing.
      // Only when the folder cannot be renamed (something has it open) is it copied over as before.
      ...windowsSwap({ install, staged: stagedDir, previous, exe, log, sys, mirror, sleep, running, recover, runOnceKey,
        archive: join(this.options.scratchDir, this.options.assetName!), unpacked: join(this.options.scratchDir, "unpacked") }),
    ].join("\r\n"), "utf8");
    return script;
  }
  /** macOS and Linux: the shell hand-over from hand-over.ts, written beside the download. */
  private async writePosixScript(stagedDir: string, daemonPid: number | null): Promise<string> {
    const script = join(this.options.scratchDir, "apply-update.sh");
    await writeFile(script, posixHandOverScript({
      platform: this.platform === "darwin" ? "darwin" : "linux",
      target: this.options.installDir!, staged: stagedDir,
      log: join(this.options.scratchDir, "apply-update.log"),
      executableName: this.options.executableName, daemonPid,
      archive: join(this.options.scratchDir, this.options.assetName!),
    }), { encoding: "utf8", mode: 0o700 });
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

const packagedManifestSchema = z.object({ name: z.literal("branch-agent"), version: z.string() }).passthrough();

/** The bytes inside the archive must identify the same Branch release GitHub selected. */
export async function validateStagedPackage(stagedDir: string, expectedVersion: string, platform: NodeJS.Platform): Promise<void> {
  const manifest = platform === "darwin"
    ? join(stagedDir, "Contents", "Resources", "app", "package.json")
    : join(stagedDir, "resources", "app", "package.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(manifest, "utf8")); }
  catch { throw new Error("The download did not contain a readable Branch Agent package identity, so nothing was changed."); }
  const parsed = packagedManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The download is not a Branch Agent package, so nothing was changed.");
  if (parsed.data.version !== expectedVersion)
    throw new Error(`The download contains version ${parsed.data.version}, but the selected release is ${expectedVersion}, so nothing was changed.`);
}

export { windowsKeep };

interface WindowsSwapPlan {
  install: string; staged: string; previous: string; exe: string; log: string; sys: string; archive: string; unpacked: string;
  mirror: (from: string, to: string, extra?: string) => string; sleep: (seconds: number) => string; running: string;
  /** The script that puts a whole version back at the next sign-in if this one is cut off between the two renames. */
  recover: string;
  /** Where that script is registered to run once (HKCU RunOnce; tests hand in their own key). */
  runOnceKey: string;
}

/** The value name under RunOnce; removed again as soon as the folders are whole. */
export const recoveryValueName = "Branch Agent update recovery";

/**
 * mac7/real-update, integrator review. Between the two renames there is no program folder at all, and
 * the Start menu shortcut points into it. That moment is milliseconds long, but a power cut or a sign
 * out there would leave nothing to start, so the script below is registered to run once at the next
 * sign-in first and taken off again straight after. It only acts when the program folder is missing,
 * and then moves the previous version (which still has everything) back.
 */
export function windowsRecoveryScript(plan: { install: string; previous: string; failed: string; incoming: string; log: string; runOnceKey: string }): string {
  const { install } = plan;
  const back = (from: string) => `if not exist "${install}\\" if exist "${from}\\" move "${from}" "${install}" >NUL 2>&1`;
  return [
    "@echo off", `if exist "${install}\\" exit /b 0`,
    `echo [%date% %time%] the last update was cut off with no program folder; putting a whole version back >>"${plan.log}"`,
    back(plan.previous), back(plan.incoming), back(plan.failed),
    `%SystemRoot%\\System32\\reg.exe delete "${plan.runOnceKey}" /v "${recoveryValueName}" /f >NUL 2>&1`, "exit /b 0", "",
  ].join("\r\n");
}

/** The Windows swap: copy beside, rename twice, carry what is kept; the copy over the folder is the fallback. */
export function windowsSwap(plan: WindowsSwapPlan): string[] {
  const { install, previous, log, exe } = plan;
  const incoming = `${install}.incoming`, failed = `${install}.failed`, folder = windowsKeep.folder;
  const note = (text: string) => `echo [%time%] ${text} >>"${log}"`;
  const reg = `${plan.sys}reg.exe`;
  // Armed only for the two renames, so a cut there is put right at the next sign-in.
  const arm = `${reg} add "${plan.runOnceKey}" /v "${recoveryValueName}" /t REG_SZ /d "\\"${plan.recover}\\"" /f >NUL 2>&1`;
  const disarm = `${reg} delete "${plan.runOnceKey}" /v "${recoveryValueName}" /f >NUL 2>&1`;
  // A folder move onto one that exists nests instead of replacing, so Branch Data only moves into a copy without one.
  const carry = (from: string, to: string) => [
    ...windowsKeep.files.map((f) => `if exist "${from}\\${f}" copy /y "${from}\\${f}" "${to}\\" >NUL`),
    `if exist "${from}\\${folder}\\" if not exist "${to}\\${folder}\\" move "${from}\\${folder}" "${to}\\${folder}" >NUL`,
  ];
  return [
    ":copy", "set /a TRIES+=1", note("copying new version beside the old one, attempt %TRIES%"),
    `rmdir /s /q "${incoming}" 2>NUL`, plan.mirror(plan.staged, incoming),
    `if errorlevel 8 ( if %TRIES% lss 3 ( ${plan.sleep(3)} & goto copy ) else ( ${note("copy failed; nothing was changed")} & rmdir /s /q "${incoming}" 2>NUL & start "" "${exe}" & exit /b 1 ) )`,
    `call :drop "${previous}-2"`,
    `if exist "${previous}\\" if not exist "${previous}-2\\" move "${previous}" "${previous}-2" >NUL`,
    note("keeping previous version"),
    // A previous copy that could not be moved aside would swallow the program folder as a subfolder.
    `if exist "${previous}\\" goto inplace`,
    arm, `move "${install}" "${previous}" >NUL 2>&1`, `if errorlevel 1 ( ${disarm} & goto inplace )`,
    `move "${incoming}" "${install}" >NUL 2>&1`,
    `if errorlevel 1 ( ${note("new version could not be moved in; restoring previous")} & move "${previous}" "${install}" >NUL & ${disarm} & start "" "${exe}" & exit /b 1 )`,
    disarm, ...carry(previous, install), "goto swapped",
    ":inplace", note("the program folder is in use; copying over it instead"),
    plan.mirror(install, previous, windowsKeepOut), `if errorlevel 8 ( ${note("could not keep the previous version; nothing was changed")} & start "" "${exe}" & exit /b 1 )`,
    plan.mirror(incoming, install, windowsKeepOut), `if errorlevel 8 goto restore`, `rmdir /s /q "${incoming}" 2>NUL`,
    ":swapped",
    'if "%~2"=="stay" exit /b 0',
    note("starting new version"), `start "" "${exe}"`, plan.sleep(20), plan.running, "if not errorlevel 1 goto done",
    plan.sleep(15), plan.running, "if not errorlevel 1 goto done",
    ":restore", note("new version did not start; restoring previous"),
    `call :drop "${failed}"`, `if exist "${failed}\\" goto restorecopy`,
    arm, `move "${install}" "${failed}" >NUL 2>&1`, `if errorlevel 1 ( ${disarm} & goto restorecopy )`,
    `move "${previous}" "${install}" >NUL 2>&1`, `if errorlevel 1 ( move "${failed}" "${install}" >NUL & ${disarm} & goto restorecopy )`,
    disarm, ...carry(failed, install), "goto restored",
    ":restorecopy", plan.mirror(previous, install, windowsKeepOut),
    ":restored", note("previous version is back"), `start "" "${exe}"`, "exit /b 1",
    ":done", note("new version is running"), `rmdir /s /q "${plan.unpacked}" 2>NUL`, `del /q "${plan.archive}" 2>NUL`, "exit /b 0",
    // Removes an old copy, first moving any Branch Data left in it out beside the program; keeps the copy when that fails.
    ":drop", `if not exist "%~1\\" exit /b 0`,
    `if exist "%~1\\${folder}\\" move "%~1\\${folder}" "${install} - saved ${folder} %RANDOM%" >NUL 2>&1`,
    `if exist "%~1\\${folder}\\" ( ${note("kept %~1 because it holds " + folder)} & exit /b 1 )`,
    `rmdir /s /q "%~1" 2>NUL`, "exit /b 0", "",
  ];
}

const systemName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : "this computer's";

/** Why this copy cannot update itself, in plain words, or null when it can. */
function unsupportedReason(options: UpdaterOptions, platform: NodeJS.Platform): string | null {
  if (!options.assetName) return "Automatic updates are not available for this kind of computer yet. Download the newest version from GitHub instead.";
  if (options.installDir) return null;
  if (platform === "win32") return "Updates apply to the installed app only.";
  if (options.packaged && platform === "darwin")
    return "Updates apply to the installed app only. Move Branch Agent into your Applications folder, open it from there, and try again.";
  return "Updates apply to the installed app only. This copy is running from its source code, so update it with `branch update` instead.";
}

/**
 * macOS and Linux: the scratch folder can sit in a temp folder other people can write to (/tmp on
 * Linux), so it must be a real folder owned by this person and closed to everyone else before the
 * download and the hand-over script go into it.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid))
    throw new Error("The update folder is not safe to use (it belongs to someone else). Restart the computer and try again.");
  await chmod(dir, 0o700);
}

/** macOS: the unpacked `.app` bundle itself, wherever it sits in the download. */
async function findBundle(root: string, bundleName: string): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === bundleName) return join(dir, entry.name);
      if (!entry.name.endsWith(".app")) queue.push(join(dir, entry.name));
    }
  }
  throw new Error("The download did not contain a Branch to install, so nothing was changed. Branch is still on the version it had. Try the update again.");
}

async function findExecutableDir(root: string, executableName: string): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === executableName)) return dir;
    for (const entry of entries) if (entry.isDirectory()) queue.push(join(dir, entry.name));
  }
  throw new Error("The download did not contain a Branch to install, so nothing was changed. Branch is still on the version it had. Try the update again.");
}
type RunFile = (file: string, args: string[]) => Promise<unknown>;
const runFile: RunFile = (file, args) => promisify(execFile)(file, args, { maxBuffer: 1048576 });

/**
 * The unpack command for macOS and Linux. macOS uses ditto, which keeps the links and permissions
 * inside an app bundle that plain unzip would break.
 */
export function posixExtractCommand(platform: NodeJS.Platform, archive: string, into: string): [string, string[]] {
  if (platform === "darwin") return ["/usr/bin/ditto", ["-x", "-k", archive, into]];
  return ["tar", ["-xzf", archive, "-C", into]];
}

export async function expandArchive(archive: string, into: string, platform: NodeJS.Platform = process.platform, run: RunFile = runFile): Promise<void> {
  if (platform !== "win32") {
    const [file, args] = posixExtractCommand(platform, archive, into);
    await run(file, args);
    await stat(into);
    return;
  }
  await expandWindowsArchive(archive, into);
}

/** Unpacks with the built-in tar (fast) and falls back to PowerShell's Expand-Archive when tar is missing. */
async function expandWindowsArchive(archive: string, into: string): Promise<void> {
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
