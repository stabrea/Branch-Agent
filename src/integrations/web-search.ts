import { z } from 'zod';
// Type only: bringing anything runnable in from web.ts would make the two files need each other.
import type { SearchResult } from './web.js';

/**
 * Where "search the web" actually goes. The plain setting is a free one that needs nothing set up;
 * the others are proper search services the owner pays for and whose key lives in the secrets
 * locker, never in a settings file. Whatever is chosen, the request still goes through the same
 * network settings every other outbound call goes through.
 *
 * Honest limits: the free fallback is a scrape of a public results page. It has no promises
 * attached, it is rate-limited by whoever runs it, and on a busy day it returns nothing at all. If
 * search matters for the work, set up one of the paid ones or a SearXNG of your own.
 */
export const searchBackends = ['duckduckgo', 'searxng', 'brave', 'tavily', 'exa', 'serper'] as const;
export type SearchBackend = (typeof searchBackends)[number];

export const SearchBackendSchema = z.object({
  backend: z.enum(searchBackends).default('duckduckgo'),
  /** The address of your own SearXNG, when that is the one chosen. */
  searxngUrl: z.string().url().max(300).optional(),
  /** The name of the secret in the locker holding the key for a paid service. */
  keySecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
}).strict();
export type SearchBackendSettings = z.infer<typeof SearchBackendSchema>;

/** The plain-language name of each one, and whether it needs anything setting up. */
export const backendNotes: Record<SearchBackend, string> = {
  duckduckgo: 'Free, nothing to set up. A scrape of a public results page: it is rate-limited and sometimes returns nothing.',
  searxng: 'Your own SearXNG on your own machine or network. Nothing is shared with anyone else. Give its address.',
  brave: 'Brave Search. Needs a key, saved in the locker.',
  tavily: 'Tavily, built for assistants. Needs a key, saved in the locker.',
  exa: 'Exa, good at finding pages by meaning. Needs a key, saved in the locker.',
  serper: 'Serper, which fetches Google results. Needs a key, saved in the locker.',
};

/** What one backend needs to make its request. Nothing here reaches the network itself. */
export interface SearchRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/** The handful of markup escapes that turn up in a search snippet. */
const escapes: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const tidy = (value: unknown): string => typeof value !== 'string' ? ''
  : value.replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, match => escapes[match] ?? match)
    .replace(/\s+/g, ' ').trim().slice(0, 500);

/** Builds the request one backend wants for this search. */
export function requestFor(settings: SearchBackendSettings, query: string, limit: number, key: string,
  htmlEndpoint = 'https://lite.duckduckgo.com/lite/'): SearchRequest {
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  if (settings.backend === 'searxng') {
    const base = settings.searxngUrl;
    if (!base) throw new Error('Give the address of your SearXNG in the web settings first.');
    return { url: `${base.replace(/\/$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`,
      method: 'GET', headers: { accept: 'application/json' } };
  }
  if (settings.backend === 'brave')
    return { url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`,
      method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': key } };
  if (settings.backend === 'tavily')
    return { url: 'https://api.tavily.com/search', method: 'POST',
      headers: { ...json, authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: limit }) };
  if (settings.backend === 'exa')
    return { url: 'https://api.exa.ai/search', method: 'POST', headers: { ...json, 'x-api-key': key },
      body: JSON.stringify({ query, numResults: limit, contents: { text: false } }) };
  if (settings.backend === 'serper')
    return { url: 'https://google.serper.dev/search', method: 'POST', headers: { ...json, 'x-api-key': key },
      body: JSON.stringify({ q: query, num: limit }) };
  return { url: htmlEndpoint, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: new URLSearchParams({ q: query, kl: '' }).toString() };
}

/**
 * Pulls the results out of whatever each service answers with. Pure: it never touches the network.
 * The free fallback answers with a results page rather than data, so it is read by the HTML reader
 * in web.ts instead of here.
 */
export function parseResults(backend: SearchBackend, body: string): SearchResult[] {
  if (backend === 'duckduckgo') throw new Error('The free search answers with a page, which is read elsewhere');
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new Error('The search service answered with something that is not results.'); }
  const rows = pickRows(backend, data);
  return rows.map(row => shape(backend, row)).filter(result => !!result.url);
}

/** Where in each service's answer the list of results sits. */
function pickRows(backend: SearchBackend, data: unknown): Record<string, unknown>[] {
  const record = (data ?? {}) as Record<string, unknown>;
  const list = backend === 'brave' ? (record.web as Record<string, unknown> | undefined)?.results
    : backend === 'tavily' ? record.results
    : backend === 'exa' ? record.results
    : backend === 'serper' ? record.organic
    : record.results;
  return Array.isArray(list) ? list.filter(row => !!row && typeof row === 'object') as Record<string, unknown>[] : [];
}

/** One result, however the service happens to name its fields. */
function shape(backend: SearchBackend, row: Record<string, unknown>): SearchResult {
  const url = tidy(row.url ?? row.link ?? row.id);
  const title = tidy(row.title ?? row.name);
  const snippet = backend === 'tavily' ? tidy(row.content)
    : backend === 'brave' ? tidy(row.description)
    : backend === 'serper' ? tidy(row.snippet)
    : tidy(row.text ?? row.snippet ?? row.content ?? row.description);
  return { title: title || url, url, snippet };
}
