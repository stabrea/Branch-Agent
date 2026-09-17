import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, complete) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-session-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'),
    provider: { name: 'session-ui-fixture', complete } });
  const source = app.store.createRun('local', 'Original task');
  for (const [role, content] of [
    ['user', 'Original choice'], ['assistant', 'Juniper checkpoint'],
    ['user', 'Later instruction'], ['assistant', 'Later outcome'],
  ]) app.store.message(source.sessionId, { role, content });
  app.store.finish(source.id, 'completed', 'Later outcome');
  const original = JSON.stringify(app.store.sessionView('local', source.sessionId));
  const server = await startServer(app, { dataDir: join(root, 'private'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  return { app, page, source, original, errors };
}
async function readCheckpoint(page, query = 'Juniper checkpoint') {
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByLabel('Search past conversations', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Search conversations', exact: true }).click();
  await page.locator('#history-results').getByRole('button', { name: 'Read message', exact: true }).first().click();
  await page.locator('#history-message').waitFor({ state: 'visible' });
}
async function branchCheckpoint(page) {
  await readCheckpoint(page);
  await page.locator('#history-message').getByRole('button', { name: 'Branch from here', exact: true }).click();
  await page.locator('#chat').waitFor({ state: 'visible' });
}
async function readyConversation(page) {
  await page.waitForFunction(() => !document.getElementById('send').disabled);
}

test('browser branches a historical prefix and follows up without changing the original', async (t) => {
  let messages;
  const f = await fixture(t, async request => {
    messages = structuredClone(request.messages);
    return { content: 'Follow-up completed in the branch', toolCalls: [] };
  });
  await writeFile(join(f.app.runtime.workspace, 'shared.txt'), 'Shared workspace');
  const memory = f.app.store.save('memory', 'local', 'shared-memory', { text: 'Shared memory' });
  await branchCheckpoint(f.page); await readyConversation(f.page);
  const id = await f.page.locator('#conversation').getAttribute('data-session-id');
  assert.notEqual(id, f.source.sessionId);
  assert.match(await f.page.locator('#session-label').innerText(), /Branched conversation/);
  assert.match(await f.page.locator('#session-context').innerText(), /shares workspace files and saved memory/);
  assert.match(await f.page.locator('#conversation').innerText(), /Original choice/);
  assert.doesNotMatch(await f.page.locator('#conversation').innerText(), /Later instruction|Later outcome/);
  assert.equal(await f.page.locator('#conversation').getByRole('button', { name: 'Branch from here' }).count(), 2);
  if (process.env.BRANCH_SESSION_SCREENSHOT)
    await f.page.screenshot({ path: process.env.BRANCH_SESSION_SCREENSHOT, fullPage: true });
  await f.page.getByLabel('Your message', { exact: true }).fill('New direction');
  await f.page.getByRole('button', { name: 'Send', exact: false }).click();
  await readyConversation(f.page);
  assert.deepEqual(messages.filter(message => message.role !== 'system'), [
    { role: 'user', content: 'Original choice' }, { role: 'assistant', content: 'Juniper checkpoint' },
    { role: 'user', content: 'New direction' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.source.sessionId)), f.original);
  assert.equal(await readFile(join(f.app.runtime.workspace, 'shared.txt'), 'utf8'), 'Shared workspace');
  assert.deepEqual(f.app.store.get('memory', 'local', 'shared-memory'), memory);
  await f.page.getByRole('button', { name: 'Open original conversation', exact: true }).click();
  await readyConversation(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), f.source.sessionId);
  assert.match(await f.page.locator('#conversation').innerText(), /Later outcome/);
  assert.deepEqual(f.errors, []);
});

test('pending chat disables branching and conversation switching until its response settles', async (t) => {
  const release = deferred(), started = deferred();
  t.after(() => release.resolve());
  let requests = 0;
  const f = await fixture(t, async () => {
    requests++; started.resolve(); await release.promise;
    return { content: 'Pending task finished', toolCalls: [] };
  });
  await branchCheckpoint(f.page); await readyConversation(f.page);
  const id = await f.page.locator('#conversation').getAttribute('data-session-id');
  await f.page.getByLabel('Your message', { exact: true }).fill('Wait for fixture');
  await f.page.locator('#send').click(); await started.promise;
  for (const selector of ['#new-session', '#send', '#conversation .conversation-switch', '#session-context .conversation-switch'])
    assert.equal(await f.page.locator(selector).first().isDisabled(), true);
  await f.page.locator('#new-session').evaluate(button => button.click());
  await f.page.getByRole('button', { name: 'Memory', exact: true }).click();
  assert.equal(await f.page.locator('#history-message').getByRole('button', { name: 'Branch from here', exact: true }).isDisabled(), true);
  assert.equal(await f.page.locator('#history-message').getByRole('button', { name: 'Open conversation', exact: true }).isDisabled(), true);
  await f.page.locator('#chat-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(requests, 1);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), id);
  release.resolve(); await readyConversation(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), id);
  assert.match(await f.page.locator('#conversation').innerText(), /Pending task finished/);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.source.sessionId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('failed branch view keeps its created ID and retry opens it without another branch', async (t) => {
  const f = await fixture(t, async () => ({ content: 'done', toolCalls: [] }));
  let fail = true, branchRequests = 0;
  f.page.on('request', request => {
    if (request.url().endsWith('/api/action') && request.postDataJSON()?.tool === 'sessions.branch') branchRequests++;
  });
  await f.page.route('**/api/sessions/*', route => {
    if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture view unavailable"}' }); }
    return route.continue();
  });
  await branchCheckpoint(f.page);
  const retry = f.page.getByRole('button', { name: 'Retry opening conversation', exact: true });
  await retry.waitFor(); await readyConversation(f.page);
  const id = await f.page.locator('#conversation').getAttribute('data-session-id');
  assert.notEqual(id, f.source.sessionId);
  assert.equal(f.app.store.sessionView('local', id).messages.length, 2);
  assert.match(await f.page.locator('#session-label').innerText(), /Branched conversation/);
  assert.match(await f.page.locator('#session-context').innerText(), /saved, but its messages could not be loaded/);
  await retry.click(); await readyConversation(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), id);
  assert.match(await f.page.locator('#conversation').innerText(), /Juniper checkpoint/);
  assert.equal(branchRequests, 1);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.source.sessionId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('a rejected historical tool-request branch leaves the current conversation unchanged', async (t) => {
  const f = await fixture(t, async () => ({ content: 'done', toolCalls: [] }));
  const run = f.app.store.createRun('local', 'tool fixture');
  f.app.store.message(run.sessionId, { role: 'assistant', content: 'Unsafe checkpoint', toolCalls: [{ id: 't1', name: 'files.read', arguments: '{"path":"x"}' }] });
  f.app.store.finish(run.id, 'cancelled', 'fixture');
  await readCheckpoint(f.page, 'Unsafe checkpoint');
  await f.page.locator('#history-message').getByRole('button', { name: 'Branch from here', exact: true }).click();
  await f.page.locator('#toast').filter({ hasText: 'without tool requests' }).waitFor();
  await readyConversation(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), null);
  assert.match(await f.page.locator('#session-label').innerText(), /New conversation/);
  assert.deepEqual(f.errors, []);
});
