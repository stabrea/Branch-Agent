import test from 'node:test';
import { openPlace } from "./places.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

async function fixture(t, seed = true) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-memory-ui-'));
  const provider = { name: 'memory-ui', async complete(request) {
    const reply = request.messages.findLast(message => message.role === 'tool');
    if (reply) return { content: JSON.parse(reply.content).result[0].data.text, toolCalls: [] };
    return { content: '', toolCalls: [{ id: 'memory', name: 'memory.search', arguments: '{"query":"Juniper"}' }] };
  } };
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  if (seed) await app.runtime.executeTool('memory.put', { text: 'Juniper meeting Monday', source: 'Original note' });
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor({ state: 'visible', timeout: 120000 }); await openPlace(page, 'memory');
  return { app, page, root, errors };
}
const record = f => f.app.store.list('memory', 'local')[0];
const fact = page => page.locator('#memory-list article').first();
async function edit(page, text, source) {
  await fact(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Edit memory fact', { exact: true }).fill(text);
  await page.getByLabel('Edit memory source', { exact: true }).fill(source);
}
/* An import is finished only when the box takes files again: the result is written first and the
   page refreshed after, and a file chosen before then is ignored. On a loaded runner the next file
   was chosen in that gap and the first import's result was read back as the second's. */
const importDone = page => page.waitForFunction(() => !document.getElementById('memory-import').disabled);
async function upload(page, archive) {
  await importDone(page);
  await page.locator('#memory-import').setInputFiles({ name: 'memory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await importDone(page);
}

test('opening the selected memory tab does not send a redundant browser click', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    window.__memoryTabClicks = 0;
    document.querySelector('.lx-tab[data-place="library"][data-tab="memory"]')
      .addEventListener('click', () => { window.__memoryTabClicks += 1; });
  });
  await openPlace(f.page, 'memory');
  assert.equal(await f.page.evaluate(() => window.__memoryTabClicks), 0);
  assert.equal(await f.page.locator('#memory').isVisible(), true);
  assert.deepEqual(f.errors, []);
});

test('memory edits persist after reload and a new chat retrieves the corrected fact', async t => {
  const f = await fixture(t), before = record(f);
  await edit(f.page, 'Juniper meeting Friday', 'Corrected calendar');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  assert.equal(record(f).id, before.id); assert.equal(record(f).revision, before.revision + 1);
  assert.equal(record(f).data.source, 'Corrected calendar');
  await f.page.reload(); await openPlace(f.page, 'memory');
  assert.match(await fact(f.page).innerText(), /Juniper meeting Friday/);
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.BRANCH_MEMORY_SCREENSHOT) {
    await f.page.evaluate(() => window.scrollTo(0, 0));
    await f.page.screenshot({ path: process.env.BRANCH_MEMORY_SCREENSHOT, fullPage: true });
  }
  await openPlace(f.page, 'chat');
  await f.page.getByLabel('Your message', { exact: true }).fill('When is the Juniper meeting?');
  await f.page.locator('#send').click(); await f.page.waitForFunction(() => !document.getElementById('send').disabled);
  assert.match(await f.page.locator('#conversation').innerText(), /Juniper meeting Friday/);
  assert.deepEqual(f.errors, []);
});

test('stale edits retain the draft and do not overwrite a newer fact; cancel discards the draft', async t => {
  const f = await fixture(t), before = record(f);
  await edit(f.page, 'My unsaved draft', 'Draft source');
  await f.app.runtime.executeTool('memory.update', { id: before.id, expectedRevision: before.revision, text: 'Newer correction', source: 'Other editor' });
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await f.page.locator('.memory-error').filter({ hasText: /changed since/ }).waitFor();
  assert.equal(await f.page.getByLabel('Edit memory fact', { exact: true }).inputValue(), 'My unsaved draft');
  assert.equal(record(f).data.text, 'Newer correction');
  await f.page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  assert.match(await fact(f.page).innerText(), /Newer correction/);
  assert.deepEqual(f.errors, []);
});

test('polling preserves the open editor, focus, selection and continued typing', async t => {
  const f = await fixture(t);
  await edit(f.page, 'Juniper draft fact', 'Draft source');
  const input = f.page.getByLabel('Edit memory fact', { exact: true });
  await input.focus();
  await input.evaluate(node => { window.fixtureMemoryInput = node; node.setSelectionRange(8, 13, 'backward'); });
  const poll = f.page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
  await poll;
  await f.page.waitForTimeout(100);
  assert.deepEqual(await input.evaluate(node => ({ same: node === window.fixtureMemoryInput,
    focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })),
  { same: true, focused: true, start: 8, end: 13, direction: 'backward' });
  await f.page.keyboard.type('corrected');
  assert.equal(await input.inputValue(), 'Juniper corrected fact');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  assert.equal(record(f).data.text, 'Juniper corrected fact');
  assert.deepEqual(f.errors, []);
});

test('an older pending save cannot discard a reopened editor draft', async t => {
  const f = await fixture(t);
  let release, received;
  const held = new Promise(resolve => { release = resolve; });
  const updated = new Promise(resolve => { received = resolve; });
  await f.page.route('**/api/action', async route => {
    if (route.request().postDataJSON().tool !== 'memory.update') return route.continue();
    const response = await route.fetch(); received(); await held;
    await route.fulfill({ response });
  });
  await edit(f.page, 'Saved draft A', 'Source A');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click(); await updated;
  assert.equal(await f.page.getByLabel('Edit memory fact', { exact: true }).isDisabled(), true);
  assert.equal(await f.page.getByLabel('Edit memory source', { exact: true }).isDisabled(), true);
  await f.page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  await edit(f.page, 'Unsaved draft B', 'Source B');
  assert.equal(await f.page.getByLabel('Edit memory fact', { exact: true }).isEnabled(), true);
  assert.equal(await f.page.getByLabel('Edit memory source', { exact: true }).isEnabled(), true);
  release(); await f.page.locator('#toast').filter({ hasText: 'Memory updated.' }).waitFor();
  assert.equal(await f.page.getByLabel('Edit memory fact', { exact: true }).inputValue(), 'Unsaved draft B');
  assert.equal(await f.page.getByLabel('Edit memory source', { exact: true }).inputValue(), 'Source B');
  assert.equal(record(f).data.text, 'Saved draft A');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  assert.equal(record(f).data.text, 'Unsaved draft B');
  assert.deepEqual(f.errors, []);
});

test('failed pending memory save restores both fields with the original draft intact', async t => {
  const f = await fixture(t);
  let release, received;
  const held = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { received = resolve; });
  await f.page.route('**/api/action', async route => {
    if (route.request().postDataJSON().tool !== 'memory.update') return route.continue();
    received(); await held;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Retry this save"}' });
  });
  await edit(f.page, 'Draft awaiting save', 'Draft source');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click(); await pending;
  const text = f.page.getByLabel('Edit memory fact', { exact: true });
  const source = f.page.getByLabel('Edit memory source', { exact: true });
  assert.equal(await text.isDisabled(), true); assert.equal(await source.isDisabled(), true);
  release(); await f.page.locator('.memory-error').filter({ hasText: 'Retry this save' }).waitFor();
  assert.equal(await text.isEnabled(), true); assert.equal(await source.isEnabled(), true);
  assert.equal(await text.inputValue(), 'Draft awaiting save'); assert.equal(await source.inputValue(), 'Draft source');
  await f.page.unroute('**/api/action');
  await text.fill('Retried correction'); await source.fill('Retried source');
  await f.page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await f.page.locator('.memory-editor').waitFor({ state: 'detached' });
  assert.equal(record(f).data.text, 'Retried correction'); assert.equal(record(f).data.source, 'Retried source');
  assert.deepEqual(f.errors, []);
});

test('memory capacity rejects additional facts and cannot drop below the saved count', async t => {
  const f = await fixture(t);
  await f.page.locator('#memory-capacity').fill('1');
  await f.page.getByRole('button', { name: 'Update memory limit', exact: true }).click();
  await f.page.locator('#memory-count').filter({ hasText: '1 of 1 saved facts' }).waitFor();
  await f.page.locator('#memory-text').fill('Extra fact');
  await f.page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await f.page.locator('#toast').filter({ hasText: /capacity reached/ }).waitFor();
  assert.equal(f.app.store.list('memory', 'local').length, 1);
  await f.page.locator('#memory-capacity').fill('2');
  await f.page.getByRole('button', { name: 'Update memory limit', exact: true }).click();
  await f.page.locator('#memory-count').filter({ hasText: '1 of 2 saved facts' }).waitFor();
  await f.page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await f.page.locator('#memory-count').filter({ hasText: '2 of 2 saved facts' }).waitFor();
  await f.page.locator('#memory-capacity').fill('1');
  await f.page.getByRole('button', { name: 'Update memory limit', exact: true }).click();
  await f.page.locator('#toast').filter({ hasText: /below the current count/ }).waitFor();
  assert.deepEqual(f.errors, []);
});

test('capacity draft survives blur and polling, and a pending save preserves newer input', async t => {
  const f = await fixture(t), input = f.page.locator('#memory-capacity');
  const submit = f.page.getByRole('button', { name: 'Update memory limit', exact: true });
  await input.fill('2'); await input.press('Tab');
  assert.equal(await submit.evaluate(node => document.activeElement === node), true);
  await f.page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
  await f.page.waitForTimeout(100);
  assert.equal(await input.inputValue(), '2');
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  await f.page.route('**/api/memory/capacity', async route => { started(); await held; await route.continue(); });
  await submit.click(); await intercepted;
  await input.fill('3'); await input.press('Tab'); release();
  await f.page.locator('#memory-count').filter({ hasText: '1 of 2 saved facts' }).waitFor();
  assert.equal(await input.inputValue(), '3');
  await submit.click();
  await f.page.locator('#memory-count').filter({ hasText: '1 of 3 saved facts' }).waitFor();
  assert.equal(await input.inputValue(), '3');
  assert.deepEqual(f.errors, []);
});

test('memory file export/import preserves metadata in an empty store and conflicts merge atomically', async t => {
  const source = await fixture(t), destination = await fixture(t, false);
  const download = source.page.waitForEvent('download');
  await source.page.getByRole('button', { name: 'Export memory JSON', exact: true }).click();
  const file = await download, path = join(source.root, 'memory.json'); await file.saveAs(path);
  const archive = JSON.parse(await readFile(path, 'utf8'));
  await destination.page.locator('#memory-import').setInputFiles(path);
  await destination.page.locator('#memory-import-result').filter({ hasText: '1 facts imported; 0 unchanged.' }).waitFor();
  await importDone(destination.page);
  assert.deepEqual(record(destination), record(source));
  await upload(destination.page, archive);
  assert.match(await destination.page.locator('#memory-import-result').innerText(), /0 facts imported; 1 unchanged/);
  const snapshot = JSON.stringify(destination.app.store.list('memory', 'local'));
  const conflict = structuredClone(archive);
  conflict.records.unshift({ ...structuredClone(archive.records[0]), id: 'new-fact' });
  conflict.records[1].data.text = 'Conflicting text';
  await upload(destination.page, conflict);
  assert.match(await destination.page.locator('#memory-import-result').innerText(), /conflicts/);
  assert.equal(JSON.stringify(destination.app.store.list('memory', 'local')), snapshot);
  await destination.page.locator('#memory-import').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await destination.page.locator('#memory-import-result').filter({ hasText: /valid memory JSON/ }).waitFor();
  assert.deepEqual([...source.errors, ...destination.errors], []);
});
