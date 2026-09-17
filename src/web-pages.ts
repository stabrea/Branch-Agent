import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./contracts.js";
import { NeedsInputError } from "./contracts.js";
import type { WebAccess } from "./integrations/web.js";
import type { BranchBrowser } from "./integrations/browser.js";
import { readAttachSettings } from "./integrations/browser-attach.js";
import type { Store } from "./store.js";

/**
 * Challenge detection: when a website asks "are you human?", identify and stop.
 */
interface ChallengeDetector {
  (
    status: number,
    contentType: string,
    text: string,
  ): { challenged: boolean; kind?: string } | null;
}

const detectChallenge: ChallengeDetector = (status, contentType, text) => {
  // HTTP 403/429/503 with challenge body hints
  if ([403, 429, 503].includes(status)) {
    if (
      /cloudflare|checking\s+your\s+browser|just\s+a\s+moment/i.test(text) ||
      /hcaptcha|recaptcha|turnstile/i.test(text)
    ) {
      return {
        challenged: true,
        kind: /cloudflare/i.test(text)
          ? "cloudflare"
          : /hcaptcha|recaptcha|turnstile/i.test(text)
            ? "captcha"
            : "challenge",
      };
    }
  }

  // Look for challenge iframes or "enable JavaScript" messages
  if (/enable\s+javascript|noscript|hcaptcha|recaptcha|turnstile/i.test(text)) {
    return { challenged: true, kind: "captcha" };
  }

  return null;
};

/**
 * Internal result of fetching a page through either route. Wraps the fetched page or a challenge.
 */
interface FetchedPage {
  url: string;
  title: string;
  text: string;
  contentType: string;
  truncated: boolean;
  hops: number;
  challenged?: true;
  challengeKind?: string | undefined;
}

/**
 * Public result: either a successful page fetch or a challenge report.
 */
export interface WebPageResult {
  url: string;
  title: string;
  text: string;
  contentType: string;
  truncated: boolean;
  hops: number;
  challenged?: true | undefined;
  challengeKind?: string | undefined;
  /** Message to show the owner when a challenge is detected. */
  takeoverMessage?: string | undefined;
}

/**
 * Fetches and extracts readable text from a web page. Routes:
 *   - plain: HTTP fetch with simple HTML-to-text extraction
 *   - browser: headless Playwright rendering
 *   - auto: plain first, fallback to browser if text is nearly empty
 *
 * When a challenge is detected (Cloudflare, hCaptcha, etc.), stops and returns a result
 * with { challenged: true } rather than throwing; the caller decides whether to retry.
 */
export class WebPageFetcher {
  constructor(
    private readonly web: WebAccess,
    private readonly browser: BranchBrowser | undefined,
    private readonly store: Pick<Store, "get"> | undefined,
  ) {}

  async fetch(
    url: string,
    route: "plain" | "browser" | "auto" = "auto",
    context?: ToolContext,
  ): Promise<WebPageResult> {
    let result: FetchedPage;

    if (route === "plain") {
      result = await this.fetchPlain(url);
    } else if (route === "browser") {
      if (!this.browser || !context)
        throw new Error("Browser route requires browser integration and a tool context");
      result = await this.fetchBrowser(url, context);
    } else {
      // auto: try plain first
      result = await this.fetchPlain(url);
      // If text is nearly empty (likely script-rendered), fall back to browser
      if (
        !result.challenged &&
        result.text.trim().split(/\s+/).length < 20 &&
        this.browser &&
        context
      ) {
        result = await this.fetchBrowser(url, context);
      }
    }

    // If challenged, construct a helpful message and mark it.
    if (result.challenged) {
      const msg =
        result.challengeKind === "cloudflare"
          ? "This site (Cloudflare) is asking whether you are a person. Open it yourself in your browser, get past the check, then tell me to carry on."
          : result.challengeKind === "captcha"
            ? "This site is asking to solve a captcha. Open it yourself in your browser, solve it, then tell me to carry on."
            : "This site is asking you to verify you are a person. Open it yourself in your browser, complete the check, then tell me to carry on.";

      const attachSettings =
        this.store && context ? readAttachSettings(this.store as any, context.owner) : undefined;
      if (attachSettings?.enabled) {
        result.text +=
          "\n\n[I can also open this in your own browser if you turn on \"Let Branch use my browser for this task\" in Settings, then tell me to try again.]";
      }

      return {
        ...result,
        takeoverMessage: msg,
      };
    }

    return result;
  }

  private async fetchPlain(url: string): Promise<FetchedPage> {
    try {
      const page = await this.web.fetchPage(url, 50000);
      // Check for challenge in the fetched text
      const challenge = detectChallenge(200, page.contentType, page.text);
      if (challenge?.challenged) {
        return {
          url: page.url,
          title: page.title,
          text: page.text,
          contentType: page.contentType,
          truncated: page.truncated,
          hops: page.hops,
          challenged: true,
          challengeKind: challenge.kind,
        };
      }
      return {
        url: page.url,
        title: page.title,
        text: page.text,
        contentType: page.contentType,
        truncated: page.truncated,
        hops: page.hops,
      };
    } catch (error) {
      // If it's a challenge error (503/429/403), check the message
      if (error instanceof Error && /HTTP (503|429|403)/.test(error.message)) {
        return {
          url: url,
          title: "",
          text: error.message,
          contentType: "text/plain",
          truncated: false,
          hops: 0,
          challenged: true,
          challengeKind: "challenge",
        };
      }
      // Re-throw other network errors
      throw error;
    }
  }

  private async fetchBrowser(url: string, context: ToolContext): Promise<FetchedPage> {
    if (!this.browser) throw new Error("Browser not available");

    context.signal.throwIfAborted();

    try {
      // Navigate to the URL
      await this.browser.navigate(url, context);
      // Get the snapshot (accessibility tree, which is the readable text)
      const snapshot = await this.browser.snapshot(context);

      const text = snapshot.accessibility || "";
      // Check for challenge in the accessibility tree
      const challenge = detectChallenge(200, "text/html", text);
      if (challenge?.challenged) {
        return {
          url: snapshot.url,
          title: "",
          text: text.slice(0, 50000),
          contentType: "text/html",
          truncated: text.length > 50000,
          hops: 0,
          challenged: true,
          challengeKind: challenge.kind,
        };
      }

      return {
        url: snapshot.url,
        title: "",
        text: text.slice(0, 50000),
        contentType: "text/html",
        truncated: text.length > 50000,
        hops: 0,
      };
    } catch (error) {
      // If the browser itself fails, re-throw
      throw error;
    }
  }
}

/**
 * Registers web.page tool if the feature is enabled.
 */
export function registerWebPages(
  registry: ToolRegistry,
  web: WebAccess,
  browser: BranchBrowser | undefined,
  store: Pick<Store, "get">,
): void {
  const fetcher = new WebPageFetcher(web, browser, store);

  const PageFetchSchema = z.object({
    url: z.string().url(),
    route: z.enum(["plain", "browser", "auto"]).optional().describe(
      "How to fetch: 'plain' (HTTP fetch only), 'browser' (render in headless browser), 'auto' (plain first, browser if needed)",
    ),
  });
  type PageFetch = z.infer<typeof PageFetchSchema>;

  const tool: ToolDefinition<PageFetch> = {
    name: "web.page",
    permission: "web.read",
    description:
      "Fetch and read a web page. Three routes: plain (fast HTTP read), browser (renders JavaScript), auto (plain, fallback to browser).",
    parameters: PageFetchSchema.strict(),
    execute: async (input: PageFetch, context: ToolContext) => {
      const result = await fetcher.fetch(input.url, input.route || "auto", context);

      // If challenged, ask the owner to take over
      if (result.challenged && result.takeoverMessage) {
        throw new NeedsInputError(result.takeoverMessage);
      }

      return result;
    },
  };

  registry.register(tool);
}
