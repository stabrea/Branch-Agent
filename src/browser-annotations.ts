import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Page } from 'playwright';

/**
 * A2144: DOM annotation directives that capture information about elements the owner picked.
 * Turns clicked DOM elements into directives (inspect, change, lift, comment) that become
 * work for the assistant: either queued as a follow-up or kept in a list the assistant reads.
 */

export const DirectiveKind = z.enum(['inspect', 'change', 'lift', 'comment']);
export type DirectiveKind = z.infer<typeof DirectiveKind>;

/**
 * A directive created from a picked DOM element. The element info is captured with
 * credentials stripped and sensitive data removed.
 */
export const BrowserDirectiveSchema = z.object({
  id: z.string().uuid(),
  kind: DirectiveKind,
  /** Page URL with credentials stripped (use leak-guard utilities). */
  pageUrl: z.string().url().max(2048),
  /** Stable selector or mark number that identifies the element on the live page. */
  selector: z.string().max(500),
  /** The element's tag name, e.g. "button", "input". */
  tag: z.string().max(50),
  /** The element's visible text or label, trimmed. */
  text: z.string().max(200),
  /** The element's outerHTML trimmed, with script contents and input values removed. */
  outerHTML: z.string().max(1000),
  /** A few computed CSS styles relevant to the element. */
  styles: z.record(z.string().max(100), z.string().max(500)).default({}),
  /** The parent element chain up to the root, e.g. ['div', 'section', 'body']. */
  parentChain: z.array(z.string().max(50)).max(10),
  /** The owner's note about this element. */
  note: z.string().max(1000),
  /** When the directive was created. */
  createdAt: z.string().datetime(),
  /** Which conversation this belongs to, or undefined if not yet assigned. */
  conversationId: z.string().uuid().optional(),
}).strict();

export type BrowserDirective = z.infer<typeof BrowserDirectiveSchema>;

const settingsKeyPrefix = 'browser-directives:';

/**
 * Extract the owner's directives for a conversation, or all if no conversation is given.
 */
export function getDirectives(
  store: Pick<Store, 'get'>,
  owner: string,
  conversationId?: string,
): BrowserDirective[] {
  const key = conversationId
    ? `${settingsKeyPrefix}${conversationId}`
    : settingsKeyPrefix;

  if (conversationId) {
    const saved = store.get('settings', owner, key)?.data as { directives?: BrowserDirective[] } | undefined;
    return saved?.directives ?? [];
  }

  // Return all directives without a specific conversation
  const saved = store.get('settings', owner, `${settingsKeyPrefix}all`)?.data as { directives?: BrowserDirective[] } | undefined;
  return saved?.directives ?? [];
}

/**
 * Save a new directive for the owner.
 */
export function saveDirective(
  store: Store,
  owner: string,
  directive: BrowserDirective,
): void {
  const key = directive.conversationId
    ? `${settingsKeyPrefix}${directive.conversationId}`
    : `${settingsKeyPrefix}all`;

  const saved = store.get('settings', owner, key)?.data as { directives?: BrowserDirective[] } | undefined;
  const directives = [...(saved?.directives ?? []), directive];

  store.save('settings', owner, key, { directives });
}

/**
 * Mark a directive as resolved (move to archive or delete).
 */
export function resolveDirective(
  store: Store,
  owner: string,
  directiveId: string,
  conversationId?: string,
): void {
  const key = conversationId
    ? `${settingsKeyPrefix}${conversationId}`
    : `${settingsKeyPrefix}all`;

  const saved = store.get('settings', owner, key)?.data as { directives?: BrowserDirective[] } | undefined;
  const directives = (saved?.directives ?? []).filter(d => d.id !== directiveId);

  store.save('settings', owner, key, { directives });
}

/**
 * Capture element information from a live page via read-only Playwright evaluation.
 * Never reads sensitive input values; script contents are removed.
 */
export async function captureElementFromPage(
  page: Page,
  selector: string,
  kind: DirectiveKind,
  note: string,
): Promise<BrowserDirective> {
  const pageUrl = page.url();

  const elementData = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;

    const tag = el.tagName.toLowerCase();
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().slice(0, 200);

    // Build a trimmed outerHTML without script contents and password fields
    let html = el.outerHTML;
    html = html.replace(/<script[^>]*>.*?<\/script>/gs, '');
    // Remove password input values
    html = html.replace(/type\s*=\s*["']?password["']?[^>]*value\s*=\s*["'][^"']*["']/gi, '');
    html = html.replace(/type\s*=\s*["']?password["']?[^>]*/gi, '');
    html = html.slice(0, 1000);

    // Extract some computed styles
    const styles = window.getComputedStyle(el);
    const styleObj: Record<string, string> = {};
    for (const prop of ['display', 'visibility', 'color', 'backgroundColor', 'fontSize']) {
      const val = styles.getPropertyValue(prop);
      if (val) styleObj[prop] = val.slice(0, 100);
    }

    // Parent chain
    const chain: string[] = [];
    for (let node = el.parentElement; node && chain.length < 10; node = node.parentElement) {
      chain.push(node.tagName.toLowerCase());
    }

    return { tag, text, html, styles: styleObj, chain };
  }, selector).catch(() => null);

  if (!elementData) {
    throw new Error(`Element not found at selector: ${selector}`);
  }

  // Strip credentials from URL
  let cleanUrl = pageUrl;
  try {
    const url = new URL(pageUrl);
    url.username = '';
    url.password = '';
    cleanUrl = url.toString();
  } catch {
    // If URL parsing fails, try to strip manually
    cleanUrl = pageUrl.replace(/https?:\/\/[^:@/]*(?::[^@/]*)?@/, 'https://');
  }

  const directive: BrowserDirective = {
    id: randomUUID(),
    kind,
    pageUrl: cleanUrl,
    selector,
    tag: elementData.tag,
    text: elementData.text,
    outerHTML: elementData.html,
    styles: elementData.styles,
    parentChain: elementData.chain,
    note,
    createdAt: new Date().toISOString(),
  };

  return BrowserDirectiveSchema.parse(directive);
}

/**
 * The refusal message while page notes are off.
 */
export const pageNotesOff =
  'Annotating page elements is switched off. Turn it on under Settings → Browser → Pointing at a thing on a page.';
