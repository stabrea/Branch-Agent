import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type NativeImage,
} from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBranch } from "../index.js";
import { defaultPreset, providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";
import { loadDesktopSettings, registerSettingsIpc } from "./settings-ipc.js";
import { registerUpdaterIpc } from "./updater-ipc.js";
import { ChatGPTAuth, FileTokenVault } from "../chatgpt-auth.js";
import { safeStorage } from "electron";
import type { DesktopSettings } from "./settings.js";
import { registerConversationExportIpc } from "./conversation-export-ipc.js";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;

function branchIcon(): NativeImage {
  const path = fileURLToPath(new URL("../../public/assets/keepoak-mark.png", import.meta.url));
  return nativeImage.createFromPath(path).resize({ width: 32, height: 32 });
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

async function createWindow(
  url: string, token: string, settings: DesktopSettings,
): Promise<void> {
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
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:branch-agent",
    },
  });
  protectWindow(window, url, token);
  registerSettingsIpc(window, url, settings, process.env.BRANCH_PROVIDER !== undefined);
  registerConversationExportIpc(window, url);
  registerUpdaterIpc(window, url, app.getVersion(), () => app.quit());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(`${url}/?desktop=1`);
  createTray();
}

function createTray(): void {
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
  const settings = await loadDesktopSettings(join(base, "model-settings.json"));
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(base, "chatgpt-auth.json"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }), { userAgent: `BranchAgent/${app.getVersion()}` });
  const dataDir = process.env.BRANCH_DATA_DIR ?? join(base, "state");
  const workspace = process.env.BRANCH_WORKSPACE ?? join(base, "workspace");
  const branch = await createBranch({
    dataDir,
    workspace,
    presets: [defaultPreset(desktopProvider(settings), settings.summary().model || undefined)],
    chatgpt,
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
      process.env,
      branch.secretsFor,
      branch.channelHost,
    );
    integrationClose = integrations.close;
    branch.browser = integrations.hosted.browser ?? null;
    const server = await startServer(branch, { dataDir, port: 0 });
    serverClose = server.close;
    await createWindow(server.url, server.token, settings);
  } catch (error) {
    await stop();
    throw error;
  }
}

function desktopProvider(settings: DesktopSettings) {
  if (process.env.BRANCH_PROVIDER !== undefined) return providerFromEnv();
  try {
    return providerFromEnv(settings.environment());
  } catch {
    settings.reportConnectionIssue();
    return providerFromEnv({ BRANCH_PROVIDER: "demo" });
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
    // Shutting down waits for the loopback server and open work, but never for long: an update
    // hand-over depends on this process actually ending.
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 8000).unref());
    void Promise.race([(stop?.() ?? Promise.resolve()), deadline])
      .catch((error) => console.error("Shutdown:", error.message))
      .finally(() => {
        tray?.destroy();
        app.exit(0);
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
