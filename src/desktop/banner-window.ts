import { bannerTitle, type BannerNotice, type BannerWindow, type BannerWindowFactory } from "../integrations/desktop-banner.js";

/**
 * The Stop notice on a Mac or Linux: a small frameless window of the desktop app's own that sits on
 * top of everything while Branch uses the screen. It has no script and no preload. Its Stop button is
 * a plain link to an address that is never visited: the main process sees the click as a navigation,
 * refuses it, and closes the window, and a closing notice means "stop now", as it does on Windows.
 *
 * Electron is handed in rather than imported, so this file can be checked with a stand-in window
 * and nothing is ever shown on the computer running the tests.
 */
export const stopAddress = "https://stop.branch-banner.invalid/";

/** The little of Electron's BrowserWindow the notice uses. */
export interface BannerHost {
  isDestroyed(): boolean;
  showInactive(): void;
  close(): void;
  destroy(): void;
  setAlwaysOnTop(flag: boolean, level?: "screen-saver"): void;
  setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  loadURL(url: string): Promise<void>;
  on(event: "show" | "hide" | "closed", listener: () => void): unknown;
  once(event: "show", listener: () => void): unknown;
  webContents: {
    on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
  };
}

export interface WorkArea { x: number; y: number; width: number; height: number }
export interface ElectronBannerDeps {
  create: (options: ReturnType<typeof bannerWindowOptions>) => BannerHost;
  workArea: () => WorkArea;
  platform?: string;
  /** How long the window system may take to put the notice up before it counts as not shown. */
  showTimeoutMs?: number;
}

const width = 460, height = 52;
/**
 * The notice cannot read public/tokens.css (it fetches nothing), so it carries the Forest values of
 * the three tokens it uses, copied from there: --ground, --text, and --bad for Stop with --paper-text on it.
 */
const forest = { ground: "#03140b", text: "#edf1ea", bad: "#f28b7a", onBad: "#17201b" } as const;

/** The screen control notice: what the window says when nothing else is asked for. */
export const screenNotice: BannerNotice = { title: bannerTitle, text: "Branch is using your screen and keyboard", button: "Stop" };
/** The notice's words are fixed strings of Branch's own, but they are escaped all the same. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Where the notice goes and what it may do: nothing but show two words and a button. */
export function bannerWindowOptions(area: WorkArea, title = bannerTitle) {
  return {
    width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + 12,
    title, frame: false, show: false, resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: true, backgroundColor: forest.ground,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
      spellcheck: false, partition: "branch-banner",
    },
  };
}

/**
 * The whole notice, as one page with no script and nothing to fetch. The shared Linux desktop's
 * "Take over" notice is the same page with its own words; its button closes the window the same way.
 */
export function bannerPage(notice: BannerNotice = screenNotice): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(notice.title)}</title><style>
html,body{margin:0;height:100%;background:${forest.ground};color:${forest.text};font:14px system-ui,sans-serif;overflow:hidden}
body{display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 16px;box-sizing:border-box;-webkit-app-region:drag}
a{-webkit-app-region:no-drag;background:${forest.bad};color:${forest.onBad};font-weight:700;text-decoration:none;padding:7px 28px;border-radius:4px}
a:focus{outline:2px solid ${forest.text}}
</style></head><body><span>${escapeHtml(notice.text)}</span><a id="stop" href="${stopAddress}">${escapeHtml(notice.button)}</a></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Resolves when the window system says the notice is on the screen, or fails after a while. */
function shownWithin(host: BannerHost, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The notice did not appear in time.")), timeoutMs);
    host.once("show", () => { clearTimeout(timer); resolve(); });
  });
}

/** Everything the notice refuses: new windows, and going anywhere at all. Stop closes it. */
function guard(host: BannerHost): void {
  host.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  host.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === stopAddress && !host.isDestroyed()) host.close();
  });
}

/** The factory the main process hands to `createBranch`. */
export function electronBannerWindow(deps: ElectronBannerDeps): BannerWindowFactory {
  return async (closed, notice = screenNotice) => {
    const host = deps.create(bannerWindowOptions(deps.workArea(), notice.title));
    let shown = false;
    host.on("show", () => { shown = true; });
    host.on("hide", () => { shown = false; });
    host.on("closed", () => { shown = false; closed(); });
    guard(host);
    host.setAlwaysOnTop(true, "screen-saver");
    if ((deps.platform ?? process.platform) === "darwin") host.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try {
      await host.loadURL(bannerPage(notice));
      const appeared = shownWithin(host, deps.showTimeoutMs ?? 3000);
      host.showInactive();
      await appeared;
    } catch (error) {
      if (!host.isDestroyed()) host.destroy();
      throw error;
    }
    const window: BannerWindow = {
      get showing() { return shown && !host.isDestroyed(); },
      close: () => { if (!host.isDestroyed()) host.close(); },
    };
    return window;
  };
}
