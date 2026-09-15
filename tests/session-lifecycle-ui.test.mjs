import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function seed(app, text) {
  const run = app.store.createRun('local', text);
  app.store.message(run.sessionId, { role: 'user', content: text });
  app.store.message(run.sessionId, { role: 'assistant', content: 'Saved response for ' + text });
  app.store.finish(run.id, 'completed', 'Saved response');
  return run.sessionId;
}
async function fixture(t, provider) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-lifecycle-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'),
    provider: provider ?? { name: 'lifecycle-fixture', complete: async () => ({ content: 'Follow-up finished', toolCalls: [] }) } });
  const sourceId = seed(app, 'Juniper lifecycle source');
  const original = JSON.stringify(app.store.sessionView('local', sourceId));
  const server = await startServer(app, { dataDir: join(root, 'private'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  return { app, page, root, sourceId, original, errors };
}
const card = (page, id) => page.locator(`#saved-list article[data-session-id="${id}"]`);
async function ready(page) { await page.waitForFunction(() => !document.getElementById('send').disabled); }
async function library(page, query = '') {
  if (!(await page.locator('#saved-conversations').evaluate(node => node.open)))
    await page.locator('#saved-conversations summary').click();
  await page.locator('#saved-query').fill(query);
  await page.locator('#saved-search-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => !document.getElementById('saved-search').disabled);
}
async function exportFile(f) {
  const download = f.page.waitForEvent('download');
  await card(f.page, f.sourceId).getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await download, path = join(f.root, 'conversation.json');
  await file.saveAs(path); await ready(f.page);
  assert.match(file.suggestedFilename(), /\.json$/);
  return path;
}

test('saved conversations search, paginate, export/import a JSON file, and resume after reload', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 21; index++) seed(f.app, `Other saved conversation ${index}`);
  await library(f.page); assert.equal(await f.page.locator('#saved-list article').count(), 20);
  await f.page.getByRole('button', { name: 'Load more conversations', exact: true }).click();
  await f.page.waitForFunction(() => document.querySelectorAll('#saved-list article').length === 22);
  await library(f.page, 'JUNIPER lifecycle'); assert.equal(await f.page.locator('#saved-list article').count(), 1);
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.BRANCH_LIFECYCLE_SCREENSHOT) {
    await f.page.evaluate(() => window.scrollTo(0, 0));
    await f.page.screenshot({ path: process.env.BRANCH_LIFECYCLE_SCREENSHOT, fullPage: true });
  }
  const path = await exportFile(f), archive = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(archive.format, 'branch-agent-conversation');
  assert.deepEqual(archive.messages, f.app.store.messages(f.sourceId));
  await f.page.locator('#conversation-import').setInputFiles(path); await ready(f.page);
  const imported = await f.page.locator('#conversation').getAttribute('data-session-id');
  assert.notEqual(imported, f.sourceId);
  assert.equal(f.app.store.sessionView('local', imported).imported, true);
  assert.match(await f.page.locator('#session-context').innerText(), /untrusted history/);
  assert.deepEqual(f.app.store.messages(imported), archive.messages);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  await f.page.reload(); await f.page.locator('#workspace').waitFor({ state: 'visible' });
  await library(f.page, 'Juniper lifecycle');
  await card(f.page, imported).getByRole('button', { name: 'Open', exact: true }).click(); await ready(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), imported);
  assert.match(await f.page.locator('#session-label').innerText(), /Imported conversation/);
  assert.deepEqual(f.errors, []);
});

test('duplicating a saved conversation preserves the source and follows up in the new ID', async (t) => {
  let received;
  const f = await fixture(t, { name: 'duplicate-fixture', complete: async request => {
    received = structuredClone(request.messages); return { content: 'Independent follow-up', toolCalls: [] };
  } });
  await library(f.page, 'Juniper');
  await card(f.page, f.sourceId).getByRole('button', { name: 'Duplicate', exact: true }).click(); await ready(f.page);
  const id = await f.page.locator('#conversation').getAttribute('data-session-id');
  assert.notEqual(id, f.sourceId); assert.deepEqual(f.app.store.messages(id), f.app.store.messages(f.sourceId));
  assert.match(await f.page.locator('#session-context').innerText(), /files and saved memory are shared/);
  await f.page.getByLabel('Your message', { exact: true }).fill('A different path');
  await f.page.locator('#send').click(); await ready(f.page);
  assert.deepEqual(received.filter(message => message.role !== 'system'), [
    ...f.app.store.messages(f.sourceId), { role: 'user', content: 'A different path' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('invalid and oversized import files report errors without changing the selected conversation', async (t) => {
  const f = await fixture(t); await library(f.page);
  await card(f.page, f.sourceId).getByRole('button', { name: 'Open', exact: true }).click(); await ready(f.page);
  for (const [buffer, expected] of [[Buffer.from('{broken'), /valid conversation JSON/], [Buffer.alloc(4 * 1024 * 1024 + 1), /at most 4 MiB/], [Buffer.from('{}'), /format|Invalid/]]) {
    await f.page.locator('#conversation-import').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer });
    await f.page.locator('#toast').filter({ hasText: expected }).waitFor(); await ready(f.page);
    assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), f.sourceId);
  }
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('pending send blocks saved conversation switching, duplicate, and file import', async (t) => {
  const release = deferred(), started = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { name: 'pending-fixture', complete: async () => {
    started.resolve(); await release.promise; return { content: 'finished', toolCalls: [] };
  } });
  await library(f.page); await card(f.page, f.sourceId).getByRole('button', { name: 'Open', exact: true }).click(); await ready(f.page);
  await f.page.getByLabel('Your message', { exact: true }).fill('Keep working'); await f.page.locator('#send').click(); await started.promise;
  await library(f.page);
  for (const label of ['Open', 'Duplicate']) assert.equal(await card(f.page, f.sourceId).getByRole('button', { name: label, exact: true }).isDisabled(), true);
  assert.equal(await f.page.locator('#import-conversation').isDisabled(), true);
  assert.equal(await f.page.locator('#conversation-import').isDisabled(), true);
  assert.equal(await f.page.locator('#new-session').isDisabled(), true);
  await card(f.page, f.sourceId).getByRole('button', { name: 'Duplicate', exact: true }).evaluate(button => button.click());
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), f.sourceId);
  release.resolve(); await ready(f.page); assert.deepEqual(f.errors, []);
});

test('failed duplicate or imported view retains each new ID and retry never creates another copy', async (t) => {
  const f = await fixture(t); let fail = true, copies = 0, imports = 0;
  f.page.on('request', request => {
    if (request.url().endsWith('/duplicate')) copies++;
    if (request.url().endsWith('/sessions/import')) imports++;
  });
  await f.page.route('**/api/sessions/*', route => {
    if (route.request().method() === 'GET' && fail) { fail = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"View temporarily unavailable"}' }); }
    return route.continue();
  });
  await library(f.page);
  await card(f.page, f.sourceId).getByRole('button', { name: 'Duplicate', exact: true }).click();
  await retryCreated(f.page, f.app, f.sourceId); assert.equal(copies, 1);
  const archive = { format: 'branch-agent-conversation', version: 1, exportedAt: new Date().toISOString(), messages: f.app.store.messages(f.sourceId) };
  fail = true;
  await f.page.locator('#conversation-import').setInputFiles({ name: 'archive.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await retryCreated(f.page, f.app, f.sourceId); assert.equal(imports, 1);
  assert.deepEqual(f.errors, []);
});

async function retryCreated(page, app, sourceId) {
  const retry = page.getByRole('button', { name: 'Retry opening conversation', exact: true });
  await retry.waitFor(); await ready(page);
  const id = await page.locator('#conversation').getAttribute('data-session-id');
  assert.notEqual(id, sourceId); assert.equal(app.store.sessionView('local', id).messages.length, 2);
  await retry.click(); await ready(page);
  assert.equal(await page.locator('#conversation').getAttribute('data-session-id'), id);
  assert.match(await page.locator('#conversation').innerText(), /Juniper lifecycle source/);
}
