import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { launchdLabel, launchdPlistPath } from "../install/launchd.js";
import { systemdUnitName, systemdUnitPath } from "../install/systemd.js";

/**
 * The part of Branch the assistant can never change: the program itself, the gateway's settings,
 * the saved-work database and the updater. This is a hard refusal, checked before any rule, any
 * standing yes, any hook, Lockdown or any switch, so nothing the owner or the assistant sets can
 * lift it. It is what stops Branch breaking itself the way OpenClaw does when its agent edits its
 * own gateway. See docs/never-break.md, threat 1.
 *
 * Integration review (17 September): the first version split commands on spaces, so every macOS
 * path ("Application Support", "Branch Agent.app") slipped past it. Commands are now read the way a
 * shell reads them (quotes, escapes, variables), the whole text is also searched for each protected
 * place, wildcards are matched against the places, and file paths are followed through links.
 */
export interface ProtectedAreas {
  /** Folders and files no tool may change. */
  noChange: string[];
  /** Files no tool may even read: the database, the device key, the session key. */
  noRead: string[];
  /** Process ids of Branch itself (the engine and its gateway). */
  selfPids: number[];
  platform: NodeJS.Platform;
  workspace: string;
}

/** Files in the data folder that hold saved work or keys. */
export const guardedDataFiles = [
  "branch.sqlite", "branch.sqlite-wal", "branch.sqlite-shm", "branch.sqlite-journal",
  "journal.sqlite", "journal.sqlite-wal", "journal.sqlite-shm", "journal.sqlite-journal",
  "locker.key", "session-token", "chatgpt-auth.json",
] as const;
/** Files and folders in the data folder the gateway and the updater own. */
export const gatewayDataFiles = [
  "gateway.json", "gateway.good.json", "gateway.proposed.json", "gateway-state.json",
  "running.json", "first-start.json", "update-backups", "updates", "update-watch.json",
] as const;

const folds = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";
const pathsOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
/** One spelling for comparing: Windows' long-path prefix gone, one kind of slash, one Unicode form, one case. */
function canonical(path: string, platform: NodeJS.Platform): string {
  let text = path.normalize("NFC");
  if (platform === "win32") text = text.replace(/^\\\\[?.]\\(UNC\\)?/i, (_, unc: string | undefined) => (unc ? "\\\\" : "")).replace(/\//g, "\\");
  return folds(platform) ? text.toLowerCase() : text;
}

const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const a = canonical(child, platform), b = canonical(parent, platform);
  if (a === b) return true;
  const rel = pathsOf(platform).relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !pathsOf(platform).isAbsolute(rel);
};

/** The folder the running program was loaded from: the package root holding `dist/`. */
export function programRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/**
 * The whole installed program around a package root: the `.app` bundle on macOS (its launcher and
 * Info.plist sit outside `Contents/Resources/app`), the program folder holding `resources/app`
 * elsewhere (the launcher `.exe` sits beside `resources`). A plain checkout is itself.
 */
export function installedProgram(root: string): string {
  const bundle = /^(.*\.app)[\\/]Contents[\\/]Resources[\\/]app(\.asar)?$/i.exec(root);
  if (bundle) return bundle[1]!;
  const packaged = /^(.*)[\\/]resources[\\/]app(\.asar)?$/i.exec(root);
  return packaged ? packaged[1]! : root;
}

export interface AreaInput {
  workspace: string;
  dataDir: string;
  /** The installed program's folder; defaults to the folder this code was loaded from. */
  installRoot?: string | null;
  /** More folders the updater unpacks into. */
  extra?: string[];
  platform?: NodeJS.Platform;
  selfPids?: number[];
}

/** The same place as the file system spells it, when that differs (a link, `/tmp` on macOS, an 8.3 name). */
function realSpelling(path: string): string | null {
  try {
    const real = realpathSync.native(path);
    return real === path ? null : real;
  } catch { return null; }
}

/** The places that start Branch at sign-in, and the folder the updater unpacks a new version into. */
function serviceFiles(): string[] {
  return [launchdPlistPath(), systemdUnitPath(), join(tmpdir(), "branch-agent-update")];
}

/**
 * Works out the protected places. When the workspace sits inside the program's folder (a developer
 * working on Branch itself) only the parts that make up the running program are protected, so the
 * workspace stays usable; the data folder is treated the same way.
 */
export function protectedAreas(input: AreaInput): ProtectedAreas {
  const platform = input.platform ?? process.platform;
  const same = platform === process.platform;
  const workspace = same ? resolve(input.workspace) : input.workspace, dataDir = same ? resolve(input.dataDir) : input.dataDir;
  const noChange: string[] = [];
  const join2 = pathsOf(platform).join;
  for (const root of [input.installRoot ?? programRoot(), process.env.BRANCH_INSTALL_ROOT].filter(Boolean) as string[]) {
    const folder = installedProgram(same ? resolve(root) : root);
    if (inside(workspace, folder, platform))
      noChange.push(...["dist", "node_modules", "package.json", "resources", "app.asar"].map((part) => join2(folder, part)));
    else noChange.push(folder);
  }
  const dataFiles = [...guardedDataFiles, ...gatewayDataFiles].map((name) => join2(dataDir, name));
  if (inside(workspace, dataDir, platform)) noChange.push(...dataFiles);
  else noChange.push(dataDir);
  noChange.push(...(input.extra ?? []).map((path) => (same ? resolve(path) : path)));
  if (same) noChange.push(...serviceFiles());
  const noRead = guardedDataFiles.map((name) => join2(dataDir, name));
  const withReal = (list: string[]) => same ? [...new Set([...list, ...list.map(realSpelling).filter((p): p is string => p !== null)])] : list;
  return {
    noChange: withReal(noChange), noRead: withReal(noRead),
    selfPids: input.selfPids ?? [process.pid, process.ppid].filter((pid) => pid > 1),
    platform, workspace,
  };
}

/* ---------- reading what a call names ---------- */

/** Argument names that carry a place or a command, for calls that only look. */
const placeKeys = /(path|paths|file|files|target|destination|dest|source|src|from|to|cwd|dir|directory|folder|executable|command|args|argv|input|script|code|program|line|output|into|location|repo|root)$/i;

/** Strings a call carries: for a call that only looks, the ones under a place-like name; otherwise every one. */
function strings(value: unknown, keyed: boolean, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 400) return;
  if (typeof value === "string") { if (keyed) out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) strings(item, keyed, out, depth + 1); return; }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) strings(item, keyed || placeKeys.test(key), out, depth + 1);
}

/** `$NAME`, `${NAME}`, `%NAME%`, `$env:NAME` and a leading `~`, replaced where this computer knows them. */
export function expandVariables(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  const value = (name: string, whole: string) => (name.toUpperCase() === "HOME" ? home : env[name] ?? env[name.toUpperCase()] ?? whole);
  return text
    .replace(/(^|[\s"'=:(`])~(?=$|[\\/\s"'])/g, (_, before: string) => `${before}${home}`)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name: string) => value(name, whole))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a?: string, b?: string) => value((a ?? b)!, whole))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => (name.toUpperCase() === "USERPROFILE" ? home : env[name.toUpperCase()] ?? whole));
}

/** A variable, a command's output or an escape this reading could not resolve. */
export const unresolved = (text: string): boolean => /\$[{(A-Za-z_]|`|%[A-Za-z_]+%|\$env:/i.test(text);

/**
 * Splits a command the way a shell would: quotes keep spaces, a backslash escapes the next character
 * (except on Windows, where it separates folders), and `; | & < > ( )` end a word. The value of
 * `NAME=value` is a word of its own too.
 */
export function shellWords(text: string, platform: NodeJS.Platform = process.platform): string[] {
  const words: string[] = [];
  let word = "", quote: string | null = null, any = false;
  const end = () => { if (any) { words.push(word); const eq = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/s.exec(word); if (eq) words.push(eq[1]!); } word = ""; any = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && platform !== "win32" && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; any = true; continue; }
    if (char === "\\" && platform !== "win32" && index + 1 < text.length) { word += text[++index]; any = true; continue; }
    if (/[\s;|&<>()]/.test(char)) { end(); continue; }
    word += char; any = true;
  }
  end();
  return words;
}

/** Every word in a piece of text that could name a place. */
export function placeWords(text: string, platform: NodeJS.Platform = process.platform): string[] {
  return shellWords(text, platform).flatMap((word) => word.split(",")).map((word) => expandVariables(word))
    .filter((word) => /[\\/*?]|^\.\.?$|\.sqlite|locker\.key|gateway/i.test(word));
}

/* ---------- deciding ---------- */

/** Commands that remove, move or change a whole folder, so naming a parent of a protected place counts. */
const sweeping = /\b(rm|rmdir|del|erase|rd|mv|move|ren|rename|chmod|chown|chflags|attrib|icacls|takeown|rsync|robocopy|find|Remove-Item|Move-Item|Rename-Item|Set-Acl|shred|truncate|dd|ln|mklink|tar|unzip|ditto|git\s+clean)\b/i;

const wordEdge = /[\s"'`=:;|&<>(),]/;
/**
 * The plain text search: does the command name this place anywhere, once quotes, escapes and
 * variables are taken away? A place counts when it stands as a whole word or as the start of a path
 * inside it; a folder above a place counts only as a whole word, and only for a sweeping command.
 */
function namesPlace(text: string, place: string, platform: NodeJS.Platform, whole: boolean): boolean {
  const hay = canonical(text, platform), needle = canonical(place, platform).replace(/[\\/]+$/, "");
  if (!needle) return false;
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : hay[at - 1]!, after = hay[at + needle.length] ?? "";
    if (before && !wordEdge.test(before)) continue;
    if (!after || wordEdge.test(after) || (!whole && separator.test(after))) return true;
  }
  return false;
}

/** Every folder above a place, nearest first, down to (and including) the top of the disk. */
function above(place: string, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  for (let folder = pathsOf(platform).dirname(place); !out.includes(folder); folder = pathsOf(platform).dirname(folder)) out.push(folder);
  return out;
}

function globRegex(pattern: string, platform: NodeJS.Platform): RegExp {
  const one = platform === "win32" ? "[^\\\\/]" : "[^/]";
  const text = canonical(pattern, platform);
  let source = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const close = char === "[" ? text.indexOf("]", index + 1) : -1;
    if (char === "*") source += `${one}*`;
    else if (char === "?") source += one;
    else if (close > index) { source += one; index = close; } // a set of letters: any one letter, to be safe
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, folds(platform) ? "i" : "");
}

/** A wildcard path: refused when it could match a protected place, or (sweeping) a folder above one. */
function globHit(pattern: string, places: string[], platform: NodeJS.Platform, sweep: boolean): string | null {
  const first = pattern.search(/[*?[]/);
  const fixed = pathsOf(platform).dirname(pattern.slice(0, first) + "x");
  const regex = globRegex(pattern, platform);
  for (const place of places) {
    if (inside(fixed, place, platform)) return place;
    if (regex.test(canonical(place, platform))) return place;
    if (sweep && above(place, platform).some((folder) => regex.test(canonical(folder, platform)))) return place;
  }
  return null;
}

/** The path as the file system resolves it: the nearest folder that exists, followed through links. */
function realOf(path: string): string | null {
  const rest: string[] = [];
  for (let head = path, depth = 0; depth < 64; depth++) {
    try {
      const real = realpathSync.native(head);
      const whole = rest.length ? join(real, ...[...rest].reverse()) : real;
      return whole === path ? null : whole;
    } catch {
      const parent = dirname(head);
      if (parent === head) return null;
      rest.push(basename(head));
      head = parent;
    }
  }
  return null;
}

/** A second name (hard link) for a protected file. */
function sameFile(path: string, places: string[]): string | null {
  try {
    const found = lstatSync(path);
    if (!found.isFile() || found.nlink < 2) return null;
    return places.find((place) => {
      try { const other = statSync(place); return other.ino === found.ino && other.dev === found.dev; } catch { return false; }
    }) ?? null;
  } catch { return null; }
}

function wordHit(word: string, places: string[], areas: ProtectedAreas, base: string, sweep: boolean): string | null {
  const platform = areas.platform, paths = pathsOf(platform);
  const full = paths.isAbsolute(word) ? paths.normalize(word) : paths.join(base, word);
  if (/[*?[]/.test(word)) return globHit(full, places, platform, sweep);
  const local = platform === process.platform;
  const real = local ? realOf(full) : null;
  for (const spelling of real ? [full, real] : [full]) {
    const hit = places.find((place) => inside(spelling, place, platform) || (sweep && inside(place, spelling, platform)));
    if (hit) return hit;
  }
  return local ? sameFile(real ?? full, [...places, ...areas.noRead]) : null;
}

/** The folders a command moves into (`cd`, `pushd`, `Set-Location`) before it acts. */
function movesInto(words: string[], base: string, platform: NodeJS.Platform): string[] {
  const bases = [base];
  for (let index = 0; index < words.length - 1; index++) {
    if (!/^(cd|pushd|chdir|Set-Location|sl)$/i.test(words[index]!)) continue;
    const next = words.slice(index + 1).find((word) => !word.startsWith("-"));
    if (!next) continue;
    const target = expandVariables(next);
    const from = bases.at(-1)!;
    bases.push(pathsOf(platform).isAbsolute(target) ? pathsOf(platform).normalize(target) : pathsOf(platform).join(from, target));
  }
  return bases;
}

/* ---------- commands aimed at Branch's own service or process ---------- */

const serviceTool = /\b(launchctl|systemctl|sc(?:\.exe)?|schtasks(?:\.exe)?|Stop-Service|Remove-Service|Set-Service|Stop-ScheduledTask|Disable-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask)\b/i;
const serviceVerb = /(\b|\/)(bootout|unload|remove|kill|disable|stop|kickstart|restart|mask|delete|config|end|change|reload|Stop-Service|Remove-Service|Set-Service|Stop-ScheduledTask|Disable-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask)\b/i;
const namesBranch = /branch[\s_-]*agent|keepoak|\bcli\.js\b/i;
const selfService = [
  new RegExp(`\\b${launchdLabel.replace(/\./g, "\\.")}\\b`, "i"),
  new RegExp(`\\b${systemdUnitName.replace(/\.service$/, "").replace(/-/g, "[-_]")}(\\.service)?\\b`, "i"),
  /\b(cli\.js|branch)\s+(daemon|update|gateway)\b/i,
  /\b(pkill|killall|taskkill(\.exe)?|Stop-Process|spps)\b.*\b(branch|cli\.js|electron|node(\.exe)?)\b/i,
  /\bkill\b.*\b(pgrep|pidof)\b.*\b(branch|cli\.js|electron|node)\b/i,
  /\bsystemctl\b.*--user\b.*\b(exit|isolate|halt|kill)\b/i,
  /\bloginctl\s+(terminate|kill)-(user|session)\b/i,
  /\blaunchctl\s+(bootout|kill\s+\S+)\s+(gui|user|login|system)\/\d*\s*($|;)/i,
  /\bosascript\b.*\bquit\b.*branch/i,
];

/** The signal flags of `kill` are skipped; what is left, in each separate command, are the processes it is aimed at. */
function killsSelf(text: string, areas: ProtectedAreas): boolean {
  return text.split(/[;|&\n]+/).some((part) => {
    const kill = /\b(kill|taskkill(?:\.exe)?)\b(.*)/i.exec(part);
    if (!kill) return false;
    const words = (kill[2] ?? "").split(/\s+/).filter(Boolean);
    let index = 0;
    if (/^-(s|n)$/i.test(words[0] ?? "")) index = 2;
    else if (/^-([A-Za-z]+|\d+)$/.test(words[0] ?? "")) index = 1;
    return words.slice(index).some((word) => /^(-\d+|0)$/.test(word) || areas.selfPids.includes(Number(word)));
  });
}

function stopsBranch(text: string, areas: ProtectedAreas): boolean {
  if (selfService.some((pattern) => pattern.test(text)) || killsSelf(text, areas)) return true;
  if (serviceTool.test(text) && serviceVerb.test(text) && (namesBranch.test(text) || unresolved(text))) return true;
  const port = process.env.BRANCH_PORT ?? "3210";
  return /\b(lsof|fuser|netstat|ss|Get-NetTCPConnection)\b/i.test(text) && /\b(kill|Stop-Process|taskkill)\b|\s-k\b/i.test(text)
    && new RegExp(`\\b${port.replace(/\D/g, "")}\\b`).test(text);
}

/* ---------- the check ---------- */

/** The folder a command says it runs in, when it says one. */
export function cwdOf(args: unknown): { cwd?: string } {
  const cwd = (args as { cwd?: unknown } | null)?.cwd;
  return typeof cwd === "string" && cwd ? { cwd } : {};
}

export interface ProtectedCall {
  tool: string; readOnly: boolean; args: unknown; target: string; cwd?: string;
  /** The folder relative paths are read from, when it is not the areas' workspace (a per-task workspace). */
  workspace?: string;
}

/** The texts a call carries, with the program it runs left out: running a program is not changing it. */
function textsOf(call: ProtectedCall, every: boolean): string[] {
  const found: string[] = [call.target];
  strings(call.args, every, found);
  const executable = (call.args as { executable?: unknown } | null)?.executable;
  return found.filter((text) => text && text.length <= 65536 && text !== executable)
    .map((text) => (typeof executable === "string" && text.startsWith(`${executable} `) ? text.slice(executable.length + 1) : text));
}

/** The whole command, program included, read as a shell would. */
function commandText(call: ProtectedCall, platform: NodeJS.Platform): string {
  const args = (call.args ?? {}) as { executable?: unknown; args?: unknown };
  const whole = typeof args.executable === "string" ? [args.executable, ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(" ") : "";
  const found: string[] = [call.target, whole];
  strings(call.args, false, found);
  return found.filter(Boolean).map((text) => expandVariables(shellWords(text, platform).join(" "))).join(" ; ");
}

/** Refused when any text names a protected place outright, once quotes, escapes and variables are gone. */
function namedOutright(call: ProtectedCall, places: string[], platform: NodeJS.Platform): string | null {
  const texts = textsOf(call, !call.readOnly);
  const spellings = texts.flatMap((text) => [expandVariables(text), expandVariables(shellWords(text, platform).join(" "))]);
  return places.find((place) => spellings.some((text) => namesPlace(text, place, platform, false))) ?? null;
}

/** Refused when a word of a place-carrying argument lands on a protected place, from any folder the command moves into. */
function namedByWord(call: ProtectedCall, places: string[], areas: ProtectedAreas, base: string, sweep: boolean): string | typeof unsure | null {
  const platform = areas.platform;
  for (const text of textsOf(call, false)) {
    const words = shellWords(text, platform);
    const bases = movesInto(words, base, platform);
    if (sweep && words.some((word) => unresolved(expandVariables(word)))) return unsure;
    if (sweep && /\bgit\s+clean\b/i.test(text)) {
      const under = places.find((place) => bases.some((folder) => inside(place, folder, platform)));
      if (under) return under;
    }
    for (const word of [text, ...placeWords(text, platform)]) {
      const spelled = expandVariables(word);
      if (spelled.length > 4096 || unresolved(spelled)) continue;
      for (const folder of bases) {
        const hit = wordHit(spelled, places, areas, folder, sweep);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Why this call may not happen, in one sentence, or null. A call that only looks is refused only for
 * the database and key files; anything that can change something is refused for every protected
 * place and for commands aimed at Branch's own service or process. When a command removes or moves
 * something it names only through a variable, it is refused too, because it cannot be told apart.
 */
export function protectedTarget(call: ProtectedCall, areas: ProtectedAreas): string | null {
  const platform = areas.platform, paths = pathsOf(platform);
  const home = call.workspace ?? areas.workspace;
  const base = call.cwd && paths.isAbsolute(call.cwd) ? call.cwd : paths.join(home, call.cwd ?? ".");
  const places = call.readOnly ? areas.noRead : areas.noChange;
  const command = commandText(call, platform);
  if (!call.readOnly && stopsBranch(command, areas)) return refusal("stop, reinstall or update Branch itself");
  const sweep = !call.readOnly && sweeping.test(command);
  const verb = call.readOnly ? "read" : "change";
  const outright = namedOutright(call, places, platform);
  if (outright) return refusal(`${verb} ${describe(outright)}`);
  const byWord = namedByWord(call, places, areas, base, sweep);
  if (byWord === unsure) return unsure;
  return byWord ? refusal(`${verb} ${describe(byWord)}`) : null;
}

function describe(place: string): string {
  const name = place.split(/[\\/]/).pop() ?? place;
  if (/sqlite/.test(name)) return "Branch's saved-work database";
  if (/key|token|auth/.test(name)) return "Branch's own keys";
  if (/gateway|running|first-start/.test(name)) return "the gateway's settings";
  if (/update/.test(name)) return "the updater";
  if (/plist$|\.service$/.test(name)) return "the way Branch starts when you sign in";
  return `Branch's own files (${place})`;
}

const refusal = (what: string): string =>
  `This would ${what}. Branch never lets a task do that, whatever the rules or permissions say, so that it cannot break itself. If this really needs doing, do it yourself from Settings.`;
const unsure =
  "This command removes or moves something it names only through a variable, so Branch cannot tell whether that is its own program, settings or saved work. Write the folder out in full and try again.";
