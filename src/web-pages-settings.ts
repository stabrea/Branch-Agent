import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";

/**
 * Settings for web page fetching and crawling. The three-way switch ships off.
 * Routes: `plain` (HTTP fetch with readable-text extraction), `browser` (headless Playwright),
 * `auto` (plain first, fall back to browser if text is nearly empty).
 */
export const WebPagesSchema = z.object({
  /** The three-way switch. Off until the owner turns it on. */
  mode: FeatureModeSchema.default("off"),
  /** Default route for web.page: plain, browser, or auto. */
  defaultRoute: z.enum(["plain", "browser", "auto"]).default("auto"),
  /** Maximum pages to fetch in one web.crawl call. */
  maxPagesPerCrawl: z.number().int().min(1).max(50).default(10),
  /** Maximum depth for web.crawl (0 = current page only, 1 = one level of links, etc). */
  maxCrawlDepth: z.number().int().min(0).max(3).default(1),
  /** Delay between crawl requests in milliseconds, to be polite. */
  crawlDelayMs: z.number().int().min(0).max(10000).default(500),
}).strict();
export type WebPages = z.infer<typeof WebPagesSchema>;

const settingsKey = "web-pages";
export function readWebPagesSettings(store: Pick<Store, "get">, owner: string): WebPages {
  const saved = WebPagesSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : WebPagesSchema.parse({});
}
export function saveWebPagesSettings(store: Store, owner: string, input: unknown): WebPages {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const value = WebPagesSchema.parse({ ...readWebPagesSettings(store, owner), ...given });
  store.save("settings", owner, settingsKey, value);
  return value;
}
export const webPagesMode = (store: Pick<Store, "get">, owner: string): FeatureMode =>
  readWebPagesSettings(store, owner).mode;

/** The one sentence both web tools say while the switch is off. */
export const webPagesOff =
  "Reading and crawling web pages is switched off. Turn it on under Settings → Computer → Web access.";
