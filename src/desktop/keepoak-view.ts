/**
 * Issue #105, slice 1: KeepOak inside Branch. A window of its own that only shows keepoak.com,
 * signed in on KeepOak's own page until the account link (#19) can hand a session over.
 *
 *   - its own saved session (`persist:keepoak`): its cookies never mix with Branch's window or the
 *     browser tasks use, and neither can read them;
 *   - locked to KeepOak: exact KeepOak addresses, and the sign-in pages of the accounts people sign
 *     in to KeepOak with; anything else opens in the person's own browser, only once they say so;
 *   - no permission (camera, microphone, location, notifications…) and no downloads;
 *   - no new windows: a link that asks for one is refused;
 *   - no preload, no Node, context isolation and the sandbox on: the page cannot reach Branch;
 *   - closing it only hides it, so switching back and forth keeps both where they were;
 *   - Disconnect closes it and clears that session: cookies, storage, cache and saved sign-ins.
 *
 * Nothing here runs unless the owner switched KeepOak on (src/keepoak.ts); the Electron pieces are
 * handed in, so the rules are tested without starting Electron.
 */
export const keepOakHome = "https://keepoak.com/";
export const keepOakPartition = "persist:keepoak";

/** KeepOak's own addresses, exactly: no sub-domain is taken on trust. */
const keepOakOrigins = new Set(["https://keepoak.com", "https://www.keepoak.com"]);
/** The sign-in pages KeepOak's own sign-in may pass through, and nothing else from those sites. */
const signInPages: readonly { host: string; path: RegExp }[] = [
  { host: "accounts.google.com", path: /^\/(o\/oauth2|signin|v3\/signin|ServiceLogin|AccountChooser|InteractiveLogin)/ },
  { host: "github.com", path: /^\/(login|session|sessions\/two-factor)/ },
  { host: "appleid.apple.com", path: /^\/(auth|appleauth)/ },
  { host: "login.microsoftonline.com", path: /^\// },
];

/** Whether the KeepOak window may show this address itself (everything else opens outside). */
export function keepOakMayShow(address: string): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (keepOakOrigins.has(url.origin)) return true;
  const host = url.hostname.toLowerCase();
  return signInPages.some((page) => page.host === host && page.path.test(url.pathname));
}

/** Nothing the page asks of this computer is granted: a new session would otherwise grant it. */
export const keepOakMayUse = (_permission: string): boolean => false;

/** Only ordinary web addresses are handed to the person's own browser; nothing that runs a program. */
const openableOutside = (address: string): boolean => /^https?:\/\//i.test(address);

/** The few Electron pieces this needs, so a test can stand in for them. */
export interface ViewWindow {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: "close", listener: (event: { preventDefault(): void }) => void): void;
  webContents: {
    on(event: "will-navigate" | "will-redirect", listener: (event: { preventDefault(): void }, url: string) => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "allow" | "deny" }): void;
  };
}
export interface ViewDeps {
  /** Makes the window with the preferences given (`keepOakWindowOptions`). */
  makeWindow: (options: typeof keepOakWindowOptions) => ViewWindow;
  openOutside: (url: string) => Promise<void> | void;
  /** Asks the owner before another site opens in their own browser; true only when they say yes. */
  confirmOutside: (url: string) => Promise<boolean>;
  /** Clears everything the `persist:keepoak` session holds. */
  clearSession: () => Promise<void>;
}

export const keepOakWindowOptions = Object.freeze({
  width: 1280, height: 860, minWidth: 700, minHeight: 500, title: "KeepOak", show: false, autoHideMenuBar: true,
  webPreferences: Object.freeze({
    partition: keepOakPartition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    // No preload: nothing of Branch is put into the page.
  }),
});

export class KeepOakView {
  private window: ViewWindow | null = null;
  private leaving = false;
  constructor(private readonly deps: ViewDeps) {}

  /** Opens the KeepOak window, or brings back the one already open where it was. */
  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const window = this.deps.makeWindow(keepOakWindowOptions);
    this.window = window;
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (keepOakMayShow(url)) return;
      event.preventDefault();
      void this.offerOutside(url);
    };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", guard);
    // No new windows, and nothing they asked for is loaded here instead.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!keepOakMayShow(url)) void this.offerOutside(url);
      return { action: "deny" };
    });
    window.on("close", (event) => {
      if (this.leaving) return;
      event.preventDefault(); // closing only hides it, so it keeps its place
      window.hide();
    });
    // Offline or KeepOak down: the window still opens, showing the browser's own page for that.
    await window.loadURL(keepOakHome).catch(() => undefined);
    window.show();
    window.focus();
  }

  /** Another site: the person's own browser, once they say yes; never something that runs a program. */
  private async offerOutside(url: string): Promise<void> {
    if (!openableOutside(url)) return;
    if (await this.deps.confirmOutside(url).catch(() => false)) await this.deps.openOutside(url);
  }

  /** Closes the window and forgets the KeepOak sign-in on this computer. */
  async disconnect(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.leaving = true; this.window.destroy(); }
    this.window = null;
    this.leaving = false;
    await this.deps.clearSession();
  }

  /** Branch is quitting: let the window go without hiding it. */
  close(): void {
    this.leaving = true;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
