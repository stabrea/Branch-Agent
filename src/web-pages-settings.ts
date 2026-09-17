import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";

/**
 * w911 (A0743, A1452): the switch for reading whole web pages (`web.page`) and following a site's
 * own links (`web.crawl`). It ships off.
 */
export const WebPagesSchema = z.object({
  /** The three-way switch. Off until the owner turns it on. */
  mode: FeatureModeSchema.default("off"),
  /** The pause between two pages of one crawl, in milliseconds, so a site is not hammered. */
  crawlDelayMs: z.number().int().min(250).max(10000).default(1000),
}).strict();
export type WebPagesSettings = z.infer<typeof WebPagesSchema>;

export const webPagesSettingsKey = "web-pages";
export function readWebPagesSettings(store: Pick<Store, "get">, owner: string): WebPagesSettings {
  const saved = WebPagesSchema.safeParse(store.get("settings", owner, webPagesSettingsKey)?.data ?? {});
  return saved.success ? saved.data : WebPagesSchema.parse({});
}
export function saveWebPagesSettings(store: Store, owner: string, input: unknown): WebPagesSettings {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const value = WebPagesSchema.parse({ ...readWebPagesSettings(store, owner), ...given });
  store.save("settings", owner, webPagesSettingsKey, value);
  return value;
}
export const webPagesMode = (store: Pick<Store, "get">, owner: string): FeatureMode =>
  readWebPagesSettings(store, owner).mode;

/** The one sentence both tools say while the switch is off. */
export const webPagesOff =
  "Reading whole web pages and following their links is switched off; the owner can turn it on with the web-pages setting.";

/** The tools this switch owns. */
export const webPageToolNames = ["web.page", "web.crawl"] as const;
