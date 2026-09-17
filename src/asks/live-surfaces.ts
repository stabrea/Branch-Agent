import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { appHeaders, appPage, mcpAppIn } from "../mcp-apps.js";
import type { Store } from "../store.js";
import { askMode, partSettings, requireAsk } from "./settings.js";

/**
 * A2240: live embedded app surfaces. A page a tool answers with (an MCP app, or a tool's plain
 * answer drawn as a page) can be pinned, and Branch asks the tool again on a timer so the page stays
 * up to date — a build status, a dashboard, a queue. The page is shown in the same sealed frame an
 * MCP app gets (no script, no form, nothing fetched), and the frame reloads itself with the
 * browser's own Refresh header, so nothing in the page needs to run.
 *
 * Asking the tool again goes through the one tool gate as work that runs by itself: only a call the
 * owner's rules allow outright is made. A call that would need a yes, or that is refused, leaves the
 * last page in place with the reason beside it. The frame's address is a long random name of its own,
 * because a frame cannot carry the session key; a new name is made when the surface is made again.
 */
export const SurfaceSchema = z.object({
  title: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  everySeconds: z.number().int().min(30).max(86400).default(300),
}).strict();

export interface Surface extends z.infer<typeof SurfaceSchema> {
  id: string; page: string; html: string; updatedAt: string | null; error: string | null; dueAt: number;
  /** Failed asks in a row, which stretch the wait before the next one; and when refresh was last pressed. */
  failures: number; pressedAt: number;
}
const SavedSchema = z.object({ surfaces: z.array(z.object({ id: z.string(), page: z.string() }).merge(SurfaceSchema)).max(12).default([]) }).strict();
const savedKey = "asks-live-surfaces-list";
/** A failing page waits its interval times 2, 4, 8 … up to 64, and never more than a day. */
const maxBackoff = 6, maxWaitMs = 86_400_000;
/** Refresh pressed by hand again within this long of the last press asks nothing. */
export const manualGapMs = 10_000;
export const surfacePath = /^\/asks-surface\/([A-Za-z0-9_-]{32,48})$/;

const escape = (value: string): string => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** A tool's answer as a page: its MCP app when it sent one, otherwise its words, shown as text. */
export function surfaceHtml(result: unknown): string {
  const app = mcpAppIn(result);
  if (app) return app.html;
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return `<pre style="white-space:pre-wrap;word-break:break-word">${escape(String(text).slice(0, 100_000))}</pre>`;
}

export class LiveSurfaces {
  private readonly live = new Map<string, Surface>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  /** r17-h integration review: a check a page's tool must pass each time it is asked (a widget looks only). */
  private guard: ((surfaceId: string, tool: string) => string | null) | undefined;
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly runTool: (name: string, args: unknown, surfaceId: string) => Promise<unknown>,
    private readonly now: () => number = Date.now) {
    for (const saved of partSettings(store, owner, savedKey, SavedSchema).surfaces)
      this.live.set(saved.id, { ...saved, html: "", updatedAt: null, error: null, dueAt: 0, failures: 0, pressedAt: -Infinity });
  }
  setGuard(guard: (surfaceId: string, tool: string) => string | null): void { this.guard = guard; }
  private persist(): void {
    this.store.save("settings", this.owner, savedKey, { surfaces: [...this.live.values()].map(({ id, page, title, tool, args, everySeconds }) => ({ id, page, title, tool, args, everySeconds })) });
  }
  list(): Omit<Surface, "html" | "dueAt" | "failures" | "pressedAt">[] {
    return [...this.live.values()].map(({ html: _html, dueAt: _due, failures: _failures, pressedAt: _pressed, ...rest }) => rest);
  }
  async add(input: unknown): Promise<Omit<Surface, "html" | "dueAt" | "failures" | "pressedAt">> {
    requireAsk(this.store, this.owner, "live-surfaces");
    if (this.live.size >= 12) throw new Error("At most twelve live pages can be kept");
    const surface: Surface = { ...SurfaceSchema.parse(input), id: randomUUID(), page: randomBytes(24).toString("base64url"),
      html: "", updatedAt: null, error: null, dueAt: 0, failures: 0, pressedAt: -Infinity };
    this.live.set(surface.id, surface);
    this.persist();
    await this.refresh(surface.id);
    return this.list().find((s) => s.id === surface.id)!;
  }
  remove(id: string): { removed: boolean } {
    const removed = this.live.delete(id);
    this.persist();
    return { removed };
  }
  /**
   * Asks the tool again now. A refusal keeps the last page and says why, and each failure in a row
   * doubles the wait before the beat asks again. Pressed by hand (`manual`), a second press within
   * ten seconds of the last press asks nothing, so a held-down button cannot run the tool in a loop.
   */
  async refresh(id: string, options: { manual?: boolean } = {}): Promise<void> {
    const surface = this.live.get(id);
    if (!surface) throw new Error("That live page was not found");
    const started = this.now();
    if (options.manual) {
      if (started - surface.pressedAt < manualGapMs) return;
      surface.pressedAt = started;
    }
    try {
      const refused = this.guard?.(surface.id, surface.tool);
      if (refused) throw new Error(refused);
      surface.html = surfaceHtml(await this.runTool(surface.tool, surface.args, surface.id));
      surface.updatedAt = new Date(this.now()).toISOString();
      surface.error = null;
      surface.failures = 0;
    } catch (error) {
      surface.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      surface.failures = Math.min(surface.failures + 1, maxBackoff);
    }
    surface.dueAt = started + Math.min(surface.everySeconds * 1000 * 2 ** surface.failures, maxWaitMs);
  }
  /** One beat: every surface that is due is asked again, one at a time; a beat never overlaps another. */
  async tick(): Promise<number> {
    if (this.ticking || askMode(this.store, this.owner, "live-surfaces") === "off") return 0;
    this.ticking = true;
    let refreshed = 0;
    try {
      for (const surface of [...this.live.values()]) {
        if (surface.dueAt > this.now() || !this.live.has(surface.id)) continue;
        await this.refresh(surface.id);
        refreshed++;
      }
    } finally { this.ticking = false; }
    return refreshed;
  }
  start(everyMs = 15000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** Whether the beat is running, for the owner's screen and the tests. */
  get running(): boolean { return this.timer !== undefined; }

  /** The sealed page for a frame, answered before the session key is asked for. */
  serve(request: IncomingMessage, response: ServerResponse, path: string): boolean {
    const match = surfacePath.exec(path);
    if (!match || request.method !== "GET") return false;
    const surface = [...this.live.values()].find((s) => s.page === match[1]);
    if (!surface || askMode(this.store, this.owner, "live-surfaces") === "off") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "That live page is not there any more." }));
      return true;
    }
    const note = surface.error ? `<p style="border:1px solid;padding:.5rem">Not refreshed: ${escape(surface.error)}</p>` : "";
    const page = appPage({ server: surface.title, uri: surface.updatedAt ? `updated ${surface.updatedAt}` : "not loaded yet", html: note + surface.html });
    response.writeHead(200, { ...appHeaders(), refresh: String(Math.min(surface.everySeconds, 3600)) });
    response.end(page.body);
    return true;
  }
}
