import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type NativeImage,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Wave 5 (deployment): portable folders, joining a background engine, opening straight to the tray.
import { resolveDataLocation } from "../install/layout.js";
import { attachToRunning } from "../install/running.js";
import { writeUpdateBackup } from "../install/update-backup.js";
import { requestUpdateBackup, stopBackgroundEngine } from "../install/background-engine.js";
import { installedAppRoot } from "./install-root.js";
import { startsMinimized } from "../install/autostart.js";
import { createBranch } from "../index.js";
import { defaultPreset, providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";
import { loadDesktopSettings, registerSettingsIpc } from "./settings-ipc.js";
import { registerUpdaterIpc, type UpdateHooks } from "./updater-ipc.js";
import { ChatGPTAuth, FileTokenVault } from "../chatgpt-auth.js";
import { safeStorage } from "electron";
import type { DesktopSettings } from "./settings.js";
import { registerConversationExportIpc } from "./conversation-export-ipc.js";
import { recordDesktopCrash, type SpanStore } from "../tracing.js";
// mac2/desktop-ui: the Stop notice for screen control on macOS and Linux is a window of this app's own.
import { screen } from "electron";
import { electronBannerWindow } from "./banner-window.js";
// mac3/never-break: trying a new version on a copy of the data before an update.
import { snapshotData, updateCanary } from "../never-break/canary.js";
import { appEntryName } from "./release-assets.js";
// mac7/app-icon: the right size of the KeepOak mark for the window, the menu bar and the dock.
import { WINDOW_ICON_SIZE, isTemplateTrayIcon, trayIconScales, trayIconSize } from "./icon-sizes.js";
// mac7/safe-rollback: what an update changes is written down before the hand-over moves anything.
import { recordActivation } from "../install/headless-update.js";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;

function markPath(): string {
  return fileURLToPath(new URL("../../public/assets/keepoak-mark.png", import.meta.url));
}

/**
 * The window's icon, which Windows and Linux also use for the taskbar. macOS ignores it and takes
 * the dock icon from the `.icns` inside the bundle, so this is only ever the big one.
 */
function branchIcon(): NativeImage {
  return nativeImage
    .createFromPath(markPath())
    .resize({ width: WINDOW_ICON_SIZE, height: WINDOW_ICON_SIZE, quality: "best" });
}

/**
 * The menu-bar or notification-area icon: small, with a sharper copy for a Retina menu bar, and on
 * macOS a template image so the system colours it for a light or a dark menu bar (see icon-sizes.ts).
 */
function trayIcon(): NativeImage {
  const source = nativeImage.createFromPath(markPath());
  const side = trayIconSize(process.platform);
  const image = source.resize({ width: side, height: side, quality: "best" });
  for (const scale of trayIconScales(process.platform)) {
    if (scale === 1) continue;
    const pixels = side * scale;
    const drawn = source.resize({ width: pixels, height: pixels, quality: "best" });
    image.addRepresentation({ scaleFactor: scale, width: pixels, height: pixels, buffer: drawn.toBitmap() });
  }
  if (isTemplateTrayIcon(process.platform)) image.setTemplateImage(true);
  return image;
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
  // Remembered once: a request can still arrive after the window is gone, and a destroyed
  // window throws on any property access ("Object has been destroyed").
  const contentsId = win.webContents.id;
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (
      details.webContentsId === contentsId &&
      new URL(details.url).origin === origin &&
      new URL(details.url).pathname.startsWith("/api/")
    )
      headers.Authorization = `Bearer ${token}`;
    callback({ requestHeaders: headers });
  });
}

async function createWindow(
  url: string, token: string, settings: DesktopSettings, update?: UpdateHooks,
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
  registerUpdaterIpc(window, url, app.getVersion(), () => app.quit(), update);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  // "Start quietly in the corner of the taskbar" keeps the window hidden until the tray icon is used.
  window.once("ready-to-show", () => { if (!startsMinimized(process.argv)) window?.show(); });
  await window.loadURL(`${url}/?desktop=1`);
  createTray();
}

/**
 * macOS only: the menu bar every Mac app has. Edit gives copy and paste their usual keys, the app
 * menu gives Cmd+Q, and closing the window keeps Branch in the dock (see the "close" handler).
 * Windows and Linux keep Electron's own menu, hidden by `autoHideMenuBar`, exactly as before.
 */
function setMacMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "windowMenu" },
  ]));
}

function createTray(): void {
  tray = new Tray(trayIcon());
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

/**
 * Where this launch keeps its files. A `portable.txt` beside the program makes Branch keep
 * everything next to itself, so the whole assistant travels on a memory stick.
 */
async function folders(base: string): Promise<{ dataDir: string; workspace: string }> {
  const location = await resolveDataLocation(dirname(process.execPath), base);
  return {
    dataDir: process.env.BRANCH_DATA_DIR ?? location.dataDir,
    workspace: process.env.BRANCH_WORKSPACE ?? location.workspace,
  };
}
/**
 * mac7/safe-rollback: the app's Update button writes the same record `branch update --yes` does, so
 * a person who updates from the window can go back afterwards. It stays `staged` until the next
 * start says the swap landed, because this process quits into the hand-over script.
 */
function desktopRecord(dataDir: string): Pick<UpdateHooks, "record"> {
  const installRoot = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  // A copy that cannot update itself never hands over, so there is nothing to write down.
  if (!installRoot) return {};
  return { record: async (stagedDir, toVersion) => {
    const recorded = await recordActivation({ dataDir, installRoot, stagedDir, fromVersion: app.getVersion(),
      toVersion, executableName: appEntryName(process.platform) });
    recorded.close();
  } };
}

async function start(): Promise<void> {
  const base = app.getPath("userData");
  const settings = await loadDesktopSettings(join(base, "model-settings.json"));
  const { dataDir, workspace } = await folders(base);
  // An engine already working in the background is joined rather than started a second time.
  const running = await attachToRunning(dataDir);
  // Joining an engine means that engine owns the saved work and holds the program files open, so the
  // safety copy is asked of it and it is closed before an update swaps anything.
  if (running)
    return createWindow(running.url, running.token, settings, {
      backup: () => requestUpdateBackup(running.url, running.token),
      stopDaemon: () => stopBackgroundEngine(dataDir).then((report) => report.pid),
      canary: desktopCanary(dataDir, () => engineSnapshot(running.url, running.token)), // mac3/never-break
      ...desktopRecord(dataDir), // mac7/safe-rollback
    });
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(base, "chatgpt-auth.json"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }), { userAgent: `BranchAgent/${app.getVersion()}` });
  const branch = await createBranch({
    dataDir,
    workspace,
    presets: [defaultPreset(desktopProvider(settings), settings.summary().model || undefined)],
    chatgpt,
    bannerWindow: electronBannerWindow({
      create: (options) => new BrowserWindow(options),
      workArea: () => screen.getPrimaryDisplay().workArea,
    }),
  });
  watchDesktopCrashes(branch);
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
    branch.studies.browser = integrations.hosted.browser; // w911 (A1726) hook: MiniWoB studies open their page in this browser
    branch.issues = integrations.hosted.issues ?? null;
    const server = await startServer(branch, {
      dataDir, port: 0, presence: "app",
      executable: app.isPackaged ? process.execPath : null,
      installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
      quit: () => app.quit(), // bucket 22: `branch quit` is the same as Quit in the menu (bounded shutdown below)
    });
    serverClose = server.close;
    await createWindow(server.url, server.token, settings, {
      backup: () =>
        writeUpdateBackup(dataDir, branch.store.backup(branch.version), branch.version).then(() => undefined),
      // mac3/never-break: the new version is tried on a copy of this data before it is used.
      canary: desktopCanary(dataDir, () => snapshotData({ dataDir, database: branch.store.sqlite, journal: branch.neverBreak.journal.database })),
      ...desktopRecord(dataDir), // mac7/safe-rollback
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * When the window or one of Electron's helper programs dies, that happens in another process, so
 * nothing the engine listens for ever hears about it. Electron tells this process instead, over
 * its own IPC; each report is written into the same record of failures the engine keeps, with the
 * part of the app it came from on it. Nothing here changes what Electron then does.
 */
function watchDesktopCrashes(branch: { store: { spans: SpanStore }; runtime: { owner: string; hideSecrets(value: string): string } }): void {
  const record = (where: string, message: string, stack?: string) =>
    recordDesktopCrash(branch.store.spans, branch.runtime.owner,
      (value) => branch.runtime.hideSecrets(value), { where, message, ...(stack === undefined ? {} : { stack }) });
  app.on("render-process-gone", (_event, _contents, details) =>
    record("window", `The window stopped: ${details.reason}${details.exitCode ? ` (code ${details.exitCode})` : ""}`));
  app.on("child-process-gone", (_event, details) =>
    record(details.type || "helper", `A helper program stopped: ${details.reason}${details.exitCode ? ` (code ${details.exitCode})` : ""}`));
}

/** mac3/never-break: the update's canary step for this computer (src/never-break/canary.ts). */
function desktopCanary(dataDir: string, snapshot: () => Promise<string>) {
  return updateCanary({ dataDir, platform: process.platform, executableName: appEntryName(process.platform),
    fromVersion: app.getVersion(), target: installedAppRoot(app.isPackaged, process.platform, process.execPath), snapshot });
}
/** mac3/never-break: asks the background engine, which holds the database, for a copy of it. */
async function engineSnapshot(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/api/never-break/snapshot`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(120000) });
  const body = await response.json().catch(() => null) as { folder?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.folder !== "string") throw new Error(typeof body?.error === "string" ? body.error : "The background engine did not make a copy of your work.");
  return body.folder;
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
    .then(() => { setMacMenu(); return start(); })
    .catch((error) => {
      console.error("Branch Agent could not start:", error.message);
      app.quit();
    });
}
