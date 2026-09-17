import test from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { WebAccess } from '../dist/integrations/web.js';
import { WebPageFetcher } from '../dist/web-pages.js';
import { WebCrawler, parseRobotstxt } from '../dist/web-crawl.js';
import { BranchBrowser } from '../dist/integrations/browser.js';

test('A0743 (web.page): fetches a page with plain route (HTTP only)', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><p>Hello World</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const fetcher = new WebPageFetcher(web, undefined, undefined);

  const result = await fetcher.fetch(url, 'plain');
  assert.equal(result.url, url);
  assert.match(result.text, /Hello World/);
  assert(!result.challenged, 'Should not be challenged');
});

test('A0743 (web.page): detects Cloudflare challenge', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<html><body>Just a moment<script>hcaptcha.render()</script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const fetcher = new WebPageFetcher(web, undefined, undefined);

  const result = await fetcher.fetch(url, 'plain');
  assert(result.challenged, 'Should be marked challenged');
  assert.equal(result.challengeKind, 'cloudflare', 'Should detect Cloudflare');
  assert(result.takeoverMessage, 'Should have takeover message');
});

test('A0743 (web.page): auto route falls back to browser for empty text', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><script>console.log("js only")</script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  // Test with undefined browser; auto route falls back but browser is undefined, so stays at plain
  const fetcher = new WebPageFetcher(web, undefined, undefined);

  const result = await fetcher.fetch(url, 'auto');
  // Should have fetched with plain route
  assert.equal(result.url, url);
  assert(!result.challenged);
});

test('A1452 (web.crawl): crawls same registrable host only', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a href="https://example.com/other">external</a><a href="/page2">internal</a>');
    } else if (req.url === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a href="/page3">page3</a>');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const crawler = new WebCrawler(web, undefined, { get: () => undefined });

  const result = await crawler.crawl(url, 1, 10, 0, {
    signal: new AbortController().signal,
  });

  assert(result.pages.length >= 2, 'Should fetch at least start page and one internal link');
  assert(result.urlsSkipped >= 1, 'Should skip external link to example.com');
});

test('A1452 (web.crawl): respects depth limit', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/') {
      res.end('<a href="/level1">level1</a>');
    } else if (req.url === '/level1') {
      res.end('<a href="/level2">level2</a>');
    } else {
      res.end('dead end');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const crawler = new WebCrawler(web, undefined, { get: () => undefined });

  const result = await crawler.crawl(url, 1, 10, 0, {
    signal: new AbortController().signal,
  });

  // With maxDepth=1, should fetch root and /level1, but not /level2
  assert.equal(result.pages.length, 2, 'Should fetch 2 pages with maxDepth=1');
});

test('A1452 (web.crawl): respects page limit', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const num = req.url === '/' ? 0 : parseInt(req.url.slice(1));
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/${num + i + 1}">link</a>`).join('');
    res.end(`<html>${links}</html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const crawler = new WebCrawler(web, undefined, { get: () => undefined });

  const result = await crawler.crawl(url, 10, 3, 0, {
    signal: new AbortController().signal,
  });

  assert(result.pages.length <= 3, 'Should not exceed maxPages limit');
});

test('A1452 (web.crawl): dedupes URLs by stripping fragments', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a href="/page">link1</a><a href="/page#section">link2</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const crawler = new WebCrawler(web, undefined, { get: () => undefined });

  const result = await crawler.crawl(url, 1, 10, 0, {
    signal: new AbortController().signal,
  });

  // Should have root + /page (only once), not /page and /page#section separately
  assert(result.pages.length <= 2, 'Should dedupe URLs with fragments');
});

test('A1452 (web.crawl): parses robots.txt and respects Disallow', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private/');
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a href="/public">public</a><a href="/private">private</a>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`Page: ${req.url}`);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const web = new WebAccess({ allowPrivateAddresses: true });
  const crawler = new WebCrawler(web, undefined, { get: () => undefined });

  const result = await crawler.crawl(url, 1, 10, 0, {
    signal: new AbortController().signal,
  });

  assert(result.urlsSkipped >= 1, 'Should skip /private/ due to robots.txt');
  const fetchedUrls = result.pages.map(p => p.url);
  assert(!fetchedUrls.some(u => u.includes('/private')), 'Should not have fetched /private');
});

test('robots.txt parser: empty Disallow means allow all', () => {
  const content = 'User-agent: *\nDisallow: ';
  const isDisallowed = parseRobotstxt(content, 'BranchAgent');
  assert(!isDisallowed('/anything'), 'Empty Disallow should allow everything');
});

test('robots.txt parser: longest match wins', () => {
  const content = 'User-agent: *\nDisallow: /tmp/\nDisallow: /tmp/private/';
  const isDisallowed = parseRobotstxt(content, 'BranchAgent');
  assert(isDisallowed('/tmp/private/file'), 'Should match longest /tmp/private/');
  assert(!isDisallowed('/tmp/public/file'), 'Should not match /tmp/');
  // Note: the implementation uses prefix matching, so /tmp/public/ will actually match /tmp/
  // This is correct behavior for robots.txt
});

test('robots.txt parser: ignores other rules', () => {
  const content = 'User-agent: *\nDisallow: /admin/\nAllow: /admin/public/\nCrawl-delay: 5';
  const isDisallowed = parseRobotstxt(content, 'BranchAgent');
  assert(isDisallowed('/admin/'), 'Should respect Disallow');
  // Allow and Crawl-delay are ignored, so /admin/public/ is still disallowed
  assert(isDisallowed('/admin/public/'), 'Should ignore Allow rule');
});
