import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The part of Branch the assistant can never change: the program itself, the gateway's settings,
 * the saved-work database and the updater. This is a hard refusal, checked before any rule, any
 * standing yes, any hook, Lockdown or any switch, so nothing the owner or the assistant sets can
 * lift it. It is what stops Branch breaking itself the way OpenClaw does when its agent edits its
 * own gateway. See docs/never-break.md, threat 1.
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

const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const fold = platform === "win32" || platform === "darwin";
  const a = fold ? child.toLowerCase() : child, b = fold ? parent.toLowerCase() : parent;
  if (a === b) return true;
  const rel = relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The folder the running program was loaded from: the package root holding `dist/`. */
export function programRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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

/**
 * Works out the protected places. When the workspace sits inside the program's folder (a developer
 * working on Branch itself) only the parts that make up the running program are protected, so the
 * workspace stays usable; the data folder is treated the same way.
 */
export function protectedAreas(input: AreaInput): ProtectedAreas {
  const platform = input.platform ?? process.platform;
  const workspace = resolve(input.workspace), dataDir = resolve(input.dataDir);
  const noChange: string[] = [];
  for (const root of [input.installRoot ?? programRoot(), process.env.BRANCH_INSTALL_ROOT].filter(Boolean) as string[]) {
    const folder = resolve(root);
    if (inside(workspace, folder, platform))
      noChange.push(...["dist", "node_modules", "package.json", "resources", "app.asar"].map((part) => join(folder, part)));
    else noChange.push(folder);
  }
  const dataFiles = [...guardedDataFiles, ...gatewayDataFiles].map((name) => join(dataDir, name));
  if (inside(workspace, dataDir, platform)) noChange.push(...dataFiles);
  else noChange.push(dataDir);
  noChange.push(...(input.extra ?? []).map((path) => resolve(path)));
  return {
    noChange, noRead: guardedDataFiles.map((name) => join(dataDir, name)),
    selfPids: input.selfPids ?? [process.pid, process.ppid].filter((pid) => pid > 1),
    platform, workspace,
  };
}

/** Argument names that carry a place or a command. */
const placeKeys = /^(path|paths|file|files|target|destination|dest|source|src|from|to|cwd|dir|directory|folder|executable|command|args|argv|input|script|code|program|line)$/i;

function strings(value: unknown, keyed: boolean, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 400) return;
  if (typeof value === "string") { if (keyed) out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) strings(item, keyed, out, depth + 1); return; }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) strings(item, keyed || placeKeys.test(key), out, depth + 1);
}

const expandHome = (word: string): string => {
  const home = homedir();
  return word.replace(/^~(?=$|[\\/])/, home).replace(/\$\{?HOME\}?/g, home).replace(/%USERPROFILE%/gi, home)
    .replace(/%(LOCALAPPDATA|APPDATA)%/gi, (_, name: string) => process.env[name.toUpperCase()] ?? `%${name}%`);
};

/** Every word in a piece of text that could name a place. */
export function placeWords(text: string): string[] {
  return text.split(/[\s"'`;|&<>()=,]+/).map(expandHome).filter((word) => /[\\/]|^\.\.?$|\.sqlite|locker\.key|gateway/i.test(word));
}

/** Commands that remove, move or change a whole folder, so naming a parent of a protected place counts. */
const sweeping = /\b(rm|rmdir|del|erase|rd|mv|move|chmod|chown|chflags|attrib|icacls|rsync|find|Remove-Item|Move-Item|shred|truncate|dd|git\s+clean)\b/i;

function hits(word: string, places: string[], areas: ProtectedAreas, base: string, parents: boolean): string | null {
  const full = normalize(isAbsolute(word) ? word : resolve(base, word));
  return places.find((place) => inside(full, place, areas.platform) || (parents && inside(place, full, areas.platform))) ?? null;
}

/** Commands that would stop, reinstall or update Branch itself. */
const selfService = [
  /\blaunchctl\b.*\bcom\.keepoak\.branch-agent\b/i,
  /\bsystemctl\b.*\bbranch-agent(\.service)?\b/i,
  /\bschtasks(\.exe)?\b.*Branch ?Agent/i,
  /\b(cli\.js|branch)\s+(daemon|update|gateway)\b/i,
  /\b(pkill|killall)\b.*\b(branch|cli\.js|electron)\b/i,
  /\btaskkill(\.exe)?\b.*\b(branch|electron)\b/i,
];

function killsSelf(text: string, areas: ProtectedAreas): boolean {
  const kill = /\b(kill|taskkill(?:\.exe)?)\b(.*)/i.exec(text);
  if (!kill) return false;
  const numbers = (kill[2] ?? "").match(/\b\d+\b/g) ?? [];
  return numbers.some((n) => areas.selfPids.includes(Number(n)));
}

/** The folder a command says it runs in, when it says one. */
export function cwdOf(args: unknown): { cwd?: string } {
  const cwd = (args as { cwd?: unknown } | null)?.cwd;
  return typeof cwd === "string" && cwd ? { cwd } : {};
}

export interface ProtectedCall { tool: string; readOnly: boolean; args: unknown; target: string; cwd?: string }

/**
 * Why this call may not happen, in one sentence, or null. A call that only looks is refused only for
 * the database and key files; anything that can change something is refused for every protected
 * place and for commands aimed at Branch's own service or process.
 */
export function protectedTarget(call: ProtectedCall, areas: ProtectedAreas): string | null {
  const found: string[] = [call.target];
  strings(call.args, false, found);
  const base = call.cwd && isAbsolute(call.cwd) ? call.cwd : resolve(areas.workspace, call.cwd ?? ".");
  const places = call.readOnly ? areas.noRead : areas.noChange;
  const joined = found.join(" ");
  if (!call.readOnly && (selfService.some((pattern) => pattern.test(joined)) || killsSelf(joined, areas)))
    return refusal("stop, reinstall or update Branch itself");
  // Running a program is not changing it: the program named as the thing to run is left alone.
  const executable = (call.args as { executable?: unknown } | null)?.executable;
  const parents = !call.readOnly && sweeping.test(joined);
  for (const text of found) {
    if (!text) continue;
    const whole = typeof executable === "string" && text.startsWith(`${executable} `) ? [] : [text];
    for (const word of [...whole, ...placeWords(text)]) {
      if (word.length > 4096 || word === executable) continue;
      const hit = hits(expandHome(word), places, areas, base, parents);
      if (hit) return refusal(`${call.readOnly ? "read" : "change"} ${describe(hit)}`);
    }
  }
  return null;
}

function describe(place: string): string {
  const name = place.split(sep).pop() ?? place;
  if (/sqlite/.test(name)) return "Branch's saved-work database";
  if (/key|token|auth/.test(name)) return "Branch's own keys";
  if (/gateway|running|first-start/.test(name)) return "the gateway's settings";
  if (/update/.test(name)) return "the updater";
  return `Branch's own files (${place})`;
}

const refusal = (what: string): string =>
  `This would ${what}. Branch never lets a task do that, whatever the rules or permissions say, so that it cannot break itself. If this really needs doing, do it yourself from Settings.`;
