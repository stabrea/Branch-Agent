import { runTool, systemTool, type RunTool } from "./windows.js";
import { launchctl, launchdDomain, launchdLabel } from "./launchd.js";
import { systemctl, systemdUnitName } from "./systemd.js";
import { daemonTaskName } from "./daemon.js";
import { runningNow } from "./quit.js";
import type { RunningInstance } from "./running.js";

/**
 * After an update or a rollback, a Branch that was running as a background service is started again
 * through that service's own manager. Closing it for the swap is a polite exit, and neither launchd
 * (`KeepAlive{SuccessfulExit:false}`) nor systemd (`Restart=on-failure`) restarts a polite exit, so
 * without this the service stayed down until the next sign-in, and the watch that rolls a bad version
 * back never ran.
 */
export function serviceRestartCommand(platform: NodeJS.Platform, uid = process.getuid?.() ?? 501): [string, string[]] {
  if (platform === "darwin") return [launchctl, ["kickstart", "-k", `${launchdDomain(uid)}/${launchdLabel}`]];
  if (platform === "linux") return [systemctl, ["--user", "restart", systemdUnitName]];
  if (platform === "win32") return [systemTool("schtasks.exe"), ["/Run", "/TN", daemonTaskName]];
  throw new Error("Starting the background service again is not available on this kind of computer.");
}

export async function restartService(platform: NodeJS.Platform = process.platform, run: RunTool = runTool): Promise<void> {
  const [tool, args] = serviceRestartCommand(platform);
  await run(tool, args);
}

export interface ReturnDeps {
  running?: (dataDir: string) => Promise<RunningInstance | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

/**
 * Waits for a Branch other than the one that was closed (`before`) to say it is running. Answers with
 * the new process, or null when none came up in time.
 */
export async function waitForReturn(dataDir: string, before: number | null, deps: ReturnDeps = {}): Promise<RunningInstance | null> {
  const running = deps.running ?? ((dir: string) => runningNow(dir));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? 60000);
  for (;;) {
    const note = await running(dataDir).catch(() => null);
    if (note && note.pid !== before) return note;
    if (now() >= deadline) return null;
    await sleep(500);
  }
}
