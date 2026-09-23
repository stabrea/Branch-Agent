import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {RunArtifacts, ToolRegistry, Budget, createBranch, NetworkPolicy} from '../dist/index.js';
import {addPolicyRule, savePolicy} from '../dist/policy.js';

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
  // A page that puts up a message box the moment it opens.
  '/alert': page('<p>hello</p><script>alert("Bonjour, voici une boîte de message")</script>'),
};
async function fixture() {
  const hits = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    hits.push(path);
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
  return {server, origin, hits, stop: async () => { server.close(); await once(server, 'close'); }};
}

async function harness(label, config = {}) {
  const root = await scratch(label);
  const {server, origin, hits, stop} = await fixture();
  const browser = new BranchBrowser({...config, allowedOrigins: [origin, ...(config.allowedOrigins ?? [])]});
  browser.artifacts = new RunArtifacts(join(root, 'artifacts'));
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, origin, hits, browser, registry, server,
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

// ------------------------------------------------------------------ review of 2058b7b1

test('browser.flow refuses a wait step that names both some text and a selector, as browser.wait does', async () => {
  const h = await harness('browser-flow-both-wait');
  try {
    await assert.rejects(h.registry.execute('browser.flow', {steps: [
      {action: 'navigate', url: h.origin},
      {action: 'wait', text: 'hello', selector: 'p'},
    ]}, runContext('both')), /Say what to wait for/);
    assert.deepEqual(h.hits, [], 'refused before anything ran');
  } finally { await h.close(); }
});

test('browser.flow reports the message boxes a page put up during a step', async () => {
  const h = await harness('browser-flow-dialog');
  try {
    const context = runContext('flow-dialog');
    const result = await h.registry.execute('browser.flow', {steps: [
      {action: 'navigate', url: `${h.origin}/alert`},
    ]}, context);
    const boxes = result.steps[0].messageBoxes ?? [];
    assert.ok(boxes.some(box => box.kind === 'alert' && box.message === 'Bonjour, voici une boîte de message'),
      `the step's message box is in the report: ${JSON.stringify(result.steps[0])}`);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('browser.flow checks every page it will open against the network policy before the first step runs', async () => {
  const h = await harness('browser-flow-private', {allowedOrigins: ['http://10.1.2.3']});
  const real = new NetworkPolicy({}, async () => ['93.184.216.34']);
  // The fixture itself is on this computer, so only it is let past; every other address meets the real policy.
  const fixtureHost = new URL(h.origin).host;
  h.browser.policy = {assertAllowed: (url, what) => url.host === fixtureHost ? Promise.resolve() : real.assertAllowed(url, what)};
  try {
    await assert.rejects(h.registry.execute('browser.flow', {steps: [
      {action: 'navigate', url: `${h.origin}/sign-in`},
      {action: 'navigate', url: 'http://10.1.2.3/admin'},
    ]}, runContext('private')), /private or local address/);
    assert.deepEqual(h.hits, [], 'the first page was never opened: the private address stopped the flow before it began');
  } finally { await h.close(); }
});

/** The app itself, with its approval rules, and a browser on the fixture registered into it. */
async function judged(t, label) {
  const root = await scratch(label);
  const {origin, hits, stop} = await fixture();
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data')});
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.artifacts = new RunArtifacts(join(root, 'artifacts'));
  registerBrowser(app.registry, browser);
  t.after(async () => { await browser.close(); await app.close(); await stop(); await rm(root, {recursive: true, force: true}); });
  const context = app.runtime.context({runId: app.store.createRun(app.runtime.owner, 'a journey across the fixture').id});
  return {app, origin, host: new URL(origin).host, hits, context};
}
const journey = origin => ({steps: [
  {action: 'navigate', url: `${origin}/account`},
  {action: 'click', role: 'link', name: 'See receipts'},
]});

test('under Ask first, a flow with a click step asks about that click on the website it will be on', async (t) => {
  const {app, origin, host, hits, context} = await judged(t, 'flow-ask-first');
  savePolicy(app.store, 'local', {preset: 'ask-before-changes'});
  await assert.rejects(app.registry.execute('browser.flow', journey(origin), context), (error) => {
    assert.equal(error.name, 'ApprovalRequiredError');
    assert.equal(error.tool, 'browser.click', 'the question is about the click itself, not the flow as a whole');
    assert.equal(error.target, host, 'judged on the website the flow opened in the step before');
    return true;
  });
  assert.deepEqual(hits, [], 'nothing ran before the question');
});

test('under Auto, where no rule names browser.flow, its click still asks as browser.click does', async (t) => {
  const {app, origin, host, hits, context} = await judged(t, 'flow-auto');
  savePolicy(app.store, 'local', {preset: 'workspace'});
  addPolicyRule(app.store, 'local', {tool: 'browser.navigate', match: host, decision: 'allow', remember: 'always'});
  await assert.rejects(app.registry.execute('browser.flow', journey(origin), context),
    (error) => error.name === 'ApprovalRequiredError' && error.tool === 'browser.click' && error.target === host);
  assert.deepEqual(hits, []);
});

test('a rule refusing browser.fill on a website stops the flow at that step, before anything runs', async (t) => {
  const {app, origin, host, hits, context} = await judged(t, 'flow-deny-fill');
  savePolicy(app.store, 'local', {preset: 'off'});
  addPolicyRule(app.store, 'local', {tool: 'browser.fill', match: host, decision: 'deny', remember: 'always'});
  await assert.rejects(app.registry.execute('browser.flow', {steps: [
    {action: 'navigate', url: `${origin}/account`},
    {action: 'fill', label: 'Name', value: 'Ada'},
  ]}, context), (error) => error.name === 'PolicyRefusedError' && error.tool === 'browser.fill');
  assert.deepEqual(hits, [], 'the page before the refused step was not opened either');
  const refused = app.store.events(context.runId).filter(event => event.kind === 'policy.denied');
  assert.equal(refused.at(-1)?.data.name, 'browser.fill');
});

test('a flow every step of which the rules allow still runs through the app, each step judged', async (t) => {
  const {app, origin, context} = await judged(t, 'flow-allowed');
  savePolicy(app.store, 'local', {preset: 'off'});
  const result = await app.registry.execute('browser.flow', {steps: [
    ...journey(origin).steps,
    {action: 'wait', text: 'cookie is'},
  ]}, context);
  assert.deepEqual(result.steps.map(step => step.action), ['navigate', 'click', 'wait']);
  assert.match(result.steps[1].url, /\/receipts$/);
  await app.registry.finishRun(context);
});
