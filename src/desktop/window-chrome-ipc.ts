import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, TitleBarOverlayOptions } from "electron";

/**
 * DG-176: the window has no operating-system title bar, as the approved sample has none; the app's own top row is
 * the top of the window. On Windows and Linux the minimise, maximise and close buttons are drawn over that row
 * (`titleBarOverlay`), on a clear ground, in a colour that reads on the theme's light or dark. Only this
 * window's own page, at Branch's own address, may say which, and it can say nothing but light or dark.
 */
export const windowLookChannel = "branch:window-look";
export const overlayHeight = 44;

export function overlayFor(dark: boolean): TitleBarOverlayOptions {
  return { color: "#00000000", symbolColor: dark ? "#e3eef3" : "#23343e", height: overlayHeight };
}

export function registerWindowLookIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  window: Pick<BrowserWindow, "webContents" | "on" | "setTitleBarOverlay">,
  origin: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Window look access denied");
  };
  ipc.handle(windowLookChannel, (event, dark: unknown) => {
    authorized(event);
    if (typeof dark !== "boolean") throw new Error("Light or dark only");
    if (platform !== "darwin") window.setTitleBarOverlay(overlayFor(dark));
    return true;
  });
  window.on("closed", () => ipc.removeHandler(windowLookChannel));
}
