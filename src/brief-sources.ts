import { fetchChecked, type PageFetchDeps } from "./web-page-fetch.js";
import { detectInjection, type InjectionPolicy } from "./content-guard.js";

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
  /** Set when the title read like instructions to the assistant and the owner's policy is "warn". */
  flagged?: string;
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

/**
 * A numeric reference past U+10FFFF (where String.fromCodePoint throws) or to a lone surrogate half
 * becomes U+FFFD, the replacement character, so one bad title never takes the rest of the feed with it.
 */
function codePoint(value: number): string {
  const valid = Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return valid ? String.fromCodePoint(value) : "\uFFFD";
}

function decodeEntities(text: string): string {
  return text.replace(/&(#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, _all, dec, hex, name) => {
    if (dec) return codePoint(Number(dec));
    if (hex) return codePoint(parseInt(hex, 16));
    return namedEntities[String(name).toLowerCase()] ?? whole;
  });
}

/**
 * The feed body arrives from a host the owner does not control (and over plain http:// anyone on the
 * path can rewrite it), so every scan below is a single forward pass with `indexOf`: a missing close
 * tag stops the scan instead of rescanning from the next start, which is what made the old lazy
 * `<item>([\s\S]*?)</item>` regexes quadratic on unclosed tags. The work is also capped outright:
 * only the first `maxFeedChars` of the body are read, at most `maxBlocks` item/entry blocks are
 * looked at, and each block is cut to `maxBlockChars` before its title and link are read.
 */
export const feedLimits = { maxFeedChars: 512 * 1024, maxBlocks: 50, maxBlockChars: 8 * 1024 } as const;

/** Text alongside an ASCII-only lowercase copy of the same length, so indexes line up in both. */
interface Scan { text: string; lower: string }

function scanOf(text: string): Scan {
  // Only A-Z is folded: a full toLowerCase() can change a string's length (U+0130 becomes two code
  // units), which would shift every index found in the copy away from the original text.
  return { text, lower: text.replace(/[A-Z]+/g, (run) => run.toLowerCase()) };
}

function sliceScan(scan: Scan, from: number, to: number): Scan {
  return { text: scan.text.slice(from, to), lower: scan.lower.slice(from, to) };
}

const wordChar = /[A-Za-z0-9_]/;

/** Where the next `<name` begins at or after `from` (and not `<names`), or -1. */
function openTagAt(scan: Scan, name: string, from: number): number {
  for (let at = scan.lower.indexOf(`<${name}`, from); at !== -1; at = scan.lower.indexOf(`<${name}`, at + 1)) {
    const next = scan.lower.charAt(at + name.length + 1);
    if (!next || !wordChar.test(next)) return at;
  }
  return -1;
}

/**
 * The inner text of `<name ...>inner</name>` blocks, in order, starting at the first one. Stops at
 * the first open tag with no `>` or no `</name>` after it: nothing further on can close either.
 */
function* elements(scan: Scan, name: string): Generator<Scan> {
  let from = 0;
  for (;;) {
    const open = openTagAt(scan, name, from);
    if (open === -1) return;
    const gt = scan.lower.indexOf(">", open + name.length + 1);
    if (gt === -1) return;
    const close = scan.lower.indexOf(`</${name}>`, gt + 1);
    if (close === -1) return;
    yield sliceScan(scan, gt + 1, close);
    from = close + name.length + 3;
  }
}

/** CDATA sections unwrapped in one forward pass; an unclosed one is left as it is. */
function unwrapCdata(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<![CDATA[", from);
    const close = open === -1 ? -1 : text.indexOf("]]>", open + 9);
    if (close === -1) return out + text.slice(from);
    out += text.slice(from, open) + text.slice(open + 9, close);
    from = close + 3;
  }
}

/** The text of the first `<tag>...</tag>` in a block, CDATA and entities unwrapped, or null. */
function firstTagText(block: Scan, tag: string): string | null {
  const first = elements(block, tag).next();
  if (first.done) return null;
  return decodeEntities(unwrapCdata(first.value.text)).trim();
}

/** The end of the tag that starts at `open`: the first `>` outside a quoted value, or -1. */
function tagEnd(text: string, open: number): number {
  let quote = "";
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return at;
  }
  return -1;
}

/** The value of the `href` attribute in one tag's attribute text, walked once, or null. */
function hrefAttribute(attributes: string): string | null {
  let at = 0;
  while (at < attributes.length) {
    while (at < attributes.length && /[\s/]/.test(attributes[at]!)) at += 1;
    const nameStart = at;
    while (at < attributes.length && !/[\s=/]/.test(attributes[at]!)) at += 1;
    const name = attributes.slice(nameStart, at).toLowerCase();
    while (at < attributes.length && /\s/.test(attributes[at]!)) at += 1;
    if (attributes[at] !== "=") { at = Math.max(at, nameStart + 1); continue; }
    at += 1;
    while (at < attributes.length && /\s/.test(attributes[at]!)) at += 1;
    const quote = attributes[at];
    if (quote !== '"' && quote !== "'") continue;
    const close = attributes.indexOf(quote, at + 1);
    if (close === -1) return null;
    if (name === "href") return attributes.slice(at + 1, close);
    at = close + 1;
  }
  return null;
}

/** Atom's `<link href="...">` carries the address as an attribute, not as element text. */
function atomLinkHref(block: Scan): string | null {
  for (let open = openTagAt(block, "link", 0); open !== -1; ) {
    const end = tagEnd(block.text, open);
    if (end === -1) return null;
    const raw = hrefAttribute(block.text.slice(open + 5, end));
    if (raw !== null) {
      const href = decodeEntities(raw).trim();
      return href || null;
    }
    open = openTagAt(block, "link", end + 1);
  }
  return null;
}

/** Every `<item>` block, then every `<entry>` block, cut to size, stopping after `maxBlocks` in all. */
function* feedBlocks(xml: string): Generator<Scan> {
  const scan = scanOf(xml.slice(0, feedLimits.maxFeedChars));
  let seen = 0;
  for (const name of ["item", "entry"]) {
    for (const block of elements(scan, name)) {
      if (seen++ >= feedLimits.maxBlocks) return;
      yield sliceScan(block, 0, feedLimits.maxBlockChars);
    }
  }
}

/** One block's title and link, or null when either is missing or the link is not http/https. */
function readItem(body: Scan, source: string): BriefItem | null {
  // Each item is one line of the brief: a newline or tab in a title (or a link) from the feed must
  // not start a line of its own, so whitespace runs become one space in the title and go from the link.
  const title = firstTagText(body, "title")?.replace(/\s+/g, " ").trim();
  const link = (firstTagText(body, "link") || atomLinkHref(body))?.replace(/\s+/g, "");
  return title && link && isSafeLink(link) ? { title, link, source } : null;
}

/**
 * A small, safe reader for RSS 2.0 `<item>` and Atom `<entry>` blocks. It reads title and link only
 * and never interprets the feed as anything runnable; a block missing a usable title or a safe link
 * is skipped rather than thrown on, since a feed the owner did not write is not shaped by Branch.
 */
export function parseFeedItems(xml: string, source: string, limit = 8): BriefItem[] {
  const items: BriefItem[] = [];
  for (const body of feedBlocks(xml)) {
    let item: BriefItem | null;
    try {
      item = readItem(body, source);
    } catch {
      item = null; // One unreadable block is skipped; the feed's other items still count.
    }
    if (!item) continue;
    items.push(item);
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
export async function fetchNewsItems(
  deps: PageFetchDeps, feeds: readonly NewsFeed[], signal: AbortSignal, perFeed = 5, allowed: () => boolean = () => true,
): Promise<BriefItem[]> {
  const items: BriefItem[] = [];
  for (const feed of feeds) {
    // Asked before every feed, not once up front: Lockdown can come on while an earlier feed is
    // still loading, and a cancelled task stops here instead of reaching the next address.
    if (signal.aborted || !allowed()) break;
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
 * Feed titles are text from outside the app that ends up in front of the assistant (brief.preview
 * returns them, and a sent brief is written into the conversation list), so they go through the
 * owner's injection policy the way web.search titles do: "block" drops a flagged item, "redact"
 * keeps its link but not its words, and "warn" keeps it with the reason it was flagged.
 */
export function guardNewsItems(items: readonly BriefItem[], policy: InjectionPolicy): BriefItem[] {
  return items.flatMap((item) => {
    const warnings = detectInjection(item.title);
    if (!warnings.length) return [item];
    if (policy === "block") return [];
    if (policy === "redact") return [{ ...item, title: "[removed: this title looked like instructions to the assistant]" }];
    return [{ ...item, flagged: warnings[0]!.reason }];
  });
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
  const flagged = item.flagged ? `; flagged: ${item.flagged}` : "";
  return `${item.title} — ${item.link} (${item.source}${flagged})`;
}
