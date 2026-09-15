import type { Browser, BrowserContext, Page, Route } from 'playwright';
import type { ToolContext } from '../contracts.js';

export class BrowserSession {
  private context: BrowserContext | undefined;
  private opening: Promise<Page> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private busy = false;
  constructor(private readonly launch: () => Promise<Browser>,
    private readonly route: (route: Route) => Promise<void>) {}

  private checkOpen(): void {
    if (this.closed) throw new Error('Browser run is closed');
  }
  private async open(): Promise<Page> {
    try {
      const browser = await this.launch();
      this.checkOpen();
      this.context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      this.checkOpen();
      this.context.setDefaultTimeout(10000);
      await this.context.route('**/*', this.route);
      await this.context.routeWebSocket('**/*', socket => socket.close());
      const page = await this.context.newPage();
      this.checkOpen();
      this.context.on('page', popup => { if (popup !== page) void popup.close().catch(() => undefined); });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => undefined); });
      return page;
    } catch (error) {
      await this.context?.close();
      throw error;
    }
  }
  async use<T>(context: ToolContext, action: (page: Page) => Promise<T>): Promise<T> {
    this.checkOpen();
    if (this.busy) throw new Error('Browser run is already executing an operation');
    this.busy = true;
    try {
      context.signal.throwIfAborted();
      const page = await (this.opening ??= this.open());
      this.checkOpen();
      context.signal.throwIfAborted();
      return await action(page);
    } finally { this.busy = false; }
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.drain();
  }
  private async drain(): Promise<void> {
    await this.opening?.catch(() => undefined);
    await this.context?.close();
  }
}
