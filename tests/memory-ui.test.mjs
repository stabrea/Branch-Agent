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
import { newWindow, openPlace as openNewPlace, placeRoot } from './new-window-places.mjs';

/* Redesign: the new window's Library › Memory (public/app/places/library.js) lists what is remembered with Forget, a
   "N of M remembered" ring, Tidy up, and a More menu that exports (JSON Lines or a full archive) and opens the archive.
   The prototype has no per-fact editor, no "Save memory" box, no limit field and no import box; tests of those are
   skipped as replaced, and what they proved of the engine is asked of its routes. */
async function windowFixture(t, seed = true) {
  const provider = { name: 'memory-ui', async complete(request) {
    const reply = request.messages.findLast(message => message.role === 'tool');
    if (reply) return { content: JSON.parse(reply.content).result[0].data.text, toolCalls: [] };
    return { content: '', toolCalls: [{ id: 'memory', name: 'memory.search', arguments: '{"query":"Juniper"}' }] };
  } };
  const f = await newWindow(t, { provider, seed: seed ? app => app.runtime.executeTool('memory.put', { text: 'Juniper meeting Monday', source: 'Original note' }) : undefined });
  await openNewPlace(f.page, 'library', 'memory');
  return f;
}
const importArchive = (f, body) => fetch(new URL('/api/memory/import', f.server.url), { method: 'POST',
  headers: { authorization: `Bearer ${f.server.token}`, 'content-type': 'application/json' }, body }).then(async r => ({ status: r.status, body: await r.json() }));

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
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 }); await openPlace(page, 'memory');
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

test.skip('opening the selected memory tab does not send a redundant browser click', async t => {
  // Redesign: replaced by the new window (a place's tab is one data-act="ptab" button that redraws the place; there is no .lx-tab panel to click twice).
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

test.skip('memory edits persist after reload and a new chat retrieves the corrected fact', async t => {
  // Redesign: replaced by the new window (Library › Memory in prototype.html lists facts with Forget only; there is no per-fact Edit).
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

test.skip('stale edits retain the draft and do not overwrite a newer fact; cancel discards the draft', async t => {
  // Redesign: replaced by the new window (no per-fact Edit in Library › Memory; prototype.html has none).
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

test.skip('polling preserves the open editor, focus, selection and continued typing', async t => {
  // Redesign: replaced by the new window (no per-fact Edit in Library › Memory; prototype.html has none).
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

test.skip('an older pending save cannot discard a reopened editor draft', async t => {
  // Redesign: replaced by the new window (no per-fact Edit in Library › Memory; prototype.html has none).
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

test.skip('failed pending memory save restores both fields with the original draft intact', async t => {
  // Redesign: replaced by the new window (no per-fact Edit in Library › Memory; prototype.html has none).
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
  // Redesign: the limit is set through the engine (POST /api/memory/capacity; prototype.html has no limit field), and the
  // window's ring reads what the engine keeps.
  const f = await windowFixture(t), ring = placeRoot(f.page).locator('.memst15');
  assert.deepEqual(await f.call('/api/memory/capacity', { maxFacts: 1 }), { count: 1, maxFacts: 1 });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(f.page, 'library', 'memory');
  await ring.filter({ hasText: '1 of 1 remembered' }).waitFor();
  const refused = await f.call('/api/action', { tool: 'memory.put', args: { text: 'Extra fact', source: 'Typed here' } });
  assert.match(JSON.stringify(refused), /capacity reached/);
  assert.equal(f.app.store.list('memory', 'local').length, 1);
  assert.deepEqual(await f.call('/api/memory/capacity', { maxFacts: 2 }), { count: 1, maxFacts: 2 });
  await f.call('/api/action', { tool: 'memory.put', args: { text: 'Extra fact', source: 'Typed here' } });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(f.page, 'library', 'memory');
  await ring.filter({ hasText: '2 of 2 remembered' }).waitFor();
  assert.match(await placeRoot(f.page).innerText(), /Juniper meeting Monday[\s\S]*Extra fact|Extra fact[\s\S]*Juniper meeting Monday/);
  assert.match(JSON.stringify(await f.call('/api/memory/capacity', { maxFacts: 1 })), /below the current count/);
  assert.deepEqual(f.errors, []);
});

test.skip('capacity draft survives blur and polling, and a pending save preserves newer input', async t => {
  // Redesign: replaced by the new window (the limit is read in the "N of M remembered" ring; prototype.html has no limit field to draft in).
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
  // Redesign: the archive is saved from Library › Memory's More menu ("Save a full archive"); prototype.html has no import
  // box, so the file goes back in through the engine's own route (POST /api/memory/import).
  const source = await windowFixture(t), destination = await windowFixture(t, false);
  await placeRoot(source.page).locator('[data-act="memmore15"]').click();
  const download = source.page.waitForEvent('download');
  await source.page.locator('.pop [data-act="memexp15"][data-v="archive"]').click();
  const file = await download, path = join(source.root, 'memory.json'); await file.saveAs(path);
  const archive = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(await importArchive(destination, JSON.stringify(archive)), { status: 200, body: { imported: 1, unchanged: 0 } });
  assert.deepEqual(record(destination), record(source));
  await destination.page.reload(); await destination.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(destination.page, 'library', 'memory');
  await placeRoot(destination.page).getByText('Juniper meeting Monday').waitFor();
  assert.deepEqual((await importArchive(destination, JSON.stringify(archive))).body, { imported: 0, unchanged: 1 });
  const snapshot = JSON.stringify(destination.app.store.list('memory', 'local'));
  const conflict = structuredClone(archive);
  conflict.records.unshift({ ...structuredClone(archive.records[0]), id: 'new-fact' });
  conflict.records[1].data.text = 'Conflicting text';
  assert.match((await importArchive(destination, JSON.stringify(conflict))).body.error, /conflicts/);
  assert.equal(JSON.stringify(destination.app.store.list('memory', 'local')), snapshot);
  const broken = await importArchive(destination, '{broken');
  assert.equal(broken.status, 400);
  assert.deepEqual([...source.errors, ...destination.errors], []);
});
