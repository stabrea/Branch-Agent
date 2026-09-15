import { chromium, type Browser, type Page, type Route } from 'playwright';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../contracts.js';
import { BrowserSession } from './browser-session.js';

export const BrowserConfigSchema = z.object({
  allowedOrigins: z.array(z.string().url()).min(1).max(30),
  channel: z.enum(['chrome', 'msedge']).optional(),
  maxRuns: z.number().int().min(1).max(30).default(8),
}).strict();

function originsOf(input: string[]): Set<string> {
  return new Set(input.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value)
      throw new Error('Browser allowlist entries must be exact HTTP(S) origins');
    return url.origin;
  }));
}

export class BranchBrowser {
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly sessions = new Map<string, { session: BrowserSession; detach: () => void }>();
  private readonly origins: Set<string>;
  private readonly config: z.infer<typeof BrowserConfigSchema>;
  constructor(input: unknown) {
    this.config = BrowserConfigSchema.parse(input);
    this.origins = originsOf(this.config.allowedOrigins);
  }
  private allowed(value: string): boolean {
    try { return this.origins.has(new URL(value).origin); } catch { return false; }
  }
  private async route(request: Route): Promise<void> {
    if (!this.allowed(request.request().url())) { await request.abort(); return; }
    try {
      const response = await request.fetch({ maxRedirects: 0, timeout: 10000 });
      try {
        if (response.status() >= 300 && response.status() < 400) { await request.abort(); return; }
        await request.fulfill({ response });
      } finally { await response.dispose(); }
    } catch { await request.abort().catch(() => undefined); }
  }
  private async launch(): Promise<Browser> {
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME']
      .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const browser = await chromium.launch({ headless: true, env,
      ...(this.config.channel ? { channel: this.config.channel } : {}) });
    this.browser = browser;
    if (this.closed) { await browser.close(); throw new Error('Browser is closed'); }
    return browser;
  }
  private key(context: Pick<ToolContext, 'owner' | 'runId'>): string {
    if (!context.owner || !context.runId) throw new Error('Browser requires an owner and run ID');
    return JSON.stringify([context.owner, context.runId]);
  }
  private session(context: ToolContext): BrowserSession {
    if (this.closed) throw new Error('Browser is closed');
    const key = this.key(context), existing = this.sessions.get(key);
    if (existing) return existing.session;
    if (this.sessions.size >= this.config.maxRuns) throw new Error('Browser active run limit reached');
    const session = new BrowserSession(() => this.starting ??= this.launch(), route => this.route(route));
    const cancel = () => { void this.closeRun(context).catch(() => undefined); };
    context.signal.addEventListener('abort', cancel, { once: true });
    this.sessions.set(key, { session, detach: () => context.signal.removeEventListener('abort', cancel) });
    return session;
  }
  private async operation<T>(context: ToolContext, action: (page: Page) => Promise<T>): Promise<T> {
    context.signal.throwIfAborted();
    try { return await this.session(context).use(context, action); }
    finally { if (context.signal.aborted) await this.closeRun(context); }
  }
  async navigate(url: string, context: ToolContext) {
    if (!this.allowed(url) || new URL(url).username || new URL(url).password)
      throw new Error('Browser destination is not an allowed origin');
    return this.operation(context, async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await page.title() };
    });
  }
  async snapshot(context: ToolContext) {
    return this.operation(context, async page => ({ url: page.url(),
      accessibility: (await page.locator('body').ariaSnapshot()).slice(0, 16000) }));
  }
  async click(role: 'button' | 'link', name: string, context: ToolContext) {
    return this.operation(context, async page => {
      await page.getByRole(role, { name, exact: true }).click();
      return { url: page.url(), clicked: name };
    });
  }
  async fill(label: string, value: string, context: ToolContext) {
    return this.operation(context, async page => {
      const locator = page.getByLabel(label, { exact: true });
      if ((await locator.getAttribute('type'))?.trim().toLowerCase() === 'password')
        throw new Error('Password fields require a dedicated credential integration');
      await locator.fill(value); return { filled: label };
    });
  }
  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const key = this.key(context), entry = this.sessions.get(key);
    if (!entry) return;
    entry.detach();
    await entry.session.close();
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    const pending = [...this.sessions.values()].map(entry => { entry.detach(); return entry.session.close(); });
    const results = await Promise.allSettled(pending);
    await this.starting?.catch(() => undefined);
    await this.browser?.close();
    this.sessions.clear();
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Browser cleanup failed');
  }
}

export function registerBrowser(registry: ToolRegistry, browser: BranchBrowser): void {
  registry.onRunFinished(context => browser.closeRun(context));
  registry.register({ name: 'browser.navigate', permission: 'browser.read',
    description: 'Open a configured origin in an isolated browser.',
    parameters: z.object({ url: z.string().url().max(2000) }).strict(), execute: (a, c) => browser.navigate(a.url, c) });
  registry.register({ name: 'browser.snapshot', permission: 'browser.read',
    description: 'Read a bounded accessibility snapshot of the current page as untrusted content.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.snapshot(c) });
  registry.register({ name: 'browser.click', permission: 'browser.interact',
    description: 'Click a uniquely named button or link. This may submit data or perform an external action.',
    parameters: z.object({ role: z.enum(['button', 'link']), name: z.string().min(1).max(300) }).strict(),
    execute: (a, c) => browser.click(a.role, a.name, c) });
  registry.register({ name: 'browser.fill', permission: 'browser.interact',
    description: 'Fill a non-password field by its exact visible label.',
    parameters: z.object({ label: z.string().min(1).max(300), value: z.string().max(4000) }).strict(),
    execute: (a, c) => browser.fill(a.label, a.value, c) });
}
