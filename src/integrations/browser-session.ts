import type { Browser, BrowserContext, CDPSession, Download, Page, Route } from 'playwright';
import type { ToolContext } from '../contracts.js';
/** What Chrome says about a tab (CDP Target.TargetInfo), the parts used here. */
interface TargetInfo { targetId: string; type: string; url: string; openerId?: string }
import type { StorageState } from './browser-profiles.js';

/** A message box the website put up. It is always dismissed; the words are kept so they can be reported. */
export interface DialogRecord { kind: string; message: string; at: string }
/** A file the website sent, after it was saved inside the workspace. */
export interface DownloadRecord { file: string; bytes: number; from: string }
/** A request held before Chromium sends it, including every hop of a redirect. */
export interface BrowserRequest {
  url: string;
  resourceType: string;
  networkId?: string | undefined;
}
interface PausedRequest {
  requestId: string;
  request: { url: string };
  resourceType: string;
  networkId?: string | undefined;
}
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
  /** Run before every step. Used while a recording is being made, to empty password boxes first. */
  beforeAction?: ((page: Page) => Promise<void>) | undefined;
  /**
   * An extra refusal applied to every single request Branch's own tab makes while it is working in
   * the owner's browser, not only to addresses it was asked to open. Returns why, or null.
   */
  guardUrl?: ((url: string) => string | null) | undefined;
  /** R17-S19: what a website's message box is answered with; unset dismisses it, as always. */
  dialogAnswer?: (() => 'dismiss' | 'accept') | undefined;
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
    private readonly guardRequest: (request: BrowserRequest) => Promise<void>,
    private readonly maxRedirectHops = 5) {}

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
      // This catches a pop-up's first request before its page exists. CDP below additionally catches
      // every redirect hop, which Playwright routes do not surface.
      await this.context.route('**/*', route => this.answerRoute(route));
      await this.context.routeWebSocket('**/*', socket => socket.close());
      // A worker shared between pages sends its requests where neither the route nor the pause sees them, and
      // serviceWorkers: 'block' covers only service workers (Mac mini 0361600: it fetched an unlisted website).
      await this.context.addInitScript(() => {
        if (typeof SharedWorker !== 'undefined')
          Object.defineProperty(window, 'SharedWorker', { value: undefined, writable: false, configurable: false });
      });
      const page = await this.newPage();
      this.checkOpen();
      // Tabs the website opens by itself are closed again; only tabs the assistant asks for are kept.
      // The guard goes on first. Closing a tab is asynchronous, and a pop-up can ask for things while
      // it is still open: its first request is caught by the context route above, but the redirects
      // that request answers with are Chromium's own, and only the pause below sees those. Without
      // this, a pop-up pointed at an allowed website that answers 'now go here' reached a website the
      // owner never allowed, and the tab being closed a moment later did not unsend the request.
      this.context.on('page', popup => {
        void this.guardPage(popup)
          .catch(() => undefined)
          .then(() => this.isOurs(popup))
          .then(ours => (ours ? undefined : popup.close().catch(() => undefined)));
      });
      return page;
    } catch (error) {
      await this.context?.close();
      throw error;
    }
  }
  /**
   * The owner's own window, while they lend it for one task. The website list is applied to Branch's own
   * tab, a tab Branch's tab opens (or one that tab opens) gets nothing and is closed, and nothing of theirs
   * is closed or changed. That is decided by a route on the whole window, because a page gets the last
   * word over anything done inside it: a script can set a link's target back after Branch set it, or open
   * a tab from where no listener sees it, and a guard put on a new tab afterwards is always too late
   * (Mac mini 0361600, cdc7fd0). The owner's own tabs pass through it unchanged; while it is on, the
   * browser does not use its cache for them. It comes off when the task gives the browser back.
   */
  private async openBorrowed(context: BrowserContext): Promise<Page> {
    this.checkOpen();
    this.context = context;
    this.borrowed = true;
    context.setDefaultTimeout(10000);
    await context.route('**/*', this.borrowedRoute);
    context.on('page', page => { void this.closeTabWeOpened(page); });
    return this.newPage();
  }
  /**
   * A new tab's first navigation reaches the route before Playwright has made its page ("issued before the
   * frame is created"), and the page is only announced once that navigation is let go, so it cannot be waited
   * for. Chrome already lists the tab then, with its opener and no address yet (measured on the Mac mini). So a
   * navigation with no page is refused, and its tab closed, while a tab Branch's tab opened has not loaded.
   */
  private async refusesNewTab(request: ReturnType<Route['request']>): Promise<boolean> {
    if (!request.isNavigationRequest() || !this.context) return false;
    try {
      this.browserSession ??= await this.context.browser()!.newBrowserCDPSession();
      const { targetInfos } = await this.browserSession.send('Target.getTargets') as { targetInfos: TargetInfo[] };
      const ours = await this.ourTargetIds();
      const byId = new Map(targetInfos.map(target => [target.targetId, target]));
      const derived = targetInfos.filter(target => target.type === 'page' && this.tracesTo(target, byId, ours));
      for (const target of derived) this.traced.add(target.targetId);
      const unloaded = derived.filter(target => !target.url);
      for (const target of unloaded) void this.browserSession.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
      return unloaded.length > 0;
    } catch {
      // Whose tab it is cannot be told, so it is refused: the owner can open theirs again, a tab of ours must send nothing.
      return true;
    }
  }
  /**
   * Chrome's ids of every tab traced back to Branch's tab. They are kept after the tab closes (this code closes
   * them itself), so a tab one of them opened is still traced once its opener has gone from Chrome's list.
   */
  private readonly traced = new Set<string>();
  /** Whether a tab's openers lead back to Branch's tab or to a tab traced to it, however many there are. */
  private tracesTo(target: TargetInfo, byId: Map<string, TargetInfo>, ours: Set<string>): boolean {
    const seen = new Set<string>();
    for (let at: TargetInfo | undefined = target; at?.openerId && !seen.has(at.openerId); at = byId.get(at.openerId)) {
      if (ours.has(at.openerId) || this.traced.has(at.openerId)) return true;
      seen.add(at.openerId);
    }
    return false;
  }
  /** Chrome's ids of Branch's own tabs. One that cannot be read makes the whole answer unknown, never a smaller set. */
  private async ourTargetIds(): Promise<Set<string>> {
    const ids = await Promise.all(this.pages.map(page => this.targetOf(page)));
    if (ids.some(id => !id)) throw new Error('A tab of ours could not be told apart');
    return new Set(ids);
  }
  private browserSession: CDPSession | undefined;
  private readonly targetIds = new WeakMap<Page, Promise<string>>();
  private targetOf(page: Page): Promise<string> {
    let known = this.targetIds.get(page);
    if (!known) {
      known = this.context!.newCDPSession(page).then(async session => {
        const { targetInfo } = await session.send('Target.getTargetInfo') as { targetInfo: TargetInfo };
        await session.detach().catch(() => undefined);
        return targetInfo.targetId;
      }).catch(() => { this.targetIds.delete(page); return ''; }); // asked again next time, never kept as unknown
      this.targetIds.set(page, known);
    }
    return known;
  }
  private readonly borrowedRoute = (route: Route): Promise<void> => this.answerBorrowed(route);
  /** In the owner's window: Branch's tab by the website list, a tab it opened by nothing, anything else as it was. */
  private async answerBorrowed(route: Route): Promise<void> {
    let page: Page | undefined;
    try { page = route.request().frame().page(); } catch { page = undefined; }
    if (!page && await this.refusesNewTab(route.request())) { await route.abort().catch(() => undefined); return; }
    if (page && await this.isOurs(page)) return this.answerRoute(route);
    if (page && await this.openedByUs(page)) { await route.abort().catch(() => undefined); return; }
    await route.fallback().catch(() => undefined);
  }
  /** Tabs opened from Branch's tab, or from one of those, asked once each (their opener cannot change). */
  private readonly openedFromOurs = new WeakMap<Page, Promise<boolean>>();
  private openedByUs(page: Page): Promise<boolean> {
    let known = this.openedFromOurs.get(page);
    if (!known) {
      known = page.opener().then(
        async opener => opener ? await this.isOurs(opener) || await this.openedByUs(opener) : this.openerTraced(page),
        () => false).then(async fromOurs => {
        if (fromOurs) { const id = await this.targetOf(page); if (id) this.traced.add(id); }
        return fromOurs;
      });
      this.openedFromOurs.set(page, known);
    }
    return known;
  }
  /**
   * A tab with no opener Playwright still knows: its opener may be a traced tab already closed, which Chrome
   * still names as its opener. Asked of Chrome only then, once per tab.
   */
  private async openerTraced(page: Page): Promise<boolean> {
    if (!this.traced.size || !this.context) return false;
    try {
      const id = await this.targetOf(page);
      this.browserSession ??= await this.context.browser()!.newBrowserCDPSession();
      const { targetInfos } = await this.browserSession.send('Target.getTargets') as { targetInfos: TargetInfo[] };
      const target = targetInfos.find(each => each.targetId === id);
      if (!target) return false;
      const byId = new Map(targetInfos.map(each => [each.targetId, each]));
      // Traced tabs are asked first: a tab of ours whose id cannot be read then leaves this answer as it is.
      return this.tracesTo(target, byId, new Set()) || this.tracesTo(target, byId, await this.ourTargetIds());
    } catch {
      return false;
    }
  }
  private async closeTabWeOpened(page: Page): Promise<void> {
    if (await this.isOurs(page)) return;
    if (await this.openedByUs(page)) await page.close().catch(() => undefined);
  }
  /**
   * Whether a page is one the assistant asked for. While one is being made, the page that making it
   * returns is the only one that counts: counting every page that appears meanwhile let a website's
   * pop-up in, unguarded, whenever it opened while the assistant was opening a tab.
   */
  private async isOurs(page: Page): Promise<boolean> {
    if (this.pages.includes(page)) return true;
    return (await this.creating) === page;
  }
  /** True while this run is working inside the owner's own browser rather than one of its own. */
  private borrowed = false;
  /** The tab the assistant asked for while it is being made, so it alone is not mistaken for a pop-up. */
  private creating: Promise<Page | null> | null = null;
  /** Every page this run opens watches for message boxes and for files the site sends. */
  private async newPage(): Promise<Page> {
    if (!this.context) throw new Error('Browser run is closed');
    const making = this.context.newPage();
    const creating = making.catch(() => null);
    this.creating = creating;
    const page = await making.catch((error: unknown) => {
      if (this.creating === creating) this.creating = null;
      throw error;
    });
    // In the owner's own browser the website list reaches this tab through the window's route
    // (openBorrowed). What follows only keeps new tabs from opening at all, which saves closing them.
    if (this.borrowed) {
      // In the owner's own browser a tab this one opens cannot be stopped after the fact: its first
      // request is in flight before any guard can be put on it, and it was reaching websites they
      // never allowed. So it is stopped at the source, on Branch's tab alone: a window this page
      // asks for is not opened, and a link that asks for a new tab opens in this one instead, where
      // everything is already checked. Nothing here touches any other tab.
      await page.addInitScript(() => {
        // Whatever says where a link or form opens — its own target, the page's <base target>, or the
        // button's formtarget, which outranks the form's — is made this tab. Setting `_self` on the
        // element itself outranks <base>, so a plain link under <base target=_blank> stays here too.
        const here = (node: Element | null | undefined): void => {
          if (node) node.setAttribute('target', '_self');
        };
        window.open = () => null;
        // Links, image-map areas and forms. A form asking for a new tab is not a link and was not
        // covered by the first version of this; measured, the tab it opened reached a website the
        // owner never allowed before anything could be put in its way.
        const onClick = (event: Event): void => here((event.target as Element | null)?.closest?.('a[href], area[href]'));
        addEventListener('click', onClick, true);
        // A link the page never puts in the document, or hides in a closed shadow root, is clicked where the
        // window's listener cannot see it (Mac mini 0361600). So a click asked for by script is caught on the
        // element itself, and every shadow root gets the same listener as the window.
        const isLink = (node: unknown): node is Element => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement;
        const clicking = HTMLElement.prototype.click;
        HTMLElement.prototype.click = function clickHere(this: HTMLElement) {
          if (isLink(this)) here(this);
          return clicking.call(this);
        };
        const dispatching = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function dispatchHere(this: EventTarget, event: Event) {
          if (event.type === 'click' && isLink(this)) here(this);
          return dispatching.call(this, event);
        };
        const attaching = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachHere(this: Element, init: ShadowRootInit) {
          const root = attaching.call(this, init);
          root.addEventListener('click', onClick, true);
          return root;
        };
        addEventListener('submit', event => {
          here(event.target as Element | null);
          const submitter = (event as SubmitEvent).submitter;
          if (submitter?.hasAttribute('formtarget')) submitter.setAttribute('formtarget', '_self');
        }, true);
        // A form submitted by script raises no submit event at all, so the listener above never sees
        // it. Measured: that tab reached a website the owner never allowed. The method itself is
        // where it has to be caught.
        // Branch's own window blocks these outright; the owner's cannot be reconfigured, so the page
        // is stopped from starting one. A worker answers requests from outside the page, where the
        // route and the pause cannot see it — measured, it fetched a website the owner never allowed.
        // On the prototype, fixed in place, rather than on the one object: a page could delete an
        // object's own copy, or call the prototype's with the object, and register one anyway
        // (measured). A worker shared between tabs is refused the same way.
        const refuse = () => Promise.reject(new Error('Branch does not start background workers in your browser'));
        if (typeof ServiceWorkerContainer !== 'undefined')
          Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { value: refuse, writable: false, configurable: false });
        if (typeof SharedWorker !== 'undefined')
          Object.defineProperty(window, 'SharedWorker', { value: undefined, writable: false, configurable: false });
        const sending = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function submitHere(this: HTMLFormElement) {
          here(this);
          return sending.call(this);
        };
      });
    }
    await this.guardPage(page);
    page.on('dialog', dialog => {
      this.dialogs.push({ kind: dialog.type(), message: dialog.message().slice(0, 500), at: new Date().toISOString() });
      // R17-S19: the owner may have message boxes accepted (OK) rather than dismissed (Cancel).
      // Integration review: a box that asks for typing (prompt) is always dismissed, so nothing is ever
      // typed or confirmed into it; only alert, confirm and "leave this page?" may be accepted.
      const accept = this.options.dialogAnswer?.() === 'accept' && dialog.type() !== 'prompt';
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on('download', download => this.pending.push(this.collect(download)));
    this.pages.push(page);
    // Only now, when it is one of ours by name, does it stop being the tab being made.
    if (this.creating === creating) this.creating = null;
    return page;
  }
  private async answerRoute(route: Route): Promise<void> {
    try {
      const request = route.request();
      // A tab the website opened by itself is going to be closed; until it is, it gets nothing.
      // Guarding it and closing it afterwards is not enough, and that is measured rather than
      // supposed: attaching the pause to a pop-up loses a race it cannot win, because the pop-up's
      // first request and the redirect it answers with are already in flight. This is the moment
      // Playwright hands over before anything is sent, so it is the moment the answer has to be no.
      if (!this.borrowed) {
        const page = request.frame()?.page();
        if (page && !(await this.isOurs(page))) { await route.abort(); return; }
      }
      const refused = this.options.guardUrl?.(request.url());
      if (refused) throw new Error(refused);
      await this.guardRequest({ url: request.url(), resourceType: request.resourceType() });
      // The pause below is on the page's own process. A frame from another website runs in a process
      // of its own, where Chromium follows redirects without pausing, so a frame's request is sent here
      // with redirects refused, as every request was before the pause existed. A frame on the page's
      // own website loses its redirects too; a frame being sent onwards is rare, and never needed.
      if (this.inFrame(request)) {
        const response = await route.fetch({ maxRedirects: 0 });
        if (response.status() >= 300 && response.status() < 400) throw new Error('A frame was sent onwards');
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    } catch {
      await route.abort().catch(() => undefined);
    }
  }
  /** True for a request made by a frame inside a page rather than by the page itself. */
  private inFrame(request: ReturnType<Route['request']>): boolean {
    try { return request.frame().parentFrame() !== null; } catch { return false; }
  }
  /** Chromium pauses each redirect destination here before sending it, unlike Playwright routes. */
  private async guardPage(page: Page): Promise<void> {
    if (!this.context) throw new Error('Browser run is closed');
    const session = await this.context.newCDPSession(page);
    const redirectCounts = new Map<string, number>();
    session.on('Fetch.requestPaused', (event: PausedRequest) => {
      void this.answerPaused(session, event, redirectCounts);
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }
  private async answerPaused(session: CDPSession, event: PausedRequest,
    redirectCounts: Map<string, number>): Promise<void> {
    try {
      const refused = this.options.guardUrl?.(event.request.url);
      if (refused) throw new Error(refused);
      if (event.resourceType === 'Document' && event.networkId) {
        const count = (redirectCounts.get(event.networkId) ?? 0) + 1;
        redirectCounts.set(event.networkId, count);
        if (count > this.maxRedirectHops + 1) throw new Error('Too many redirects');
      }
      await this.guardRequest({ url: event.request.url, resourceType: event.resourceType,
        ...(event.networkId ? { networkId: event.networkId } : {}) });
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch {
      await session.send('Fetch.failRequest', {
        requestId: event.requestId, errorReason: 'BlockedByClient',
      }).catch(() => undefined);
    }
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
      const page = this.pages[this.active] ?? this.pages[0]!;
      if (this.options.beforeAction) await this.options.beforeAction(page);
      const result = await action(page);
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
      // Only Branch's own tabs go, and the tabs they opened; the window's route comes off only after, so nothing they
      // open on the way out goes unrefused. The owner's tabs are left as they were.
      for (const page of this.pages) await page.close().catch(() => undefined);
      for (const page of this.context?.pages() ?? []) if (await this.openedByUs(page)) await page.close().catch(() => undefined);
      await this.context?.unroute('**/*', this.borrowedRoute).catch(() => undefined);
      await this.browserSession?.detach().catch(() => undefined);
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
