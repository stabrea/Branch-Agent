import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { launchHandOver } from "./hand-over.js";
import { join } from "node:path";
import { Updater } from "./updater.js";
import { appEntryName, releaseAssetName } from "./release-assets.js";
import { installedAppRoot } from "./install-root.js";

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

/**
 * What this launch can do before an update: take the safety copy, and close the engine that keeps
 * working with the window closed. Both are supplied whether this window runs the engine itself or
 * joined one that was already working, so an update behaves the same either way.
 */
export interface UpdateHooks {
  backup: () => Promise<void>;
  stopDaemon?: () => Promise<number | null>;
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
  });
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Desktop update access denied");
  };
  ipcMain.handle("branch:update-status", (event) => { authorized(event); return updater.status; });
  ipcMain.handle("branch:update-check", (event) => { authorized(event); return updater.check(); });
  ipcMain.handle("branch:update-install", async (event) => {
    authorized(event);
    if (updater.inProgress) return updater.status;
    const { script } = await updater.install();
    // The background engine is already closed by this point, so say so if the hand-over cannot start.
    await launchHandOver(script, process.pid).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(hooks?.stopDaemon
        ? `The update could not be started: ${why}. Branch has stopped working in the background; it starts again next time you sign in to ${signInPlace}.`
        : `The update could not be started: ${why}.`);
    });
    const status = updater.applying();
    setTimeout(requestQuit, 750);
    // If a polite quit gets stuck, leave anyway: the hand-over script is already waiting for this process to end.
    setTimeout(() => app.exit(0), 20000).unref();
    return status;
  });
  ipcMain.handle("branch:open-external", async (event, url: unknown) => {
    authorized(event);
    if (typeof url !== "string" || !externalAllowed.some((prefix) => url.startsWith(prefix)))
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
