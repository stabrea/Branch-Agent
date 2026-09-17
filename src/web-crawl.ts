import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./contracts.js";
import { NeedsInputError } from "./contracts.js";
import type { WebAccess } from "./integrations/web.js";
import type { BranchBrowser } from "./integrations/browser.js";
import { WebPageFetcher } from "./web-pages.js";
import type { WebPageResult } from "./web-pages.js";
import type { Store } from "./store.js";

/**
 * Parse robots.txt and check if a path is disallowed for a given user-agent.
 * Handles: User-agent, Disallow, longest-match-wins, empty Disallow means allow.
 * Ignores: Allow, Crawl-delay, wildcards, complex rules.
 */
export function parseRobotstxt(content: string, userAgent: string): (path: string) => boolean {
  const lines = content.split("\n").map((l) => l.trim());
  let applicableRules: string[] = [];
  let foundSection = false;

  for (const line of lines) {
    const comment = line.indexOf("#");
    const clean = (comment >= 0 ? line.slice(0, comment) : line).trim();
    if (!clean) continue;

    const [field = "", ...valueParts] = clean.split(":");
    const value = valueParts.join(":").trim();
    const fieldLower = field.toLowerCase();

    if (fieldLower === "user-agent") {
      // New section: if it matches our UA or "*", it applies
      if (value === "*" || value.toLowerCase() === userAgent.toLowerCase()) {
        foundSection = true;
      } else if (foundSection && applicableRules.length > 0) {
        // End of our matching section
        break;
      } else {
        foundSection = false;
      }
    } else if (fieldLower === "disallow" && foundSection) {
      applicableRules.push(value);
    }
  }

  // Check if a path is disallowed: longest matching Disallow wins.
  return (path: string): boolean => {
    let longestMatch = -1;
    for (const rule of applicableRules) {
      if (rule === "") return false; // Empty Disallow means allow all
      if (path.startsWith(rule) && rule.length > longestMatch) {
        longestMatch = rule.length;
      }
    }
    return longestMatch >= 0;
  };
}

/**
 * Get the registrable host (last two labels) from a URL. E.g., "sub.example.com" → "example.com".
 * Note: This is conservative; multi-part TLDs like ".co.uk" are treated as single labels.
 */
function getRegistrableHost(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

/**
 * Result of crawling a site: the pages fetched (with challenges marked) and URLs visited.
 */
export interface CrawlResult {
  pages: WebPageResult[];
  /** Count of URLs attempted (including challenged ones). */
  urlsAttempted: number;
  /** Count of URLs skipped (disallowed by robots.txt). */
  urlsSkipped: number;
  /** Whether the crawl stopped due to a challenge. */
  stoppedByChallenge: boolean;
  /** If stopped by challenge, the URL that triggered it. */
  challengeUrl?: string;
}

/**
 * Crawls a website, respecting robots.txt and depth/page limits.
 * - Same registrable host only
 * - Max depth (default 1), max pages (default 10)
 * - Honours robots.txt Disallow for * and Branch user agent
 * - Polite delay between requests
 * - Stops when a challenge is detected; returns partial results + challenge flag
 */
export class WebCrawler {
  private readonly fetcher: WebPageFetcher;
  private readonly userAgent: string;

  constructor(web: WebAccess, browser: BranchBrowser | undefined, store: Pick<Store, "get">) {
    this.fetcher = new WebPageFetcher(web, browser, store);
    this.userAgent = "BranchAgent";
  }

  async crawl(
    startUrl: string,
    maxDepth: number,
    maxPages: number,
    delayMs: number,
    context: ToolContext,
  ): Promise<CrawlResult> {
    const startUrlObj = new URL(startUrl);
    const registrableHost = getRegistrableHost(startUrlObj);
    const result: CrawlResult = {
      pages: [],
      urlsAttempted: 0,
      urlsSkipped: 0,
      stoppedByChallenge: false,
    };

    // Fetch robots.txt for the site once
    let isDisallowed: (path: string) => boolean = () => false;
    try {
      const robotsUrl = new URL("/robots.txt", startUrlObj).toString();
      const robotsPage = await this.fetcher.fetch(robotsUrl, "plain", context);
      if (!robotsPage.challenged) {
        isDisallowed = parseRobotstxt(robotsPage.text, this.userAgent);
      }
    } catch {
      // robots.txt fetch failed: assume allow-all
    }

    // BFS to crawl pages, respecting depth limit
    const visited = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0 && result.pages.length < maxPages) {
      context.signal.throwIfAborted();

      const { url, depth } = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const urlObj = new URL(url);
        // Enforce same registrable host
        if (getRegistrableHost(urlObj) !== registrableHost) {
          result.urlsSkipped++;
          continue;
        }

        // Check robots.txt
        if (isDisallowed(urlObj.pathname)) {
          result.urlsSkipped++;
          continue;
        }

        result.urlsAttempted++;

        // Polite delay
        if (result.urlsAttempted > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }

        const page = await this.fetcher.fetch(url, "plain", context);
        result.pages.push(page);

        if (page.challenged) {
          result.stoppedByChallenge = true;
          result.challengeUrl = url;
          break;
        }

        // Extract links from the page if depth allows
        if (depth < maxDepth) {
          const links = this.extractLinks(page.text, urlObj);
          for (const link of links) {
            if (!visited.has(link) && result.pages.length + queue.length < maxPages * 2) {
              queue.push({ url: link, depth: depth + 1 });
            }
          }
        }
      } catch {
        // Network or other errors: continue with next URL
      }
    }

    return result;
  }

  /**
   * Extract hrefs from HTML text. Simple regex, no parsing.
   * Returns absolute URLs only.
   */
  private extractLinks(html: string, baseUrl: URL): string[] {
    const links: string[] = [];
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      if (!href) continue;

      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") {
          // Strip fragment to dedupe
          const urlWithoutFragment = resolved.href.split("#")[0] || resolved.href;
          if (!links.includes(urlWithoutFragment)) {
            links.push(urlWithoutFragment);
          }
        }
      } catch {
        // Invalid URL, skip
      }
    }

    return links;
  }
}

/**
 * Registers web.crawl tool.
 */
export function registerWebCrawl(
  registry: ToolRegistry,
  web: WebAccess,
  browser: BranchBrowser | undefined,
  store: Pick<Store, "get">,
): void {
  const crawler = new WebCrawler(web, browser, store);

  const CrawlSchema = z.object({
    url: z.string().url().describe("Starting URL to crawl"),
    maxDepth: z.number().int().min(0).max(3).optional().describe("Maximum depth: 0 = current page only, 1 = one level of links"),
    maxPages: z.number().int().min(1).max(50).optional().describe("Maximum pages to fetch"),
    delayMs: z.number().int().min(0).max(10000).optional().describe("Delay between requests in milliseconds"),
  });
  type Crawl = z.infer<typeof CrawlSchema>;

  const tool: ToolDefinition<Crawl> = {
    name: "web.crawl",
    permission: "web.read",
    description:
      "Crawl a website: fetch multiple pages, respect robots.txt, limit to one registrable host. Stops if challenged.",
    parameters: CrawlSchema.strict(),
    execute: async (input: Crawl, context: ToolContext) => {
      const result = await crawler.crawl(
        input.url,
        input.maxDepth ?? 1,
        input.maxPages ?? 10,
        input.delayMs ?? 500,
        context,
      );

      // If stopped by challenge, ask the owner
      if (result.stoppedByChallenge && result.challengeUrl) {
        throw new NeedsInputError(
          `Crawl stopped: ${result.challengeUrl} is asking you to verify you are a person. ` +
            `I fetched ${result.pages.length} pages before hitting this. ` +
            `Open the site yourself in your browser, complete the check, then tell me to carry on.`,
        );
      }

      return result;
    },
  };

  registry.register(tool);
}
