import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function desktopOptions() {
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "Temp", "Codex-session-files")
      : tmpdir();
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, "branch-agent-desktop-"));
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "HOME",
      "DISPLAY",
      "XAUTHORITY",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const launch = process.env.BRANCH_PACKAGED_EXECUTABLE
    ? { executablePath: process.env.BRANCH_PACKAGED_EXECUTABLE, args: [] }
    : { args: [root] };
  return {
    home,
    options: {
      ...launch,
      timeout: 120000,
      chromiumSandbox: true,
      env: {
        ...env,
        BRANCH_PROVIDER: "demo",
        BRANCH_DESKTOP_HOME: home,
        BRANCH_DATA_DIR: join(home, "state"),
        BRANCH_WORKSPACE: join(home, "workspace"),
      },
    },
  };
}


/**
 * Waits for the window to say it is connected. Starting the whole app (its database, its server and
 * the page) is quick on a desktop, but a shared Windows build machine running two other test files
 * at once has taken well over thirty seconds for the same thing, so the allowance is for that.
 */
export const STARTUP_MS = 120000;
export const connected = (page) => page.getByText("Connected", { exact: true }).waitFor({ timeout: STARTUP_MS });
