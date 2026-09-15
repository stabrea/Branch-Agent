import { ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { DesktopSettings } from "./settings.js";

export async function loadDesktopSettings(path: string) {
  const settings = new DesktopSettings(path, {
    available: () => safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  await settings.load();
  return settings;
}

export function registerSettingsIpc(
  window: BrowserWindow, origin: string, settings: DesktopSettings,
  environmentOverride: boolean,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Desktop settings access denied");
  };
  ipcMain.handle("branch:model-settings", (event) => {
    authorized(event);
    return { ...settings.summary(), environmentOverride };
  });
  ipcMain.handle("branch:save-model-settings", async (event, input: unknown) => {
    authorized(event);
    if (environmentOverride)
      throw new Error("Model settings are controlled by the launch environment");
    return settings.save(input);
  });
  window.on("closed", () => {
    ipcMain.removeHandler("branch:model-settings");
    ipcMain.removeHandler("branch:save-model-settings");
  });
}
