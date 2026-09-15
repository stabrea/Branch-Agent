import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type NativeImage,
} from "electron";
import { join } from "node:path";
import { createBranch } from "../index.js";
import { providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;

function branchIcon(): NativeImage {
  const size = 32,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const stem = x >= 14 && x <= 17 && y >= 12 && y <= 28;
      const leaf =
        ((x - 10) / 8) ** 2 + ((y - 10) / 5) ** 2 <= 1 ||
        ((x - 23) / 7) ** 2 + ((y - 17) / 5) ** 2 <= 1;
      if (stem || leaf) pixels.set([51, 112, 224, 255], (y * size + x) * 4);
    }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function protectWindow(
  win: BrowserWindow,
  origin: string,
  token: string,
): void {
  const session = win.webContents.session;
  session.on("will-download", (event) => event.preventDefault());
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).origin !== origin });
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (
      details.webContentsId === win.webContents.id &&
      new URL(details.url).origin === origin &&
      new URL(details.url).pathname.startsWith("/api/")
    )
      headers.Authorization = `Bearer ${token}`;
    callback({ requestHeaders: headers });
  });
}

async function createWindow(url: string, token: string): Promise<void> {
  window = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 760,
    minHeight: 540,
    title: "Branch Agent",
    backgroundColor: "#03140b",
    show: false,
    icon: branchIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:branch-agent",
    },
  });
  protectWindow(window, url, token);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(`${url}/?desktop=1`);
  tray = new Tray(branchIcon());
  tray.setToolTip("Branch Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Branch Agent",
        click: () => {
          window?.show();
          window?.focus();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => {
    window?.show();
    window?.focus();
  });
}

async function start(): Promise<void> {
  const base = app.getPath("userData");
  const dataDir = process.env.BRANCH_DATA_DIR ?? join(base, "state");
  const workspace = process.env.BRANCH_WORKSPACE ?? join(base, "workspace");
  const branch = await createBranch({
    dataDir,
    workspace,
    provider: providerFromEnv(),
  });
  let integrationClose: (() => Promise<void>) | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;
  stop = () =>
    (stopping ??= (async () => {
      try {
        await serverClose?.();
      } finally {
        try {
          await integrationClose?.();
        } finally {
          await branch.close();
        }
      }
    })());
  try {
    const integrations = await loadIntegrations(
      branch.registry,
      process.env.BRANCH_INTEGRATIONS,
    );
    integrationClose = integrations.close;
    const server = await startServer(branch, { dataDir, port: 0 });
    serverClose = server.close;
    await createWindow(server.url, server.token);
  } catch (error) {
    await stop();
    throw error;
  }
}

app.setName("Branch Agent");
if (process.env.BRANCH_DESKTOP_HOME)
  app.setPath("userData", process.env.BRANCH_DESKTOP_HOME);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (stop?.() ?? Promise.resolve())
      .catch((error) => console.error("Shutdown:", error.message))
      .finally(() => {
        tray?.destroy();
        app.quit();
      });
  });
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error("Branch Agent could not start:", error.message);
      app.quit();
    });
}
