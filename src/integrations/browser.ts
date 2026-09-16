import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type Download, type Page, type Route } from 'playwright';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../contracts.js';
import type { RunArtifacts } from '../artifacts.js';
import { BrowserSession, type DownloadRecord } from './browser-session.js';
import { BrowserProfiles, profileNameSchema, type StorageState } from './browser-profiles.js';
import { ExtractSchema, ScreenshotSchema, WaitSchema, extract, safeDownloadName, screenshot, waitFor } from './browser-page.js';
import { AnnotateSchema, MarkRegistry, annotate, clearMarks } from './browser-marks.js';
import { ExtractSchemaSchema, extractSchema } from './browser-schema.js';
import { resolve as healResolve, type HealTarget } from './browser-heal.js';
import { attach, attachRefusal, attachedAddressRefusal, readAttachSettings, saveAttachSettings, type AttachedBrowser } from './browser-attach.js';
import { clearPasswordValues, startRecording } from './browser-trace.js';
import type { Store } from '../store.js';

export const BrowserConfigSchema = z.object({
  allowedOrigins: z.array(z.string().url()).min(1).max(30),
  channel: z.enum(['chrome', 'msedge']).optional(),
  maxRuns: z.number().int().min(1).max(30).default(8),
  /** Most browser actions one task may take before it has to stop and report back. */
  maxActionsPerRun: z.number().int().min(1).max(500).default(80),
  /** Most different websites one task may open. */
  maxOriginsPerRun: z.number().int().min(1).max(30).default(5),
  /** Largest file a website may send that is kept, in bytes. */
  maxDownloadBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  /** File endings that may be saved from a website. Anything else is refused and reported. */
  downloadTypes: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(40)
    .default(['pdf', 'csv', 'txt', 'md', 'json', 'xml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'xlsx', 'docx', 'pptx', 'zip']),
}).strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
/** Where files a website sends are kept, inside the person's workspace. */
export const downloadFolder = 'downloads';
/** What the person is told when a task has wandered too far; it stops and reports instead. */
const originStop = (limit: number) =>
  `This task has already opened ${limit} different websites, which is as many as one task may. Stop, tell the person what you found and what you still wanted to look at, and let them decide.`;
const actionStop = (limit: number) =>
  `This task has already taken ${limit} browser actions, which is as many as one task may. Stop and tell the person what you have so far.`;

function originsOf(input: string[]): Set<string> {
  return new Set(input.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value)
      throw new Error('Browser allowlist entries must be exact HTTP(S) origins');
    return url.origin;
  }));
}
/** The paths a workspace file tool checks for the browser: the same confinement files.* uses. */
export interface WorkspacePaths { checked(path: string, allowRoot?: boolean): Promise<string> }
interface RunEntry {
  session: BrowserSession;
  detach: () => void;
  origins: Set<string>;
  actions: number;
  host: string;
  profile: string | null;
  /** The numbers handed out to the things on the pages this task has looked at. */
  marks: MarkRegistry;
  /** The owner's own browser, while this task is borrowing it. */
  borrowed: AttachedBrowser | null;
}
/** Where the trace of one task is written, when the launch keeps traces. */
export interface BrowserTracer {
  start(runId: string, kind: 'tool', name: string, attributes?: Record<string, unknown>):
    { end(status: 'ok' | 'error', message?: string, attributes?: Record<string, string | number | boolean>): void } | null;
}

export class BranchBrowser {
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly sessions = new Map<string, RunEntry>();
  private readonly origins: Set<string>;
  private readonly config: BrowserConfig;
  constructor(input: unknown) {
    this.config = BrowserConfigSchema.parse(input);
    this.origins = originsOf(this.config.allowedOrigins);
  }
  /** Shared network policy; when set, navigation is checked against it as well as the origin list. */
  policy: { assertAllowed(target: URL, what?: string): Promise<void> } | undefined;
  /** Saved sign-ins, encrypted beside the private database. */
  profiles: BrowserProfiles | undefined;
  /** Where screenshots and saved pages are kept. */
  artifacts: RunArtifacts | undefined;
  /** The workspace, for files sent to a website and files a website sends back. */
  files: WorkspacePaths | undefined;
  /** Where a task's steps are written down, so a healed action can say which way worked. */
  tracer: BrowserTracer | undefined;
  /** The settings store, so "let Branch use my browser" can be read again before every attach. */
  store: Store | undefined;
  /** Opens a connection to the owner's own browser. Replaced in tests by one they start themselves. */
  connect: typeof attach = attach;

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
  private entry(context: ToolContext): RunEntry {
    if (this.closed) throw new Error('Browser is closed');
    const key = this.key(context), existing = this.sessions.get(key);
    if (existing) return existing;
    if (this.sessions.size >= this.config.maxRuns) throw new Error('Browser active run limit reached');
    const session = new BrowserSession(() => this.starting ??= this.launch(), route => this.route(route));
    session.options.saveDownload = download => this.saveDownload(download);
    const cancel = () => { void this.closeRun(context).catch(() => undefined); };
    context.signal.addEventListener('abort', cancel, { once: true });
    const created: RunEntry = { session, origins: new Set(), actions: 0, host: '', profile: null,
      marks: new MarkRegistry(), borrowed: null,
      detach: () => context.signal.removeEventListener('abort', cancel) };
    this.sessions.set(key, created);
    return created;
  }
  private async operation<T extends object>(context: ToolContext, action: (page: Page) => Promise<T>, graceMs = 0): Promise<T> {
    context.signal.throwIfAborted();
    const entry = this.entry(context);
    if (++entry.actions > this.config.maxActionsPerRun) throw new Error(actionStop(this.config.maxActionsPerRun));
    try {
      const result = await entry.session.use(context, action, graceMs);
      const events = entry.session.takeEvents();
      return { ...result, ...(events.dialogs.length ? { messageBoxes: events.dialogs } : {}),
        ...(events.downloads.length ? { downloads: events.downloads } : {}) };
    } finally { if (context.signal.aborted) await this.closeRun(context); }
  }
  async navigate(url: string, context: ToolContext) {
    if (!this.allowed(url) || new URL(url).username || new URL(url).password)
      throw new Error('Browser destination is not an allowed origin');
    await this.policy?.assertAllowed(new URL(url), 'browser address');
    const entry = this.entry(context), origin = new URL(url).origin;
    // In the owner's own browser the refusals that keep the screen control away from banks and
    // password managers apply to website names too.
    const refused = entry.borrowed ? attachedAddressRefusal(url) : null;
    if (refused) throw new Error(refused);
    if (!entry.origins.has(origin) && entry.origins.size >= this.config.maxOriginsPerRun)
      throw new Error(originStop(this.config.maxOriginsPerRun));
    return this.operation(context, async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Counted only once the page really opened, so a refused address costs the task nothing.
      entry.origins.add(origin);
      entry.host = new URL(url).host;
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
    }, 500);
  }
  async fill(label: string, value: string, context: ToolContext) {
    return this.operation(context, async page => {
      const locator = page.getByLabel(label, { exact: true });
      if ((await locator.getAttribute('type'))?.trim().toLowerCase() === 'password')
        throw new Error('Password fields require a dedicated credential integration');
      await locator.fill(value); return { filled: label };
    });
  }
  /** A picture of the page, kept beside the private database; password boxes are blacked out first. */
  async screenshot(options: z.infer<typeof ScreenshotSchema>, context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Screenshots are switched off because there is nowhere to keep the picture');
    return this.operation(context, async page => {
      const bytes = await screenshot(page, options);
      const kept = await artifacts.write(context.runId, `screenshot-${randomUUID().slice(0, 8)}.png`, 'image/png', bytes);
      return { ...kept, url: page.url() };
    });
  }
  /** The page as a PDF, kept the same way a screenshot is. */
  async pdf(context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Saving a page is switched off because there is nowhere to keep the file');
    return this.operation(context, async page => {
      const bytes = await page.pdf({ printBackground: true });
      const kept = await artifacts.write(context.runId, `page-${randomUUID().slice(0, 8)}.pdf`, 'application/pdf', bytes);
      return { ...kept, url: page.url() };
    });
  }
  async wait(options: z.infer<typeof WaitSchema>, context: ToolContext) {
    return this.operation(context, page => waitFor(page, options));
  }
  async extract(options: z.infer<typeof ExtractSchema>, context: ToolContext) {
    return this.operation(context, page => extract(page, options));
  }
  /** Data in the exact shape the assistant asked for, or a refusal naming the field that did not fit. */
  async extractShaped(options: z.infer<typeof ExtractSchemaSchema>, context: ToolContext) {
    return this.operation(context, page => extractSchema(page, options));
  }
  /**
   * Numbers everything on the page that can be pressed or typed into and hands back the list. The
   * numbers belong to the things themselves, so they survive the page redrawing itself.
   */
  async annotate(options: z.infer<typeof AnnotateSchema>, context: ToolContext) {
    const entry = this.entry(context);
    return this.operation(context, async page => {
      const found = await annotate(page, options, entry.marks);
      return { url: found.url, map: found.map, numbered: found.marks.length, truncated: found.truncated,
        marks: found.marks.map(mark => ({ id: mark.id, role: mark.role, name: mark.name })) };
    });
  }
  /** Takes the numbered labels off the page again. */
  async clearMarks(context: ToolContext) {
    return this.operation(context, async page => { await clearMarks(page); return { cleared: true, url: page.url() }; });
  }
  /**
   * Presses or types into a thing, trying several ways of finding it before giving up: the
   * selector given, what it is called, the words on it, then its number. The way that worked is
   * written into the task's trace.
   */
  async act(input: HealTarget & { action: 'click' | 'fill' | 'check'; value?: string | undefined }, context: ToolContext) {
    const entry = this.entry(context);
    return this.operation(context, async page => {
      const found = await healResolve(page, input);
      if (input.action === 'fill') {
        if ((await found.locator.getAttribute('type'))?.trim().toLowerCase() === 'password')
          throw new Error('Password fields require a dedicated credential integration');
        await found.locator.fill(input.value ?? '');
      } else if (input.action === 'check') await found.locator.check();
      else await found.locator.click();
      this.noteHealing(context, entry, input.action, found.way, found.attempts);
      return { url: page.url(), action: input.action, foundBy: found.way, attempts: found.attempts, tried: found.tried };
    }, input.action === 'click' ? 500 : 0);
  }
  /** Writes down which way of finding the thing worked, so a step that keeps healing can be fixed. */
  private noteHealing(context: ToolContext, entry: RunEntry, action: string, way: string, attempts: number): void {
    const span = this.tracer?.start(context.runId, 'tool', `browser.act ${action}`,
      { host: entry.host, foundBy: way, attempts });
    span?.end('ok', '', { foundBy: way, attempts, healed: way !== 'selector' });
  }
  /** Sends one file from the person's workspace to a file box on the page. */
  async upload(selector: string, path: string, context: ToolContext) {
    if (!this.files) throw new Error('Sending a file to a website needs the workspace');
    const target = await this.files.checked(path);
    return this.operation(context, async page => {
      await page.locator(selector).first().setInputFiles(target);
      return { uploaded: path, selector };
    });
  }
  /**
   * Borrows the browser the owner already has open, so websites that know them stay signed in.
   * Only for this task, only when they turned it on for this task, and let go of at the end.
   */
  async borrow(context: ToolContext) {
    if (!this.store) throw new Error('Using your own browser is switched off for this launch');
    const settings = readAttachSettings(this.store, context.owner);
    const refused = attachRefusal(settings, context.runId);
    if (refused) throw new Error(refused);
    const entry = this.entry(context);
    if (entry.borrowed) return this.borrowedReport(entry);
    // A recording takes pictures of every tab in the window, so it must never be your own window.
    // Checked before the window question, because it is the more useful thing to be told.
    if (entry.session.isRecording())
      throw new Error('This task is keeping a recording, which would photograph your own tabs as well. Keep the recording first, then ask for your browser.');
    if (entry.session.started())
      throw new Error('Ask for your own browser before opening a page: this task already has a browser window of its own');
    const attached = await this.connect(settings.port);
    // A switch turned on without a task named is tied to the first task that uses it, so the next
    // one has to ask again rather than inheriting a permission it was never given.
    if (!settings.runId) saveAttachSettings(this.store, context.owner, { runId: context.runId });
    entry.borrowed = attached;
    entry.session.options.attached = { context: attached.context, detach: () => attached.detach() };
    // Every request Branch's own tab makes is checked, not only the addresses it is asked to open.
    entry.session.options.guardUrl = url => attachedAddressRefusal(url);
    return this.borrowedReport(entry);
  }
  private borrowedReport(entry: RunEntry) {
    const attached = entry.borrowed!;
    return { using: 'your own browser', version: attached.version, yourTabsOpen: attached.existingPages,
      note: 'Branch works in its own new tab and closes only that one. Banks and password sites are refused.' };
  }
  /** Gives the owner's browser back. Nothing of theirs is closed; Branch only stops listening. */
  async giveBack(context: ToolContext) {
    const entry = this.sessions.get(this.key(context));
    if (!entry?.borrowed) return { released: false };
    await this.closeRun(context);
    return { released: true };
  }
  /** Starts keeping a recording of this task's browser window. */
  async startRecording(context: ToolContext) {
    const entry = this.entry(context);
    // A recording photographs every tab in the window it is made in, so it is never made in the
    // owner's own window: their other tabs are none of Branch's business.
    if (entry.borrowed)
      throw new Error('This task is working in your own browser, so a recording would photograph your other tabs too. Give your browser back first, then start a recording.');
    await entry.session.record(startRecording);
    entry.session.options.beforeAction = page => clearPasswordValues(page);
    return { recording: true,
      note: 'Pictures of each step are kept; the page\'s own markup is not, and password boxes are emptied before every step, so no password can get into the file.' };
  }
  /** Ends the recording and keeps it beside the task's other files. */
  async keepRecording(context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Recordings are switched off because there is nowhere to keep the file');
    const entry = this.entry(context);
    const bytes = await entry.session.keepRecording();
    entry.session.options.beforeAction = undefined;
    const kept = await artifacts.write(context.runId, `browser-recording-${randomUUID().slice(0, 8)}.zip`,
      'application/zip', bytes);
    return { ...kept, note: 'Open this in Playwright\'s trace viewer to watch what the browser did.' };
  }
  async tab(action: 'list' | 'open' | 'select' | 'close', index: number | undefined, context: ToolContext) {
    const entry = this.entry(context), session = entry.session;
    if (++entry.actions > this.config.maxActionsPerRun) throw new Error(actionStop(this.config.maxActionsPerRun));
    if (action === 'open') await session.openTab();
    else if (action === 'select') session.selectTab(requireIndex(index));
    else if (action === 'close') await session.closeTab(requireIndex(index));
    return { tabs: session.tabs() };
  }
  /** Chooses which saved sign-in this task's browser window uses; it must be asked for before a page opens. */
  async useProfile(name: string, context: ToolContext) {
    const profiles = this.requireProfiles();
    const state = await profiles.load(context.owner, name);
    if (!state) throw new Error(`There is no saved sign-in called "${name}"`);
    const entry = this.entry(context);
    if (entry.session.started())
      throw new Error('Choose the saved sign-in before opening a page: this task already has a browser window open');
    entry.session.options.storageState = state;
    entry.profile = name;
    return { using: name, cookies: state.cookies.length, sites: state.origins.length };
  }
  private requireProfiles(): BrowserProfiles {
    if (!this.profiles) throw new Error('Saved sign-ins are switched off for this launch');
    return this.profiles;
  }
  async profileAction(action: 'list' | 'create' | 'remove' | 'use', name: string | undefined, context: ToolContext) {
    const profiles = this.requireProfiles();
    if (action === 'list') return { profiles: await profiles.list(context.owner) };
    const chosen = profileNameSchema.parse(name ?? '');
    if (action === 'create') return { created: await profiles.create(context.owner, chosen) };
    if (action === 'remove') return { removed: await profiles.remove(context.owner, chosen), name: chosen };
    return this.useProfile(chosen, context);
  }
  /**
   * The owner signs in by hand in a window they can see; only the cookies that keep them signed in
   * are saved. Nothing about this passes through the assistant, so it never sees the password.
   */
  async signIn(owner: string, name: string, url: string, timeoutMs = 300000): Promise<{ name: string; cookies: number; sites: number }> {
    const profiles = this.requireProfiles();
    profileNameSchema.parse(name);
    if (!this.allowed(url)) throw new Error('That website is not one the browser is allowed to open');
    await this.policy?.assertAllowed(new URL(url), 'browser address');
    const browser = await chromium.launch({ headless: false, ...(this.config.channel ? { channel: this.config.channel } : {}) });
    try {
      const context = await browser.newContext(), page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await Promise.race([page.waitForEvent('close', { timeout: timeoutMs }).catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, timeoutMs))]);
      const state = (await context.storageState()) as unknown as StorageState;
      const saved = await profiles.save(owner, name, state);
      return { name: saved.name, cookies: saved.cookies, sites: saved.sites };
    } finally { await browser.close().catch(() => undefined); }
  }
  /** Saves a file a website sent into the workspace's downloads folder, within the size and type limits. */
  private async saveDownload(download: Download): Promise<DownloadRecord> {
    if (!this.files) throw new Error('saving files from websites needs the workspace');
    const name = safeDownloadName(download.suggestedFilename());
    const ending = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!this.config.downloadTypes.includes(ending))
      throw new Error(`files ending in .${ending || '(nothing)'} are not saved`);
    // Two files arriving at once can pick the same free name, so a taken name is tried again once.
    for (let attempt = 0; ; attempt++) {
      const relative = await this.freeName(name);
      const target = await this.files.checked(relative);
      await mkdir(dirname(target), { recursive: true });
      try { return await this.stream(download, target, relative); }
      catch (error) {
        if (attempt > 0 || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  private async stream(download: Download, target: string, relative: string): Promise<DownloadRecord> {
    const handle = await open(target, 'wx');
    const limit = this.config.maxDownloadBytes;
    let bytes = 0;
    try {
      const source = await download.createReadStream();
      for await (const chunk of source as AsyncIterable<Buffer>) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error(`the file is larger than ${Math.round(limit / 1048576)} MB`);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
      throw error;
    }
    await handle.close();
    return { file: relative, bytes, from: download.url().slice(0, 300) };
  }
  /** A name inside the downloads folder that is not taken yet. */
  private async freeName(name: string): Promise<string> {
    const stop = name.lastIndexOf('.'), stem = stop > 0 ? name.slice(0, stop) : name, ending = stop > 0 ? name.slice(stop) : '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = `${downloadFolder}/${stem}${attempt ? `-${attempt}` : ''}${ending}`;
      const full = await this.files!.checked(candidate);
      if (!(await stat(full).catch(() => null))) return candidate;
    }
    throw new Error('too many files with that name are already saved');
  }
  /** The website the run's page is on, so the approval policy can match on it. */
  hostFor(context: Pick<ToolContext, 'owner' | 'runId'>): string {
    try { return this.sessions.get(this.key(context))?.host ?? ''; } catch { return ''; }
  }
  /**
   * Gives every borrowed browser back at once, without stopping anything else. Used when Branch
   * locks itself: a locked Branch must not still be holding the door to a signed-in browser open.
   * Only the owner's own windows are let go of; a task using a browser of Branch's own carries on.
   */
  async releaseBorrowed(): Promise<number> {
    const borrowed = [...this.sessions].filter(([, entry]) => !!entry.borrowed);
    for (const [key, entry] of borrowed) {
      entry.detach();
      await entry.session.close().catch(() => undefined);
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    }
    return borrowed.length;
  }
  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const key = this.key(context), entry = this.sessions.get(key);
    if (!entry) return;
    entry.detach();
    await this.keepSignIn(context.owner, entry);
    await entry.session.close();
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }
  /** A run that used a saved sign-in writes what it learned back, so the person stays signed in. */
  private async keepSignIn(owner: string, entry: RunEntry): Promise<void> {
    if (!entry.profile || !this.profiles || !entry.session.started()) return;
    try {
      const state = await entry.session.storageState();
      if (state) await this.profiles.save(owner, entry.profile, state);
    } catch { /* a sign-in that could not be refreshed is never worth failing a task for */ }
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
function requireIndex(index: number | undefined): number {
  if (index === undefined) throw new Error('Say which tab, by its number');
  return index;
}

export function registerBrowser(registry: ToolRegistry, browser: BranchBrowser): void {
  registry.onRunFinished(context => browser.closeRun(context));
  const host = (_a: unknown, c: ToolContext) => browser.hostFor(c);
  registry.register({ name: 'browser.navigate', permission: 'browser.read',
    description: 'Open a configured origin in an isolated browser.',
    parameters: z.object({ url: z.string().url().max(2000) }).strict(), execute: (a, c) => browser.navigate(a.url, c) });
  registry.register({ name: 'browser.snapshot', permission: 'browser.read',
    description: 'Read a bounded accessibility snapshot of the current page as untrusted content.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.snapshot(c) });
  registry.register({ name: 'browser.click', permission: 'browser.interact',
    description: 'Click a uniquely named button or link. This may submit data or perform an external action.',
    parameters: z.object({ role: z.enum(['button', 'link']), name: z.string().min(1).max(300) }).strict(),
    execute: (a, c) => browser.click(a.role, a.name, c), target: host });
  registry.register({ name: 'browser.fill', permission: 'browser.interact',
    description: 'Fill a non-password field by its exact visible label.',
    parameters: z.object({ label: z.string().min(1).max(300), value: z.string().max(4000) }).strict(),
    execute: (a, c) => browser.fill(a.label, a.value, c), target: host });
  registerBrowserExtras(registry, browser, host);
}

/** The rest of the browser tools: pictures, waiting, pulling out rows, files and tabs. */
function registerBrowserExtras(registry: ToolRegistry, browser: BranchBrowser,
  host: (a: unknown, c: ToolContext) => string): void {
  registry.register({ name: 'browser.screenshot', permission: 'browser.read',
    description: 'Take a picture of the current page. Password boxes are blacked out before the picture is taken. Use this when the page is visual and the text snapshot is not enough.',
    parameters: ScreenshotSchema, execute: (a, c) => browser.screenshot(a, c) });
  registry.register({ name: 'browser.pdf', permission: 'browser.read',
    description: 'Save the current page as a PDF file.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.pdf(c) });
  registry.register({ name: 'browser.wait', permission: 'browser.read',
    description: 'Wait for some words or an element to appear, or for the page to stop loading things.',
    parameters: WaitSchema, execute: (a, c) => browser.wait(a, c) });
  registry.register({ name: 'browser.extract', permission: 'browser.read',
    description: 'Pull rows out of a table or a repeated block of cards as untrusted data. Give the selector for one row, and optionally a name for each column.',
    parameters: ExtractSchema, execute: (a, c) => browser.extract(a, c) });
  registry.register({ name: 'browser.upload', permission: 'browser.interact',
    description: 'Send one file from the workspace to a file box on the page. This shares the file with the website.',
    parameters: z.object({ selector: z.string().min(1).max(300), path: z.string().min(1).max(500) }).strict(),
    execute: (a, c) => browser.upload(a.selector, a.path, c), target: host });
  registry.register({ name: 'browser.tab', permission: 'browser.interact',
    description: 'List the tabs of this task, open another one, switch to one, or close one.',
    parameters: z.object({ action: z.enum(['list', 'open', 'select', 'close']),
      index: z.number().int().min(0).max(9).optional() }).strict(),
    execute: (a, c) => browser.tab(a.action, a.index, c), target: host });
  registerBrowserSecondPass(registry, browser, host);
  registry.register({ name: 'browser.profile', permission: 'browser.interact',
    description: 'Saved sign-ins: list them, make an empty one, remove one, or use one for this task so the website already knows the person. The person signs in by hand in Settings; you never see their password.',
    parameters: z.object({ action: z.enum(['list', 'create', 'remove', 'use']),
      name: z.string().min(1).max(40).optional() }).strict(),
    execute: (a, c) => browser.profileAction(a.action, a.name, c) });
}

/**
 * The second pass of browser tools: describing a page by numbering the things on it, pulling data
 * out in a named shape, acting on something several different ways before giving up, borrowing the
 * owner's own browser, and keeping a recording of what happened.
 */
function registerBrowserSecondPass(registry: ToolRegistry, browser: BranchBrowser,
  host: (a: unknown, c: ToolContext) => string): void {
  registry.register({ name: 'browser.annotate', permission: 'browser.read',
    description: 'Number everything on the page you can press or type into and list them, so you can say "press 3" instead of guessing at a selector. A number stays with the same thing while the task lasts.',
    parameters: AnnotateSchema, execute: (a, c) => browser.annotate(a, c) });
  registry.register({ name: 'browser.unmark', permission: 'browser.read',
    description: 'Take the numbered labels off the page again, so a picture shows it the way the website meant it.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.clearMarks(c) });
  registry.register({ name: 'browser.shape', permission: 'browser.read',
    description: 'Pull data off the page in the exact shape you name: a field list, each with where to read it and whether it is words, a number, a yes/no, a date or an address. Anything that does not fit is refused by name rather than guessed at.',
    parameters: ExtractSchemaSchema, execute: (a, c) => browser.extractShaped(a, c) });
  registry.register({ name: 'browser.act', permission: 'browser.interact',
    description: 'Press, type into or tick something, found by selector, by name, by the words on it, or by its number from browser.annotate. Several ways are tried before it gives up. This may submit data or perform an external action.',
    parameters: z.object({ action: z.enum(['click', 'fill', 'check']),
      selector: z.string().min(1).max(300).optional(), name: z.string().min(1).max(300).optional(),
      mark: z.number().int().min(1).max(500).optional(), value: z.string().max(4000).optional() }).strict(),
    execute: (a, c) => browser.act(a, c), target: host });
  registry.register({ name: 'browser.borrow', permission: 'browser.interact',
    description: 'Work in the browser the person already has open, so websites they are signed in to know them. Only when they turned this on for this task in Settings. Banks and password sites are always refused, and their own tabs are never touched.',
    parameters: z.object({ action: z.enum(['borrow', 'give back']) }).strict(),
    execute: (a, c) => a.action === 'borrow' ? browser.borrow(c) : browser.giveBack(c), target: host });
  registry.register({ name: 'browser.recording', permission: 'browser.read',
    description: 'Keep a recording of what the browser does in this task, to look at afterwards. Start it, then keep it when the work is done.',
    parameters: z.object({ action: z.enum(['start', 'keep']) }).strict(),
    execute: (a, c) => a.action === 'start' ? browser.startRecording(c) : browser.keepRecording(c) });
}
