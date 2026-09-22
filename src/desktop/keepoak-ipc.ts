import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { KeepOakView, keepOakMayUse, keepOakPartition, type ViewDeps } from "./keepoak-view.js";

/** The two channels the KeepOak card and the rail entry use (issue #105). */
export const keepOakOpenChannel = "branch:keepoak-open";
export const keepOakDisconnectChannel = "branch:keepoak-disconnect";

/**
 * Only Branch's own window, at Branch's own address, may open or disconnect KeepOak, and opening
 * asks Branch whether the owner switched KeepOak on (src/keepoak.ts) rather than taking the page's
 * word for it. `ipc` is Electron's ipcMain, handed in so this can be checked without Electron.
 */
export function registerKeepOakIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  window: Pick<BrowserWindow, "webContents" | "on">,
  origin: string,
  view: Pick<KeepOakView, "open" | "disconnect" | "close">,
  switchedOn: () => Promise<boolean>,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("KeepOak access denied");
  };
  ipc.handle(keepOakOpenChannel, async (event) => {
    authorized(event);
    if (!(await switchedOn().catch(() => false))) throw new Error("KeepOak is switched off. Switch it on in Settings › Accounts.");
    await view.open();
    return true;
  });
  ipc.handle(keepOakDisconnectChannel, async (event) => {
    authorized(event);
    await view.disconnect();
    return true;
  });
  window.on("closed", () => {
    ipc.removeHandler(keepOakOpenChannel);
    ipc.removeHandler(keepOakDisconnectChannel);
    view.close();
  });
}

/** Asks Branch's own server whether KeepOak is switched on, with this window's key. */
export const keepOakSwitchedOn = (url: string, token: string) => async (): Promise<boolean> => {
  const response = await fetch(`${url}/api/keepoak`, { headers: { authorization: `Bearer ${token}` } });
  return response.ok && (await response.json() as { on?: unknown }).on === true;
};

/** The Electron pieces the view needs, handed in so a test can prove what they are asked to do. */
export interface KeepOakElectron {
  BrowserWindow: new (options: object) => unknown;
  session: { fromPartition(partition: string): KeepOakSession };
  shell: { openExternal(url: string): Promise<void> };
  dialog: { showMessageBox(options: { type: string; buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string }): Promise<{ response: number }> };
}
export interface KeepOakSession {
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
  on(event: "will-download", listener: (event: { preventDefault(): void }) => void): void;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

/** The real pieces: a window of its own, the person's browser (once they agree), and the KeepOak session. */
export async function electronKeepOakView(electron?: KeepOakElectron): Promise<KeepOakView> {
  const { BrowserWindow: Window, session, shell, dialog } = electron ?? (await import("electron") as unknown as KeepOakElectron);
  const kept = session.fromPartition(keepOakPartition);
  // Nothing the page asks of this computer is granted, and nothing is downloaded.
  kept.setPermissionRequestHandler((_contents, permission, callback) => callback(keepOakMayUse(permission)));
  kept.setPermissionCheckHandler((_contents, permission) => keepOakMayUse(permission));
  kept.on("will-download", (event) => event.preventDefault());
  const deps: ViewDeps = {
    makeWindow: (options) => new Window({ ...options, webPreferences: { ...options.webPreferences } }) as ReturnType<ViewDeps["makeWindow"]>,
    openOutside: (url) => shell.openExternal(url),
    confirmOutside: async (url) => (await dialog.showMessageBox({
      type: "question", buttons: ["Open in my browser", "Stay here"], defaultId: 1, cancelId: 1,
      message: "Open this page in your own browser?", detail: new URL(url).origin,
    })).response === 0,
    clearSession: async () => {
      await kept.clearStorageData();
      await kept.clearCache();
      await kept.clearAuthCache();
    },
  };
  return new KeepOakView(deps);
}
