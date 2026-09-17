import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Page } from 'playwright';
import { stripUrl } from './leak-guard.js';
import { FeatureModeSchema, type FeatureMode } from './feature-switches.js';

/**
 * A2144: DOM annotation directives that capture information about elements the owner picked.
 * Turns clicked DOM elements into directives (inspect, change, lift, comment) that become
 * work for the assistant: either queued as a follow-up or kept in a list the assistant reads.
 */

export const DirectiveKind = z.enum(['inspect', 'change', 'lift', 'comment']);
export type DirectiveKind = z.infer<typeof DirectiveKind>;

/** Settings for the page-notes feature. */
export const PageNotesSettingsSchema = z.object({
  mode: FeatureModeSchema.default('off'),
}).strict();
export type PageNotesSettings = z.infer<typeof PageNotesSettingsSchema>;

/** Input validation: only these fields are accepted from the client. */
export const CreateDirectiveInputSchema = z.object({
  kind: DirectiveKind,
  pageUrl: z.string().url().max(2048),
  selector: z.string().max(500),
  tag: z.string().max(50),
  text: z.string().max(200),
  outerHTML: z.string().max(1000),
  styles: z.record(z.string().max(100), z.string().max(500)).optional(),
  parentChain: z.array(z.string().max(50)).max(10).optional(),
  note: z.string().max(1000).optional(),
  conversationId: z.string().uuid().optional(),
}).strict();

/**
 * A directive created from a picked DOM element. The element info is captured with
 * credentials stripped and sensitive data removed. Server sets id and createdAt.
 */
export const BrowserDirectiveSchema = CreateDirectiveInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  styles: z.record(z.string().max(100), z.string().max(500)).default({}),
  parentChain: z.array(z.string().max(50)).max(10).default([]),
  note: z.string().max(1000).default(''),
}).strict();

export type BrowserDirective = z.infer<typeof BrowserDirectiveSchema>;

const settingsKeyPrefix = 'browser-directives:';

/** Get page-notes settings for an owner or a profile scope. */
export function getPageNotesSettings(store: Pick<Store, 'get'>, scope: string): PageNotesSettings {
  const saved = store.get('settings', scope, 'page-notes')?.data as Record<string, unknown> | undefined;
  const parsed = PageNotesSettingsSchema.safeParse(saved ?? {});
  return parsed.success ? parsed.data : { mode: 'off' };
}

/** Save page-notes settings. */
export function savePageNotesSettings(store: Store, scope: string, input: unknown): PageNotesSettings {
  const settings = PageNotesSettingsSchema.parse(input ?? {});
  store.save('settings', scope, 'page-notes', settings);
  return settings;
}

/**
 * Extract the directives for a conversation under a given scope (owner or profile).
 */
export function getDirectives(
  store: Pick<Store, 'get'>,
  scope: string,
  conversationId?: string,
): BrowserDirective[] {
  const key = conversationId
    ? `${settingsKeyPrefix}${conversationId}`
    : settingsKeyPrefix;

  const saved = store.get('settings', scope, key)?.data as { directives?: BrowserDirective[] } | undefined;
  return saved?.directives ?? [];
}

/**
 * Save a new directive under a given scope (owner or profile).
 */
export function saveDirective(
  store: Store,
  scope: string,
  directive: BrowserDirective,
): void {
  const key = directive.conversationId
    ? `${settingsKeyPrefix}${directive.conversationId}`
    : settingsKeyPrefix;

  const saved = store.get('settings', scope, key)?.data as { directives?: BrowserDirective[] } | undefined;
  const directives = [...(saved?.directives ?? []), directive];

  store.save('settings', scope, key, { directives });
}

/**
 * Resolve a directive by removing it from storage.
 */
export function resolveDirective(
  store: Store,
  scope: string,
  directiveId: string,
  conversationId?: string,
): void {
  const key = conversationId
    ? `${settingsKeyPrefix}${conversationId}`
    : settingsKeyPrefix;

  const saved = store.get('settings', scope, key)?.data as { directives?: BrowserDirective[] } | undefined;
  const directives = (saved?.directives ?? []).filter(d => d.id !== directiveId);

  store.save('settings', scope, key, { directives });
}

/**
 * Capture element information from a live page via Playwright evaluation.
 * Uses DOM cloning to sanitize: never reads input values directly, removes script/style/noscript,
 * and strips all value attributes.
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

    // Clone the element and sanitize it
    const clone = el.cloneNode(true) as Element;

    // Remove script, style, noscript elements from the clone
    for (const elem of [...clone.querySelectorAll('script, style, noscript')]) {
      elem.remove();
    }

    // Remove all value attributes to prevent storing input data
    for (const elem of [...clone.querySelectorAll('input, textarea, select')]) {
      elem.removeAttribute('value');
    }

    const html = clone.outerHTML.slice(0, 1000);

    // Extract computed styles from the original element
    const styles = window.getComputedStyle(el);
    const styleObj: Record<string, string> = {};
    for (const prop of ['display', 'visibility', 'color', 'backgroundColor', 'fontSize']) {
      const val = styles.getPropertyValue(prop);
      if (val) styleObj[prop] = val.slice(0, 100);
    }

    // Build parent chain
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
  const cleanUrl = stripUrl(pageUrl);

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
