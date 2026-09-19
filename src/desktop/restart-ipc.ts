import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

/** The one channel the window's "Restart" button uses when Branch stopped responding. */
export const restartChannel = "branch:restart";

/**
 * 0.18.1: "Branch stopped responding — Restart" starts Branch again for real. The whole app is
 * relaunched (`relaunch` is `app.relaunch(); app.quit()` in main.ts): quitting already closes the
 * local server within its bounded shutdown, and the new copy starts a fresh one, or joins the engine
 * working in the background when there is one. Only this window's own page, at Branch's own
 * address, may ask; nothing is taken from the page but the request itself.
 *
 * `ipc` is Electron's ipcMain, handed in so this can be checked without Electron.
 */
export function registerRestartIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  window: Pick<BrowserWindow, "webContents" | "on">,
  origin: string,
  relaunch: () => void,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Restart access denied");
  };
  let asked = false;
  ipc.handle(restartChannel, (event) => {
    authorized(event);
    // A second press while the first is quitting changes nothing.
    if (!asked) {
      asked = true;
      setTimeout(relaunch, 50);
    }
    return true;
  });
  window.on("closed", () => ipc.removeHandler(restartChannel));
}
