import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {RunArtifacts, ToolRegistry, Budget} from '../dist/index.js';

const runContext = (runId, owner = 'test', signal = new AbortController().signal) => ({
  owner, workspace: '.', runId, signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact']), depth: 0,
});

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

const page = body => `<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`;
const routes = {
  // Step 1: a page that signs the browser in by setting a cookie.
  '/sign-in': page('<p>welcome</p><script>document.cookie="branch_flow=carried-9421; max-age=600; path=/"</script>'),
  // Step 2: a *different* page that only shows whether that cookie is still there.
  '/account': page('<p id="who">?</p><script>document.getElementById("who").textContent="cookie is "+document.cookie</script>'),
  // Step 3: a third page, reached by clicking a link, that again just reflects the cookie back.
  '/receipts': page('<p id="who">?</p><script>document.getElementById("who").textContent="cookie is "+document.cookie</script>'),
};
async function fixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/account') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(routes['/account'] + '<a href="/receipts">See receipts</a>');
      return;
    }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(routes[path] ?? page('<p>not found</p>'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {server, origin, stop: async () => { server.close(); await once(server, 'close'); }};
}

async function harness(label, config = {}) {
  const root = await scratch(label);
  const {server, origin, stop} = await fixture();
  const browser = new BranchBrowser({allowedOrigins: [origin], ...config});
  browser.artifacts = new RunArtifacts(join(root, 'artifacts'));
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, origin, browser, registry, server,
    close: async () => { await browser.close(); await stop(); await rm(root, {recursive: true, force: true}); }};
}

test('browser.flow walks three pages with one browser window, screenshotting each step, and the sign-in cookie from step one is still there on the last page', async () => {
  const h = await harness('browser-flow');
  try {
    const context = runContext('flow-run');
    const result = await h.registry.execute('browser.flow', {steps: [
      {action: 'navigate', url: `${h.origin}/sign-in`},
      {action: 'navigate', url: `${h.origin}/account`},
      {action: 'click', role: 'link', name: 'See receipts'},
    ]}, context);

    assert.equal(result.steps.length, 3, 'one report per step');
    assert.equal(result.pages, 3, 'three distinct pages were actually visited');
    assert.deepEqual(result.steps.map(s => s.action), ['navigate', 'navigate', 'click']);
    assert.match(result.steps[0].url, /\/sign-in$/);
    assert.match(result.steps[1].url, /\/account$/);
    assert.match(result.steps[2].url, /\/receipts$/);

    // Every step kept its own picture, and every picture is a real PNG file on disk.
    for (const step of result.steps) {
      assert.ok(step.screenshot.bytes > 0);
      const bytes = await readFile(step.screenshot.path);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `step ${step.step} kept a PNG`);
      assert.equal(bytes.byteLength, step.screenshot.bytes);
    }

    // The proof the gap asked for: read what the LAST page (reached two steps after the cookie was
    // set, on a page that only got there by clicking a link) says its own cookie jar holds.
    const last = await h.registry.execute('browser.snapshot', {}, context);
    assert.match(last.accessibility, /carried-9421/,
      'the sign-in from step one is still readable on the third page of the same flow');

    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('browser.flow refuses a wait step that does not say what to wait for', async () => {
  const h = await harness('browser-flow-bad-wait');
  try {
    await assert.rejects(h.registry.execute('browser.flow', {steps: [
      {action: 'navigate', url: h.origin},
      {action: 'wait'},
    ]}, runContext('bad')), /Say what to wait for/);
  } finally { await h.close(); }
});
