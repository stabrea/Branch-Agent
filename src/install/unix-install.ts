import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { shellQuote } from "../desktop/hand-over.js";
import { stagedEngine } from "../never-break/canary.js";
import { launchdPlistPath } from "./launchd.js";
import { systemdUnitPath } from "./systemd.js";
import { runTool, type RunTool } from "./windows.js";

// These files only ever exist on macOS or Linux, so their paths use forward slashes wherever they are composed.
const { basename, dirname, join } = posix;

/**
 * Installing and removing Branch on macOS and Linux without a single question, the counterpart of
 * `installer.ts` on Windows. Everything goes into this person's own folders, so nothing needs an
 * administrator: the app, a `branch` command that talks to it, and on Linux a menu entry. Removing
 * Branch keeps conversations and files unless the person asks for them to go too.
 */
export type UnixPlatform = "darwin" | "linux";

export interface UnixLayout {
  platform: UnixPlatform;
  /** The installed program: the `.app` bundle on a Mac, the program folder on Linux. */
  installRoot: string;
  /** Where an install is looked for before a new one is made, the usual place first. */
  candidates: string[];
  /** The `branch` command the installer writes. */
  launcher: string;
  /** The "start by itself when you sign in" file, removed with the rest. */
  serviceFile: string;
  /** Linux: the applications-menu entry. */
  menuEntry: string | null;
  /** The folder the app keeps everything in (Electron's own per-person folder). */
  userDataDir: string;
  dataDir: string;
  workspace: string;
}

export const launcherMarker = "# Branch Agent's command, written by its installer.";
export const macBundle = "Branch Agent.app";
export const linuxProgram = "branch-agent";
const linuxAppFolder = "app";
const dataFolderName = "Branch Agent";

/** The default folders on each system (documented in docs/configuration.md). */
export function unixLayout(platform: UnixPlatform, env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): UnixLayout {
  const launcher = join(home, ".local", "bin", "branch");
  if (platform === "darwin") {
    const userDataDir = join(home, "Library", "Application Support", dataFolderName);
    const installRoot = join(home, "Applications", macBundle);
    return { platform, installRoot, candidates: [installRoot, join("/Applications", macBundle)], launcher, serviceFile: launchdPlistPath(home),
      menuEntry: null, userDataDir, dataDir: join(userDataDir, "state"), workspace: join(userDataDir, "workspace") };
  }
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const userDataDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), dataFolderName);
  const installRoot = join(dataHome, linuxProgram, linuxAppFolder);
  return { platform, installRoot, candidates: [installRoot], launcher, serviceFile: systemdUnitPath(env, home),
    menuEntry: join(dataHome, "applications", `${linuxProgram}.desktop`),
    userDataDir, dataDir: join(userDataDir, "state"), workspace: join(userDataDir, "workspace") };
}

/** The program file and the command-line script inside an installed (or unpacked) copy. */
export function programFiles(platform: UnixPlatform, root: string): { executable: string; cli: string } {
  const engine = stagedEngine(root, platform, platform === "darwin" ? macBundle : linuxProgram);
  return { executable: engine.executable, cli: engine.script };
}

/** The version inside a copy, or null when there is no copy there. */
export async function copyVersion(platform: UnixPlatform, root: string): Promise<string | null> {
  const manifest = join(dirname(dirname(programFiles(platform, root).cli)), "package.json");
  try {
    await stat(programFiles(platform, root).executable);
    const version = (JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch { return null; }
}

/** The `branch` command: the engine's script, run by the app's own runtime, on the app's own data. */
export function launcherScript(input: { platform: UnixPlatform; installRoot: string; dataDir: string; workspace: string }): string {
  const q = shellQuote, { executable, cli } = programFiles(input.platform, input.installRoot);
  return [
    "#!/bin/sh", launcherMarker, "# Removing Branch Agent removes this file too.",
    "ELECTRON_RUN_AS_NODE=1", `BRANCH_EXECUTABLE=${q(executable)}`, `BRANCH_INSTALL_ROOT=${q(input.installRoot)}`,
    `[ -n "\${BRANCH_DATA_DIR:-}" ] || BRANCH_DATA_DIR=${q(input.dataDir)}`,
    `[ -n "\${BRANCH_WORKSPACE:-}" ] || BRANCH_WORKSPACE=${q(input.workspace)}`,
    "export ELECTRON_RUN_AS_NODE BRANCH_EXECUTABLE BRANCH_INSTALL_ROOT BRANCH_DATA_DIR BRANCH_WORKSPACE",
    `exec ${q(executable)} ${q(cli)} "$@"`, "",
  ].join("\n");
}

/** Characters a menu entry's quoted `Exec` would have to escape; a folder with them gets no entry. */
const unsafeForMenu = /["`$\\\n]/;

/** The menu entry inside the download names files beside itself; installed, it names them in full. */
export function installedMenuEntry(text: string, root: string): string | null {
  if (unsafeForMenu.test(root)) return null;
  return text
    .replace(/^Exec="?branch-agent"?/m, `Exec="${root}/${linuxProgram}"`)
    .replace(/^Icon=branch-agent\.png$/m, `Icon=${root}/${linuxProgram}.png`);
}

export type CopyTree = (from: string, to: string) => Promise<void>;
/** macOS copies a bundle with ditto, which keeps everything a signed app needs; Linux uses cp. */
export function copyCommand(platform: UnixPlatform, from: string, to: string): [string, string[]] {
  return platform === "darwin" ? ["/usr/bin/ditto", [from, to]] : ["cp", ["-Rp", from, to]];
}
const copyWith = (platform: UnixPlatform, run: RunTool): CopyTree => async (from, to) => {
  const [file, args] = copyCommand(platform, from, to);
  await run(file, args);
};

export interface UnixInstallOptions {
  layout: UnixLayout;
  /** The unpacked app: the `.app` bundle on a Mac, the program folder on Linux. */
  source: string;
  version: string;
  /** Linux: false leaves the applications menu alone. */
  menuEntry?: boolean;
  /** Put the same version in again (a repair) instead of attaching to it. */
  repair?: boolean;
  copy?: CopyTree;
  run?: RunTool;
}
export interface UnixInstallReport {
  installRoot: string;
  launcher: string;
  menuEntry: string | null;
  previousKept: string | null;
  /** True when this very version was already there and was only linked up again. */
  attached: boolean;
  version: string;
  dataDir: string;
}

/** The copy to use: an existing install wherever it was found, otherwise the usual place. */
export async function findInstall(layout: UnixLayout): Promise<{ root: string; version: string } | null> {
  for (const root of layout.candidates) {
    const version = await copyVersion(layout.platform, root);
    if (version) return { root, version };
  }
  return null;
}

async function checkSource(layout: UnixLayout, source: string): Promise<void> {
  if (layout.platform === "darwin" && basename(source) !== macBundle)
    throw new Error(`Tell the installer where ${macBundle} is: --source <path to ${macBundle}>`);
  if (!(await copyVersion(layout.platform, source))) throw new Error("The download did not contain the app.");
}

/** Moves the copy that is there aside as `<name>.previous`, then puts the new one in its place. */
async function replaceCopy(root: string, source: string, copy: CopyTree): Promise<string | null> {
  const previous = `${root}.previous`;
  const had = await stat(root).then(() => true, () => false);
  await rm(previous, { recursive: true, force: true });
  if (had) await rename(root, previous);
  await mkdir(dirname(root), { recursive: true });
  try {
    await copy(source, root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (had) await rename(previous, root);
    throw error;
  }
  return had ? previous : null;
}

const menuMarker = "X-Branch-Agent-Version=";

/**
 * Whether the installer may write `path`: nothing is there, or a plain file it wrote itself. A file
 * somebody else put there (another program's `branch`), or a link to somewhere else, is never replaced.
 */
async function mayWrite(path: string, marker: string): Promise<boolean> {
  const found = await lstat(path).catch(() => null);
  if (!found) return true;
  return found.isFile() && (await ours(path, marker));
}

/** Written beside the target and moved into place, so a link planted in between is replaced, never followed. */
async function writeInPlace(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const incoming = `${path}.incoming-${process.pid}`;
  await rm(incoming, { force: true });
  await writeFile(incoming, text, { encoding: "utf8", mode, flag: "wx" });
  await chmod(incoming, mode);
  await rename(incoming, path);
}

async function writeMenuEntry(root: string, path: string): Promise<string | null> {
  const text = await readFile(join(root, `${linuxProgram}.desktop`), "utf8").catch(() => null);
  const entry = text === null ? null : installedMenuEntry(text, root);
  if (entry === null || !(await mayWrite(path, menuMarker))) return null;
  await writeInPlace(path, entry, 0o644);
  return path;
}

/** Installs, or links up the copy that is already there, and writes the `branch` command. */
export async function performUnixInstall(options: UnixInstallOptions): Promise<UnixInstallReport> {
  const { layout } = options;
  await checkSource(layout, options.source);
  if (!(await mayWrite(layout.launcher, launcherMarker)))
    throw new Error(`There is already a different \`branch\` command at ${layout.launcher}, so nothing was installed. Move it away and run the installer again.`);
  const found = await findInstall(layout);
  const root = found?.root ?? layout.installRoot;
  // A copy found outside this person's own folder (a Mac's shared /Applications) is only linked up,
  // never written to: that would need an administrator and may be somebody else's.
  const elsewhere = root !== layout.installRoot;
  const attached = elsewhere || (found?.version === options.version && !options.repair);
  const previousKept = attached ? null
    : await replaceCopy(root, options.source, options.copy ?? copyWith(layout.platform, options.run ?? runTool));
  await writeInPlace(layout.launcher, launcherScript({ platform: layout.platform, installRoot: root, dataDir: layout.dataDir, workspace: layout.workspace }), 0o755);
  const menuEntry = layout.menuEntry && options.menuEntry !== false ? await writeMenuEntry(root, layout.menuEntry) : null;
  await mkdir(layout.dataDir, { recursive: true, mode: 0o700 });
  return { installRoot: root, launcher: layout.launcher, menuEntry, previousKept, attached,
    version: elsewhere ? found!.version : options.version, dataDir: layout.dataDir };
}

export interface UnixUninstallOptions {
  layout: UnixLayout;
  deleteData?: boolean;
  /** Closes Branch if it is running (see quit.ts). */
  stop: () => Promise<void>;
  /** Takes out the "start by itself when you sign in" entry (see daemon.ts). */
  removeService: () => Promise<void>;
}
export interface UnixUninstallReport {
  removed: string[];
  dataKept: string | null;
  /** Copies found that the installer did not put there, left as they are. */
  left: string[];
}

/** Only files the installer itself wrote are removed; anything else with the same name is left. */
async function ours(path: string, marker: string): Promise<boolean> {
  return readFile(path, "utf8").then((text) => text.includes(marker), () => false);
}
const installFolder = (layout: UnixLayout, root: string): boolean =>
  layout.platform === "darwin" ? basename(root) === macBundle : basename(root) === linuxAppFolder && basename(dirname(root)) === linuxProgram;

/**
 * Only the copy in this person's own folder is the installer's; one found elsewhere (a Mac's shared
 * /Applications) is reported and left. A link in place of a copy is removed as a link, never followed.
 */
async function removeCopies(layout: UnixLayout, removed: string[], left: string[]): Promise<void> {
  for (const root of layout.candidates) {
    if (root !== layout.installRoot) {
      if (await copyVersion(layout.platform, root)) left.push(root);
      continue;
    }
    if (!installFolder(layout, root)) continue;
    for (const path of [root, `${root}.previous`, `${root}.previous-2`, `${root}.failed`, `${root}.incoming`]) {
      if (!(await lstat(path).then(() => true, () => false))) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
    if (layout.platform === "linux") await rmdir(dirname(root)).catch(() => undefined);
  }
}

/** Closes Branch, takes out its sign-in entry, program, command and menu entry, and keeps the data unless asked. */
export async function performUnixUninstall(options: UnixUninstallOptions): Promise<UnixUninstallReport> {
  const { layout } = options, removed: string[] = [], left: string[] = [];
  await options.stop();
  await options.removeService();
  await removeCopies(layout, removed, left);
  for (const [path, marker] of [[layout.launcher, launcherMarker], [layout.menuEntry, menuMarker]] as const) {
    if (!path || !(await lstat(path).then((found) => found.isFile(), () => false)) || !(await ours(path, marker))) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  if (!options.deleteData || basename(layout.userDataDir) !== dataFolderName) return { removed, dataKept: layout.userDataDir, left };
  await rm(layout.userDataDir, { recursive: true, force: true });
  removed.push(layout.userDataDir);
  return { removed, dataKept: null, left };
}
