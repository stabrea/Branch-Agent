import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Starts the update hand-over script so that it outlives the app and stays invisible. A child started
 * with spawn dies with the app when the app runs inside a Windows job (launchers, test harnesses and
 * some shells put it in one), so the Task Scheduler runs it instead: a scheduled task is created, run at
 * once and deleted again; deleting the task does not stop the command it started. The task runs a tiny
 * Windows Script Host launcher so that no console window flashes while files are swapped. Spawn is the
 * fallback when the scheduler is unavailable.
 */
export type Exec = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }, callback: (error: Error | null) => void) => unknown;
export type Spawn = (command: string, args: string[], options: Record<string, unknown>) => { unref(): void };
export type Write = (file: string, content: string) => void;

/** Windows Script Host text that runs any command with window style 0 (hidden) and does not wait. */
export function hiddenRunner(command: string): string {
  return `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}
/** The launcher text: runs the script through cmd with window style 0 (hidden) and does not wait. */
export function hiddenLauncher(script: string, pid: number): string {
  return hiddenRunner(`cmd.exe /d /c ""${script}" ${pid}"`);
}

export async function launchHandOver(script: string, pid: number, deps: { exec?: Exec; spawn?: Spawn; write?: Write; systemRoot?: string; platform?: NodeJS.Platform } = {}): Promise<"task" | "spawn"> {
  if ((deps.platform ?? process.platform) !== "win32") return launchPosixHandOver(script, pid, deps.spawn);
  const exec = deps.exec ?? (execFile as unknown as Exec), start = deps.spawn ?? (spawn as unknown as Spawn);
  const write = deps.write ?? ((file: string, content: string) => writeFileSync(file, content, "utf8"));
  const root = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const schtasks = win32.join(root, "System32", "schtasks.exe"), wscript = win32.join(root, "System32", "wscript.exe");
  const name = `BranchAgentUpdate-${pid}`, launcher = `${script}.launch.vbs`;
  const run = (args: string[]) => new Promise<void>((resolve, reject) =>
    exec(schtasks, args, { windowsHide: true, timeout: 15000 }, (error) => (error ? reject(error) : resolve())));
  try {
    write(launcher, hiddenLauncher(script, pid));
    await run(["/Create", "/F", "/TN", name, "/SC", "ONCE", "/ST", "00:00", "/TR", `"${wscript}" //B //Nologo "${launcher}"`]);
    await run(["/Run", "/TN", name]);
    await run(["/Delete", "/F", "/TN", name]).catch(() => undefined);
    return "task";
  } catch {
    start("cmd.exe", ["/d", "/c", script, String(pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "spawn";
  }
}

// ------------------------------------------------------------------------------ macOS and Linux

/**
 * On macOS and Linux the hand-over is a small shell script started in its own session with nothing
 * attached, so it outlives the app and no terminal window appears.
 */
export function launchPosixHandOver(script: string, pid: number, spawner?: Spawn): "spawn" {
  const start = spawner ?? (spawn as unknown as Spawn);
  start("/bin/sh", [script, String(pid)], { detached: true, stdio: "ignore" }).unref();
  return "spawn";
}

export interface PosixHandOverPlan {
  platform: "darwin" | "linux";
  /** What is replaced: the `.app` bundle on macOS, the unpacked folder on Linux. */
  target: string;
  /** The new version, unpacked in the scratch folder. */
  staged: string;
  log: string;
  /** The program file inside the Linux folder. */
  executableName: string;
  /** The engine working in the background, waited for as well when there is one. */
  daemonPid: number | null;
}

/** Quotes one word for sh; nothing inside single quotes is interpreted. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Waits about a minute, then asks the process to stop, then ends it. */
const posixWait = [
  "wait_for() {",
  "  n=0",
  '  while kill -0 "$1" 2>/dev/null && [ "$n" -lt 60 ]; do n=$((n+1)); sleep 1; done',
  '  if kill -0 "$1" 2>/dev/null; then',
  '    log "$2 still open after $n waits; asking it to stop"',
  '    kill -TERM "$1" 2>/dev/null; n=0',
  '    while kill -0 "$1" 2>/dev/null && [ "$n" -lt 10 ]; do n=$((n+1)); sleep 1; done',
  '    if kill -0 "$1" 2>/dev/null; then log "$2 still open; ending it"; kill -KILL "$1" 2>/dev/null; sleep 1; fi',
  "  fi",
  '  log "$2 closed"',
  "}",
];

function posixLaunch(plan: PosixHandOverPlan, watch: boolean): string {
  if (plan.platform === "darwin") return `/usr/bin/open -n${watch ? " -W" : ""} "$TARGET" >/dev/null 2>&1 &`;
  return `"$TARGET"/${shellQuote(plan.executableName)} >/dev/null 2>&1 &`;
}

/**
 * The script text: wait for the app (and the background engine), copy the new version in beside the
 * old one, keep the old one as `<name>.previous`, swap, start the new version, and put the previous
 * one back if the new one does not stay up.
 */
export function posixHandOverScript(plan: PosixHandOverPlan): string {
  const q = shellQuote;
  return [
    "#!/bin/sh", 'PID="$1"',
    `TARGET=${q(plan.target)}`, `STAGED=${q(plan.staged)}`, `LOG=${q(plan.log)}`,
    'PREVIOUS="$TARGET.previous"', 'INCOMING="$TARGET.incoming"',
    'log() { printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >>"$LOG"; }',
    ...posixWait,
    'log "update started for pid $PID"',
    'wait_for "$PID" app',
    ...(plan.daemonPid ? [`wait_for ${plan.daemonPid} "background engine"`] : []),
    'log "copying new version beside the old one"',
    'rm -rf "$INCOMING"',
    'cp -Rp "$STAGED" "$INCOMING" || { log "copy failed; nothing was changed"; rm -rf "$INCOMING"; exit 1; }',
    'log "keeping previous version"', 'rm -rf "$PREVIOUS"',
    'if [ -e "$TARGET" ] && ! mv "$TARGET" "$PREVIOUS"; then log "old version could not be moved; nothing was changed"; rm -rf "$INCOMING"; exit 1; fi',
    'if ! mv "$INCOMING" "$TARGET"; then log "new version could not be moved in; restoring previous"; mv "$PREVIOUS" "$TARGET"; exit 1; fi',
    'if [ "$2" = stay ]; then exit 0; fi',
    'log "starting new version"', posixLaunch(plan, true), "STARTED=$!", "sleep 20",
    'if kill -0 "$STARTED" 2>/dev/null; then log "new version is running"; exit 0; fi',
    'log "new version did not start; restoring previous"',
    'rm -rf "$TARGET"', 'cp -Rp "$PREVIOUS" "$TARGET"', posixLaunch(plan, false), "exit 1", "",
  ].join("\n");
}
