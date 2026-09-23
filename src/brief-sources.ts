import { fetchChecked, type PageFetchDeps } from "./web-page-fetch.js";

/**
 * R17-fq (packages: morning-brief news and health): the two extra kinds of line the morning brief
 * can carry, each with its own source link so nothing in the brief is unsourced.
 *
 * News comes from the owner's own RSS/Atom feed addresses, read through the same checked fetch
 * (`fetchChecked`, from web-page-fetch.ts) that `web.page` uses — no separate HTTP client, and every
 * address still goes through the owner's network rules and redirect limit first.
 *
 * Health has no local integration to read from yet (grepped for HealthKit/Fitbit/Garmin/step-count
 * style code and found none in this codebase). Rather than invent one, this file only defines the
 * shape a future local health source would fill in (`HealthSource`); with nothing wired up, the
 * brief says plainly that no health source is connected instead of showing invented data.
 */
export interface BriefItem {
  title: string;
  link: string;
  source: string;
}

/** Only http/https links belong in the brief; javascript:, data: and the like are dropped. */
export function isSafeLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, _all, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return namedEntities[String(name).toLowerCase()] ?? whole;
  });
}

/** The text of the first `<tag>...</tag>` in a block, CDATA and entities unwrapped, or null. */
function firstTagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  if (!match) return null;
  const inner = match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeEntities(inner).trim();
}

/** Atom's `<link href="...">` carries the address as an attribute, not as element text. */
function atomLinkHref(block: string): string | null {
  const match = /<link\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/?>/i.exec(block);
  const href = match ? (match[1] ?? match[2] ?? "") : null;
  return href ? decodeEntities(href).trim() : null;
}

/**
 * A small, safe reader for RSS 2.0 `<item>` and Atom `<entry>` blocks. It reads title and link only
 * and never interprets the feed as anything runnable; a block missing a usable title or a safe link
 * is skipped rather than thrown on, since a feed the owner did not write is not shaped by Branch.
 */
export function parseFeedItems(xml: string, source: string, limit = 8): BriefItem[] {
  const items: BriefItem[] = [];
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi), ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  for (const block of blocks) {
    const body = block[1] ?? "";
    const title = firstTagText(body, "title");
    const link = firstTagText(body, "link") || atomLinkHref(body);
    if (!title || !link || !isSafeLink(link)) continue;
    items.push({ title, link, source });
    if (items.length >= limit) break;
  }
  return items;
}

export interface NewsFeed {
  url: string;
  /** Shown as the item's source; defaults to the feed's own hostname. */
  name?: string;
}

/**
 * Reads the owner's own feed addresses through the app's checked fetch path and parses whatever
 * comes back. One broken feed is left out rather than failing the whole brief.
 */
export async function fetchNewsItems(deps: PageFetchDeps, feeds: readonly NewsFeed[], signal: AbortSignal, perFeed = 5): Promise<BriefItem[]> {
  const items: BriefItem[] = [];
  for (const feed of feeds) {
    try {
      const page = await fetchChecked(deps, feed.url, signal);
      if (page.status < 200 || page.status > 299 || !page.body) continue;
      const name = feed.name ?? new URL(feed.url).hostname;
      items.push(...parseFeedItems(page.body, name, perFeed));
    } catch {
      // A feed that fails to load or to parse is left out; the brief still runs with the rest.
    }
  }
  return items;
}

/**
 * Where the brief's health line would come from, once something local is connected (a HealthKit or
 * Fitbit-style export, say). `read` returning null/undefined means nothing is connected right now.
 */
export interface HealthSource {
  read(owner: string): Promise<BriefItem[] | null | undefined>;
}

export const noHealthConnected = "No health data source is connected.";

/** One line for the brief: the item's title, its source, and the link it came from. */
export function sourceLine(item: BriefItem): string {
  return `${item.title} — ${item.link} (${item.source})`;
}
