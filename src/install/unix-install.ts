import { access, chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { shellQuote } from "../desktop/hand-over.js";
import { stagedEngine } from "../never-break/canary.js";
import { launchdPlistPath } from "./launchd.js";
import { systemdUnitPath } from "./systemd.js";
import { LINUX_ICON_FOLDER, LINUX_ICON_SIZES, iconFileSize } from "./unix-icons.js";
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
  /** macOS: the shared Applications folder's copy, which is not this person's own. */
  sharedRoot: string | null;
  /** Linux: the icon theme this person's own menu reads (mac7/app-icon). */
  iconTheme: string | null;
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
    const sharedRoot = join("/Applications", macBundle);
    return { platform, installRoot, candidates: [installRoot, sharedRoot], launcher, serviceFile: launchdPlistPath(home),
      menuEntry: null, sharedRoot, iconTheme: null, userDataDir, dataDir: join(userDataDir, "state"), workspace: join(userDataDir, "workspace") };
  }
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const userDataDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), dataFolderName);
  const installRoot = join(dataHome, linuxProgram, linuxAppFolder);
  return { platform, installRoot, candidates: [installRoot], launcher, serviceFile: systemdUnitPath(env, home),
    menuEntry: join(dataHome, "applications", `${linuxProgram}.desktop`),
    sharedRoot: null, iconTheme: join(dataHome, "icons", "hicolor"),
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

/**
 * The menu entry inside the download names files beside itself; installed, it names them in full.
 * Once this person's icon theme holds the mark in every size, `Icon` names the theme's entry instead,
 * so each menu draws the size made for it rather than shrinking one big picture (mac7/app-icon).
 */
export function installedMenuEntry(text: string, root: string, themed = false): string | null {
  if (unsafeForMenu.test(root)) return null;
  return text
    .replace(/^Exec="?branch-agent"?/m, `Exec="${root}/${linuxProgram}"`)
    .replace(/^Icon=branch-agent\.png$/m, themed ? `Icon=${linuxProgram}` : `Icon=${root}/${linuxProgram}.png`);
}

/** Whether this person can write inside a folder without an administrator; tests hand in their own. */
export type CanWrite = (path: string) => Promise<boolean>;
const canWriteDir: CanWrite = (path) => access(path, constants.W_OK).then(() => true, () => false);

/**
 * Whether a copy is the installer's to write over and to remove again. This person's own folder
 * always is. The shared `/Applications` on a Mac only is when this person can write it without an
 * administrator: otherwise it may be somebody else's, and it is left exactly as it was found.
 */
export async function updatable(layout: UnixLayout, root: string, canWrite: CanWrite = canWriteDir): Promise<boolean> {
  return root === layout.installRoot || canWrite(dirname(root));
}

/** Where a fresh install goes: the shared Applications folder when it was asked for and can be written. */
export async function chooseRoot(layout: UnixLayout, applications: boolean, canWrite: CanWrite = canWriteDir): Promise<string> {
  if (!applications || !layout.sharedRoot) return layout.installRoot;
  return (await canWrite(dirname(layout.sharedRoot))) ? layout.sharedRoot : layout.installRoot;
}

/**
 * macOS marks everything that came from the internet, and that mark travels through the zip into the
 * unpacked app and through the copy into the installed one — so macOS then refuses to open it. The
 * installer takes the mark off the copy it just made, and off nothing else. The command is quiet and
 * gives the same answer whether or not the mark was there.
 */
export async function clearQuarantine(platform: UnixPlatform, root: string, run: RunTool): Promise<boolean> {
  if (platform !== "darwin") return false;
  await run("/usr/bin/xattr", ["-r", "-d", "com.apple.quarantine", root]).catch(() => undefined);
  return true;
}

/**
 * Copies each ready-made size out of the download into this person's own icon theme, so menus, docks
 * and switchers all draw a mark made for their size. Returns what was written.
 */
export async function installIcons(layout: UnixLayout, root: string): Promise<string[]> {
  if (!layout.iconTheme) return [];
  const from = join(root, LINUX_ICON_FOLDER);
  const names = await readdir(from).catch(() => [] as string[]);
  const written: string[] = [];
  for (const name of names.sort()) {
    const size = iconFileSize(linuxProgram, name);
    if (size === null) continue;
    const to = join(layout.iconTheme, `${size}x${size}`, "apps", `${linuxProgram}.png`);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(from, name), to);
    written.push(to);
  }
  return written;
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
  /** macOS: put Branch in the shared Applications folder, when this person can write it. */
  applications?: boolean;
  copy?: CopyTree;
  run?: RunTool;
  canWrite?: CanWrite;
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
  /** macOS: the "came from the internet" mark was taken off the installed copy. */
  quarantineCleared: boolean;
  /** Linux: the icon files written into this person's own icon theme. */
  icons: string[];
  /** The copy that was moved out of the way when Branch moved into the shared Applications folder. */
  movedFrom: string | null;
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

async function writeMenuEntry(root: string, path: string, themed: boolean): Promise<string | null> {
  const text = await readFile(join(root, `${linuxProgram}.desktop`), "utf8").catch(() => null);
  const entry = text === null ? null : installedMenuEntry(text, root, themed);
  if (entry === null || !(await mayWrite(path, menuMarker))) return null;
  await writeInPlace(path, entry, 0o644);
  return path;
}

interface Target {
  root: string;
  found: { root: string; version: string } | null;
  /** Whether the installer may write that copy at all. */
  mine: boolean;
}

/**
 * Which copy this install acts on. Normally it is the one already there, wherever it was found.
 * Asking for the shared Applications folder wins over that, so "put Branch in Applications" moves it;
 * when that folder needs an administrator the ask is dropped and this person's own folder is used.
 */
async function chooseTarget(options: UnixInstallOptions, canWrite: CanWrite): Promise<Target> {
  const { layout } = options;
  const found = await findInstall(layout);
  const asked = await chooseRoot(layout, options.applications === true, canWrite);
  const root = asked === layout.installRoot ? found?.root ?? layout.installRoot : asked;
  return { root, found, mine: await updatable(layout, root, canWrite) };
}

/** After a move into the shared folder, the copy left in this person's own folder would only confuse. */
async function removeMoved(layout: UnixLayout, root: string): Promise<string | null> {
  if (root === layout.installRoot || !(await copyVersion(layout.platform, layout.installRoot))) return null;
  await rm(layout.installRoot, { recursive: true, force: true });
  return layout.installRoot;
}

/** Installs, or links up the copy that is already there, and writes the `branch` command. */
export async function performUnixInstall(options: UnixInstallOptions): Promise<UnixInstallReport> {
  const { layout } = options;
  await checkSource(layout, options.source);
  if (!(await mayWrite(layout.launcher, launcherMarker)))
    throw new Error(`There is already a different \`branch\` command at ${layout.launcher}, so nothing was installed. Move it away and run the installer again.`);
  const run = options.run ?? runTool;
  // A copy this person cannot write (a Mac's shared /Applications owned by somebody else) is only
  // linked up, never written to: that would need an administrator.
  const { root, found, mine } = await chooseTarget(options, options.canWrite ?? canWriteDir);
  const already = found?.root === root ? found : null;
  const attached = !mine || (already?.version === options.version && !options.repair);
  const previousKept = attached ? null
    : await replaceCopy(root, options.source, options.copy ?? copyWith(layout.platform, run));
  const movedFrom = attached ? null : await removeMoved(layout, root);
  const quarantineCleared = mine && (await clearQuarantine(layout.platform, root, run));
  await writeInPlace(layout.launcher, launcherScript({ platform: layout.platform, installRoot: root, dataDir: layout.dataDir, workspace: layout.workspace }), 0o755);
  const icons = await installIcons(layout, root);
  const menuEntry = layout.menuEntry && options.menuEntry !== false ? await writeMenuEntry(root, layout.menuEntry, icons.length > 0) : null;
  await mkdir(layout.dataDir, { recursive: true, mode: 0o700 });
  return { installRoot: root, launcher: layout.launcher, menuEntry, previousKept, attached,
    version: mine ? options.version : found?.version ?? options.version, dataDir: layout.dataDir,
    quarantineCleared, icons, movedFrom };
}

export interface UnixUninstallOptions {
  layout: UnixLayout;
  deleteData?: boolean;
  /** Closes Branch if it is running (see quit.ts). */
  stop: () => Promise<void>;
  /** Takes out the "start by itself when you sign in" entry (see daemon.ts). */
  removeService: () => Promise<void>;
  canWrite?: CanWrite;
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
async function removeCopies(layout: UnixLayout, removed: string[], left: string[], canWrite: CanWrite): Promise<void> {
  for (const root of layout.candidates) {
    // The same test the installer used: a shared copy this person cannot write without an
    // administrator was never written by it, so it is reported and left exactly as it is.
    if (root !== layout.installRoot && !(await canWrite(dirname(root)))) {
      if (await copyVersion(layout.platform, root)) left.push(root);
      continue;
    }
    if (!installFolder(layout, root)) continue;
    for (const path of [root, `${root}.previous`, `${root}.previous-2`, `${root}.failed`, `${root}.incoming`]) {
      if (!(await lstat(path).then(() => true, () => false))) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
    if (layout.platform === "linux" && root === layout.installRoot) await rmdir(dirname(root)).catch(() => undefined);
  }
}

/** The icon files the installer copied into this person's own icon theme go with the rest. */
async function removeIcons(layout: UnixLayout, removed: string[]): Promise<void> {
  if (!layout.iconTheme) return;
  for (const size of LINUX_ICON_SIZES) {
    const path = join(layout.iconTheme, `${size}x${size}`, "apps", `${linuxProgram}.png`);
    if (!(await lstat(path).then((found) => found.isFile(), () => false))) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
}

/** Closes Branch, takes out its sign-in entry, program, command and menu entry, and keeps the data unless asked. */
export async function performUnixUninstall(options: UnixUninstallOptions): Promise<UnixUninstallReport> {
  const { layout } = options, removed: string[] = [], left: string[] = [];
  await options.stop();
  await options.removeService();
  await removeCopies(layout, removed, left, options.canWrite ?? canWriteDir);
  await removeIcons(layout, removed);
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
