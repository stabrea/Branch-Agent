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
      // Chromium picks the Linux keyring by desktop; without this it always falls back to plain text.
      "XDG_CURRENT_DESKTOP",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const launch = process.env.BRANCH_PACKAGED_EXECUTABLE
    ? { executablePath: process.env.BRANCH_PACKAGED_EXECUTABLE, args: [] }
    : { args: [root] };
  return {
    home,
    options: {
      ...launch,
      timeout: 30000,
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

