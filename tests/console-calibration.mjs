/*
 * The control for the Windows "no window appeared" tests: proof that this machine shows the test a console at
 * all, so a zero after it means something.
 *
 * Only the console this control started counts: its own process, or a console host whose parent is that
 * process. A window another program opens meanwhile is someone else's. It neither passes the control nor is
 * ever closed by it. The control closes only its own process tree, and does so even when a look fails.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const system32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether any of the new windows belongs to the owned process: it, or a console host it started. */
export function ownedWindowSeen(fresh, owned) {
  return fresh.some((window) => window.id === owned || window.parent === owned);
}

/** Every process that owns a top-level window now, with its name and the process that started it. */
export function windowsNow() {
  const ask = "$w = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id });"
    + " Get-CimInstance Win32_Process | Where-Object { $w -contains $_.ProcessId }"
    + " | Select-Object -Property ProcessId,Name,ParentProcessId | ConvertTo-Json -Compress";
  const printed = execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", ask], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 22 }).trim();
  const rows = printed ? JSON.parse(printed) : [];
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ id: row.ProcessId, name: String(row.Name), parent: row.ParentProcessId }));
}

/** A plain console that is meant to be seen, up to 30 seconds, started by this test. */
export function startVisibleConsole() {
  const child = spawn(join(system32, "cmd.exe"), ["/d", "/c", join(system32, "ping.exe"), "-n", "31", "127.0.0.1"],
    { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

/** Closes the owned process and everything it started, and nothing else. */
export function closeOwned(pid) {
  spawnSync(join(system32, "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
}

/**
 * Starts the owned console and looks until one of its windows is seen or the time is up. Returns whether it
 * was seen and the names of other new windows (for the report). `look`, `start`, `close` and `wait` are the
 * real ones unless a test passes stand-ins.
 */
export async function calibrate({ look = windowsNow, start = startVisibleConsole, close = closeOwned, wait = pause, watchMs = 30000 } = {}) {
  const before = new Set(look().map((window) => window.id));
  const owned = start();
  let fresh = [];
  try {
    for (let waited = 0; waited < watchMs; waited += 400) {
      await wait(400);
      fresh = look().filter((window) => !before.has(window.id));
      if (ownedWindowSeen(fresh, owned)) return { seen: true, others: [] };
    }
    return { seen: false, others: fresh.filter((window) => window.parent !== owned).map((window) => window.name) };
  } finally {
    close(owned);
  }
}
