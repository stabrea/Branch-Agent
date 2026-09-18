import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { isHtml, pageLinks, withoutFragment } from "./web-page-fetch.js";
import type { ChallengeAnswer, WebPages } from "./web-pages.js";
import { everythingAllowed, nothingAllowed, robotsRules } from "./web-robots.js";

/**
 * w911 (A1452): `web.crawl` reads a bounded set of pages of one website by following its own links.
 * The same host only; robots.txt obeyed; at most 3 levels and 50 pages; a pause between pages;
 * every page read through the same checked plain read as `web.page`, so every redirect hop passes
 * the network rules and a "are you a person?" page stops the whole crawl and goes to the owner.
 */
export const CrawlInputSchema = z.object({
  url: z.string().url().max(2048),
  maxDepth: z.number().int().min(0).max(3).default(1),
  maxPages: z.number().int().min(1).max(50).default(10),
  /** How much of each page's text is kept; the rest is counted, not sent. */
  maxCharsPerPage: z.number().int().min(200).max(8000).default(3000),
}).strict();
export type CrawlInput = z.infer<typeof CrawlInputSchema>;

export interface CrawledPage { url: string; depth: number; title: string; text: string; droppedChars: number; links: string[] }
export interface CrawlAnswer {
  challenged: false; startUrl: string; pages: CrawledPage[];
  skipped: { robots: string[]; notHtml: string[]; failed: { url: string; reason: string }[] };
  /** Addresses found but not read because the page cap was reached. */
  notVisited: number;
}
export type CrawlChallenge = ChallengeAnswer & { pages: CrawledPage[] };

type Allowed = (pathAndQuery: string) => boolean;
interface Queued { url: string; depth: number }

const pathOf = (url: string): string => { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`; };
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The site's robots.txt: missing (or any 4xx) allows everything, a server error allows nothing. */
async function readRobots(pages: WebPages, start: URL, context: ToolContext): Promise<Allowed | ChallengeAnswer> {
  const read = await pages.readPlain(new URL("/robots.txt", start).toString(), context).catch((error: unknown) => {
    const status = /HTTP (\d{3})/.exec(reasonOf(error))?.[1];
    if (status && Number(status) >= 400 && Number(status) < 500) return null;
    if (status) return "server-error" as const;
    throw error;
  });
  if (read === null) return everythingAllowed;
  if (read === "server-error") return nothingAllowed;
  if ("challenge" in read) return pages.handOver(context, read.raw.url, read.challenge, "plain", "web.crawl");
  return robotsRules(read.raw.body, pages.userAgent);
}

export async function crawlSite(pages: WebPages, input: CrawlInput, context: ToolContext): Promise<CrawlAnswer | CrawlChallenge> {
  const start = new URL(withoutFragment(input.url));
  const robots = await readRobots(pages, start, context);
  if (typeof robots !== "function") return { ...robots, pages: [] };
  const answer: CrawlAnswer = { challenged: false, startUrl: start.toString(), pages: [],
    skipped: { robots: [], notHtml: [], failed: [] }, notVisited: 0 };
  const queue: Queued[] = [{ url: start.toString(), depth: 0 }], seen = new Set([start.toString()]);
  const delay = pages.settings(context.owner).crawlDelayMs;
  let requests = 0;
  while (queue.length && answer.pages.length < input.maxPages) {
    context.signal.throwIfAborted();
    const next = queue.shift()!;
    if (!robots(pathOf(next.url))) { answer.skipped.robots.push(next.url); continue; }
    if (requests++ > 0) await pages.sleep(delay, context.signal);
    const read = await visit(pages, next, input, context, answer, start.host);
    if (read && "challenged" in read) return { ...read, pages: answer.pages };
    if (!read || next.depth >= input.maxDepth) continue;
    for (const link of read.links) {
      if (new URL(link).host !== start.host || seen.has(link)) continue;
      seen.add(link);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }
  answer.notVisited = queue.length;
  return answer;
}

/** Reads one queued page into the answer; gives back the page, a hand-over, or null when skipped. */
async function visit(
  pages: WebPages, next: Queued, input: CrawlInput, context: ToolContext, answer: CrawlAnswer, host: string,
): Promise<ChallengeAnswer | CrawledPage | null> {
  let read: Awaited<ReturnType<WebPages["readPlain"]>>;
  try { read = await pages.readPlain(next.url, context); } catch (error) {
    if (context.signal.aborted) throw error;
    const reason = reasonOf(error);
    if (/not a readable page/.test(reason)) answer.skipped.notHtml.push(next.url);
    else answer.skipped.failed.push({ url: next.url, reason });
    return null;
  }
  if ("challenge" in read) return pages.handOver(context, read.raw.url, read.challenge, "plain", "web.crawl");
  if (new URL(read.raw.url).host !== host) {
    answer.skipped.failed.push({ url: next.url, reason: `it moved to ${new URL(read.raw.url).host}, which is another website` });
    return null;
  }
  if (!isHtml(read.raw.contentType)) { answer.skipped.notHtml.push(next.url); return null; }
  const kept = read.text.slice(0, input.maxCharsPerPage);
  const page: CrawledPage = { url: read.raw.url, depth: next.depth, title: read.title, text: kept,
    droppedChars: read.text.length - kept.length, links: pageLinks(read.raw.body, read.raw.url) };
  answer.pages.push(page);
  return page;
}
