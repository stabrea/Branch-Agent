import type { Browser, BrowserContext, Download, Page, Route } from 'playwright';
import type { ToolContext } from '../contracts.js';
import type { StorageState } from './browser-profiles.js';

/** A message box the website put up. It is always dismissed; the words are kept so they can be reported. */
export interface DialogRecord { kind: string; message: string; at: string }
/** A file the website sent, after it was saved inside the workspace. */
export interface DownloadRecord { file: string; bytes: number; from: string }
export interface SessionOptions {
  /** Cookies and site storage from a saved sign-in, used for this run's window only. */
  storageState?: StorageState | undefined;
  /** Saves a file the website sent; anything it rejects is reported and the file is dropped. */
  saveDownload?: ((download: Download) => Promise<DownloadRecord>) | undefined;
  /**
   * The owner's own browser, borrowed for this task. When it is set nothing new is made and
   * nothing of theirs is closed: Branch opens its own tab in their window, checks only its own
   * tabs against the website list, and lets go again at the end.
   */
  attached?: { context: BrowserContext; detach: () => Promise<void> } | undefined;
}

export class BrowserSession {
  private context: BrowserContext | undefined;
  private opening: Promise<Page> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private busy = false;
  private readonly pages: Page[] = [];
  private active = 0;
  private dialogs: DialogRecord[] = [];
  private downloads: DownloadRecord[] = [];
  private pending: Promise<void>[] = [];
  options: SessionOptions = {};
  constructor(private readonly launch: () => Promise<Browser>,
    private readonly route: (route: Route) => Promise<void>) {}

  private checkOpen(): void {
    if (this.closed) throw new Error('Browser run is closed');
  }
  private async open(): Promise<Page> {
    if (this.options.attached) return this.openBorrowed(this.options.attached.context);
    try {
      const browser = await this.launch();
      this.checkOpen();
      this.context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block',
        ...(this.options.storageState ? { storageState: this.options.storageState as never } : {}) });
      this.checkOpen();
      this.context.setDefaultTimeout(10000);
      await this.context.route('**/*', this.route);
      await this.context.routeWebSocket('**/*', socket => socket.close());
      const page = await this.newPage();
      this.checkOpen();
      // Tabs the website opens by itself are closed again; only tabs the assistant asks for are kept.
      this.context.on('page', popup => { if (!this.creatingTab && !this.pages.includes(popup)) void popup.close().catch(() => undefined); });
      return page;
    } catch (error) {
      await this.context?.close();
      throw error;
    }
  }
  /**
   * The owner's own window. Their tabs are left entirely alone: the website list is applied to
   * Branch's own tab only, nothing of theirs is watched, and nothing of theirs is closed.
   */
  private async openBorrowed(context: BrowserContext): Promise<Page> {
    this.checkOpen();
    this.context = context;
    this.borrowed = true;
    context.setDefaultTimeout(10000);
    return this.newPage();
  }
  /** True while this run is working inside the owner's own browser rather than one of its own. */
  private borrowed = false;
  /** Raised while a tab the assistant asked for is being created, so it is not mistaken for a pop-up. */
  private creatingTab = 0;
  /** Every page this run opens watches for message boxes and for files the site sends. */
  private async newPage(): Promise<Page> {
    if (!this.context) throw new Error('Browser run is closed');
    this.creatingTab++;
    const page = await this.context.newPage().finally(() => { this.creatingTab--; });
    // In the owner's own browser the website list is put on Branch's tab alone, so their other
    // tabs carry on exactly as before.
    if (this.borrowed) await page.route('**/*', this.route);
    page.on('dialog', dialog => {
      this.dialogs.push({ kind: dialog.type(), message: dialog.message().slice(0, 500), at: new Date().toISOString() });
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('download', download => this.pending.push(this.collect(download)));
    this.pages.push(page);
    return page;
  }
  private async collect(download: Download): Promise<void> {
    const from = download.url().slice(0, 300);
    try {
      if (!this.options.saveDownload) throw new Error('Saving files from websites is switched off');
      this.downloads.push(await this.options.saveDownload(download));
    } catch (error) {
      await download.cancel().catch(() => undefined);
      this.downloads.push({ file: '', bytes: 0, from: `${from} — not saved: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  /** Message boxes and saved files since the last action, handed over once and then cleared. */
  takeEvents(): { dialogs: DialogRecord[]; downloads: DownloadRecord[] } {
    const events = { dialogs: this.dialogs, downloads: this.downloads };
    this.dialogs = []; this.downloads = [];
    return events;
  }
  async use<T>(context: ToolContext, action: (page: Page) => Promise<T>, graceMs = 0): Promise<T> {
    this.checkOpen();
    if (this.busy) throw new Error('Browser run is already executing an operation');
    this.busy = true;
    try {
      context.signal.throwIfAborted();
      await (this.opening ??= this.open());
      this.checkOpen();
      context.signal.throwIfAborted();
      const result = await action(this.pages[this.active] ?? this.pages[0]!);
      await this.settle(graceMs);
      return result;
    } finally { this.busy = false; }
  }
  /**
   * Files a click started are finished before the result is reported, so they can be named. A click
   * gets a short grace period first, because the browser starts the file a moment after the click.
   */
  private async settle(graceMs: number): Promise<void> {
    const until = Date.now() + graceMs;
    while (!this.pending.length && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 25));
    if (!this.pending.length) return;
    const waiting = this.pending;
    this.pending = [];
    await Promise.race([Promise.allSettled(waiting), new Promise(resolve => setTimeout(resolve, 20000))]);
  }
  /** True once a browser window exists for this run, so a sign-in can no longer be chosen. */
  started(): boolean { return !!this.opening; }
  /** Tabs of this run's window; the active one is where clicking and typing happen. */
  tabs(): { index: number; url: string; active: boolean }[] {
    return this.pages.map((page, index) => ({ index, url: page.url(), active: index === this.active }));
  }
  async openTab(): Promise<number> {
    this.checkOpen();
    if (this.pages.length >= 5) throw new Error('This task already has five tabs open, which is the limit');
    await (this.opening ??= this.open());
    await this.newPage();
    this.active = this.pages.length - 1;
    return this.active;
  }
  selectTab(index: number): number {
    if (!this.pages[index]) throw new Error(`There is no tab ${index} open`);
    return (this.active = index);
  }
  async closeTab(index: number): Promise<void> {
    const page = this.pages[index];
    if (!page) throw new Error(`There is no tab ${index} open`);
    if (this.pages.length === 1) throw new Error('The last tab cannot be closed while the task is running');
    this.pages.splice(index, 1);
    await page.close().catch(() => undefined);
    this.active = Math.min(this.active, this.pages.length - 1);
  }
  /** Cookies and site storage as they are now, for saving back into a named sign-in. */
  async storageState(): Promise<StorageState | null> {
    // The owner's own browser is never copied out of: their cookies stay theirs.
    if (!this.context || this.borrowed) return null;
    return (await this.context.storageState()) as unknown as StorageState;
  }
  /** True while this run is working inside the owner's own browser. */
  isBorrowed(): boolean { return this.borrowed; }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.drain();
  }
  private async drain(): Promise<void> {
    await this.opening?.catch(() => undefined);
    await this.recording?.cancel().catch(() => undefined);
    if (this.borrowed) {
      // Only Branch's own tabs go; the owner's window and their tabs are left exactly as they were.
      for (const page of this.pages) await page.close().catch(() => undefined);
      await this.options.attached?.detach();
      return;
    }
    await this.context?.close();
  }
  /** The recording of this run, while one is being made. */
  private recording: { stop(): Promise<Buffer>; cancel(): Promise<void> } | undefined;
  /** Starts recording this run's browser window, through the given starter. */
  async record(start: (context: BrowserContext) => Promise<{ stop(): Promise<Buffer>; cancel(): Promise<void> }>): Promise<void> {
    if (this.recording) throw new Error('This task is already being recorded');
    await (this.opening ??= this.open());
    if (!this.context) throw new Error('Browser run is closed');
    this.recording = await start(this.context);
  }
  /** Ends the recording and hands back the file. */
  async keepRecording(): Promise<Buffer> {
    if (!this.recording) throw new Error('This task is not being recorded. Start a recording first.');
    const current = this.recording;
    this.recording = undefined;
    return current.stop();
  }
  /** True while a recording is being made, so the context pane can say so. */
  isRecording(): boolean { return !!this.recording; }
}
