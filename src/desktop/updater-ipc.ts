import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { Updater } from "./updater.js";

export const updateSource = {
  repo: "stabrea/Branch-Agent",
  assetName: "Branch-Agent-windows-x64.zip",
  executableName: "Branch Agent.exe",
} as const;
const externalAllowed = ["https://auth.openai.com/", "https://github.com/stabrea/Branch-Agent"];

export function registerUpdaterIpc(
  window: BrowserWindow, origin: string, version: string, requestQuit: () => void,
): Updater {
  const updater = new Updater({
    ...updateSource,
    currentVersion: version,
    installDir: app.isPackaged ? dirname(process.execPath) : null,
    scratchDir: join(app.getPath("temp"), "branch-agent-update"),
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
    const { script } = await updater.install();
    spawn("cmd.exe", ["/d", "/c", script, String(process.pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(requestQuit, 750);
    return updater.status;
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
