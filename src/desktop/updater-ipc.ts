import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { diagnose } from "../diagnostic-log.js"; // mac7/diagnostics
import { launchHandOver } from "./hand-over.js";
import { join } from "node:path";
import { Updater } from "./updater.js";
import { appEntryName, releaseAssetName } from "./release-assets.js";
import { installedAppRoot } from "./install-root.js";
import { macSettingsLinks } from "../os-permissions.js";

export const updateSource = {
  repo: "stabrea/Branch-Agent",
  assetName: "Branch-Agent-windows-x64.zip",
  executableName: "Branch Agent.exe",
} as const;

// mac1/service-update: the download, program and folder for this computer. On Windows these come
// out as the same literals as above.
const platformSource = {
  repo: updateSource.repo,
  assetName: releaseAssetName(process.platform, process.arch),
  executableName: appEntryName(process.platform),
};
const signInPlace = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "your Mac" : "this computer";
const externalAllowed = ["https://auth.openai.com/", "https://github.com/stabrea/Branch-Agent"];
// mac2/desktop-ui: the four System Settings pages the permissions card offers, matched exactly.
const settingsPages = new Set<string>(process.platform === "darwin" ? Object.values(macSettingsLinks) : []);

/**
 * What this launch can do before an update: take the safety copy, and close the engine that keeps
 * working with the window closed. Both are supplied whether this window runs the engine itself or
 * joined one that was already working, so an update behaves the same either way.
 */
export interface UpdateHooks {
  backup: () => Promise<void>;
  stopDaemon?: () => Promise<number | null>;
  /** mac3/never-break: the new version's check on a copy of the data (see src/never-break/canary.ts). */
  canary?: (stagedDir: string, version: string) => Promise<void>;
  /**
   * mac7/safe-rollback: writes down what this update is about to change, before the hand-over moves
   * a single file, so it can be undone afterwards. It throws when it cannot be written, and the
   * update stops there — an update nobody can undo is not one worth making.
   */
  record?: (stagedDir: string, version: string) => Promise<void>;
}

export function registerUpdaterIpc(
  window: BrowserWindow, origin: string, version: string, requestQuit: () => void,
  hooks?: UpdateHooks,
): Updater {
  const updater = new Updater({
    ...(process.platform === "win32" ? updateSource : platformSource),
    currentVersion: version,
    installDir: installedAppRoot(app.isPackaged, process.platform, process.execPath),
    packaged: app.isPackaged,
    scratchDir: join(app.getPath("temp"), "branch-agent-update"),
    ...(hooks ? { backup: hooks.backup } : {}),
    ...(hooks?.stopDaemon ? { stopDaemon: hooks.stopDaemon } : {}),
    ...(hooks?.canary ? { canary: hooks.canary } : {}),
  });
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Desktop update access denied");
  };
  ipcMain.handle("branch:update-status", (event) => { authorized(event); return updater.status; });
  ipcMain.handle("branch:update-check", (event) => {
    authorized(event);
    // mac7/diagnostics: each check, and any failure, is a line in the activity log.
    return updater.check().then((status) => {
      diagnose("updater", "info", "Checked for updates", { fields: { current: version, latest: updater.status.release?.latestVersion ?? "" } });
      return status;
    }, (error: unknown) => {
      diagnose("updater", "warn", `Checking for updates failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
  });
  ipcMain.handle("branch:update-install", async (event) => {
    authorized(event);
    if (updater.inProgress) return updater.status;
    diagnose("updater", "info", "Installing an update", { fields: { from: version, to: updater.status.release?.latestVersion ?? "" } });
    // CBQ-001: the claim is held past install() until the hand-over is running, so a second press
    // meanwhile gets the status back instead of starting a second update (src/desktop/updater.ts, install).
    const { script, stagedDir } = await updater.install({ hold: true }).catch((error: unknown) => {
      diagnose("updater", "error", `The update could not be installed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    try {
      // mac7/safe-rollback: recorded here, marked as landed by the next start (`settleActivation`),
      // because this process quits into the hand-over and never sees how it went.
      if (hooks?.record) await hooks.record(stagedDir, updater.status.release?.latestVersion ?? "");
      // The background engine is already closed by this point, so say so if the hand-over cannot start.
      await launchHandOver(script, process.pid).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        throw new Error(hooks?.stopDaemon
          ? `The update could not be started: ${why}. Branch has stopped working in the background; it starts again next time you sign in to ${signInPlace}.`
          : `The update could not be started: ${why}.`);
      });
    } catch (error) {
      updater.release();
      throw error;
    }
    const status = updater.applying();
    setTimeout(requestQuit, 750);
    // If a polite quit gets stuck, leave anyway: the hand-over script is already waiting for this process to end.
    setTimeout(() => app.exit(0), 20000).unref();
    return status;
  });
  ipcMain.handle("branch:open-external", async (event, url: unknown) => {
    authorized(event);
    if (typeof url !== "string" || !(externalAllowed.some((prefix) => url.startsWith(prefix)) || settingsPages.has(url)))
      throw new Error("That link cannot be opened from here");
    await shell.openExternal(url);
    return true;
  });
  window.on("closed", () => {
    for (const channel of ["branch:update-status", "branch:update-check", "branch:update-install", "branch:open-external"])
      ipcMain.removeHandler(channel);
  });
  return updater;
}
