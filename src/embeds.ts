import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Two ways of reaching Branch from outside its own page: a small script the owner can put on a page
 * of their own, and an unsigned browser extension that sends the page they are looking at to Branch
 * as a task. Both are off until the owner switches them on, and both are for the owner's own pages
 * and the owner's own browser — not for publishing anywhere.
 *
 * The rule that makes them safe is the same for both: they may only talk to the **paired remote
 * listener**, which the owner turned on and paired a device with, carrying the key that pairing
 * gave them. They must never carry the key the app's own page on this computer uses, and they must
 * never be pointed at a loopback address: that key is the whole of the app's authority on this
 * machine, and a page of the owner's own should not be able to borrow it by being opened next door.
 */
export const EmbedSettingsSchema = z.object({
  /** The small script for a page of the owner's own. Off until they say otherwise. */
  widget: z.boolean().default(false),
  /** The unsigned browser extension. Off until they say otherwise. */
  extension: z.boolean().default(false),
  /**
   * The websites of the owner's own that may carry the widget, written the way a browser writes an
   * origin ("https://notes.example.com"). Empty means none: the pairing key is not enough on its
   * own, because any page that got hold of it could otherwise spend it.
   */
  widgetSites: z.array(z.string().max(255)).max(20).default([]),
}).strict();
export type EmbedSettings = z.infer<typeof EmbedSettingsSchema>;
const settingsKey = "embeds";

export function embedSettings(store: Store, owner: string): EmbedSettings {
  const saved = EmbedSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : EmbedSettingsSchema.parse({});
}
export function saveEmbedSettings(store: Store, owner: string, input: unknown): EmbedSettings {
  const value = EmbedSettingsSchema.parse({ ...embedSettings(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, value);
  return value;
}

/**
 * Whether an address is this computer talking to itself. Both the widget and the extension refuse
 * one: the paired listener has a Tailscale address, and that is the only place they may go.
 */
export function isLoopback(origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
  /* 127.0.0.0/8 is all loopback, not only 127.0.0.1. */
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The routes behind the two switches. Returns null for any path that is not one of them. */
export async function embedsApi(
  store: Store, owner: string, request: { method?: string | undefined }, path: string,
  body: () => Promise<unknown>,
): Promise<unknown | null> {
  if (path !== "/api/embeds") return null;
  return (request.method ?? "GET") === "POST"
    ? saveEmbedSettings(store, owner, await body()) : embedSettings(store, owner);
}

/** An origin written the way a browser writes one, for comparing two of them fairly. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const one = new URL(a), two = new URL(b);
    return one.protocol === two.protocol && one.hostname.toLowerCase() === two.hostname.toLowerCase()
      && one.port === two.port;
  } catch { return false; }
}

/**
 * The origin to name back to a browser asking on the widget's behalf, or null to say nothing at all.
 * The exact origin is named, never a star: a star would let any page that had got hold of the
 * pairing key spend it. A page served from this computer is refused for the reason in the note at
 * the top of this file.
 */
export function widgetOrigin(settings: EmbedSettings, origin: string | undefined | string[]): string | null {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!settings.widget || !value || value === "null" || isLoopback(value)) return null;
  return settings.widgetSites.some((site) => sameOrigin(site, value)) ? value : null;
}
