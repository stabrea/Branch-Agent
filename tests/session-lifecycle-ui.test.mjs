import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  /* The page's own settling point is waited for on the very next line. The click itself
     therefore does not also wait on Playwright's generic after-the-click step, which on
     Chromium is a CDP round trip (`Page.enable`) and stalled for the whole thirty seconds on
     the loaded Windows checker. Nothing is waited for less: a real signal replaces a proxy. */
  await page.getByRole('button', { name: 'Connect', exact: true }).click({ noWaitAfter: true });
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  return { app, page, root, sourceId, original, errors };
}
/* Redesign: the new window (public/app/**). A conversation opens from its row in the sidebar list; the open one's row
   carries aria-current="true". Carrying a saved conversation on as a new one is the sidebar search's "Past sessions"
   result ([data-act="sr-sess"]) and its dialog's "Carry it on" ([data-act="sess-carry"], POST /api/sessions/{id}/duplicate),
   as in the prototype's showSession(). */
const row = (page, id) => page.locator(`#side [data-act="chat"][data-id="${id}"]`);
const currentId = (page) => page.evaluate(() => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
async function openConversation(page, id) {
  await row(page, id).click();
  await page.locator('#conversation').getByText('Saved response for', { exact: false }).first().waitFor();
}
async function pastSession(page, query, id) {
  await page.locator('#side-q').fill(query);
  await page.locator(`#side [data-act="sr-sess"][data-v="${id}"]`).click({ timeout: 10000 });
  return page.getByRole('button', { name: 'Carry it on', exact: true });
}
const card = (page, id) => page.locator(`#saved-list article[data-session-id="${id}"]`);
/* One step, inside the page: the notice area is found and read in the same breath, so a redraw
   between the two cannot answer for an instant the notice was not up. */
async function shown(page, pattern) {   // flagless patterns only: the source is rebuilt in the page
  await page.waitForFunction((source) => {
    const note = document.getElementById("toast");
    if (!note || !(note.checkVisibility?.() ?? !note.hidden)) return false;
    return new RegExp(source).test(note.textContent ?? "");
  }, pattern.source);
}
async function ready(page) { await page.waitForFunction(() => !document.getElementById('send').disabled); }
async function library(page, query = '') {
  if (!(await page.locator('#saved-history-dialog').isVisible())) {
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#cmd-input').fill('Conversation history');
    await page.locator('.cmd-item').filter({ hasText: 'Conversation history' }).click();
  }
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

/* Redesign: a conversation is exported from its own More menu (data-act="chatmenu" › "Export conversation",
   data-act="export-conv"). As the prototype's, it saves the engine's Markdown copy to Library › Documents
   (GET /api/sessions/<id>/export?format=markdown, then POST /api/documents), and downloads nothing. In the desktop app the
   engine's JSON archive also goes to the Save dialog through the guarded IPC (window.branchDesktop.exportConversation,
   branch:export-conversation, #362), stood in for here. */
test("Export conversation saves Markdown to Library › Documents, and hands the desktop app the JSON archive (the new window)", async (t) => {
  const f = await fixture(t);
  const documents = () => f.page.evaluate(async () => (await (await fetch('/api/documents', {
    headers: { authorization: 'Bearer ' + sessionStorage.getItem('branch-token') } })).json()).documents ?? []);
  const exportIt = async () => {
    await openConversation(f.page, f.sourceId);
    await f.page.locator('[data-act="chatmenu"]').first().click();
    await f.page.locator('#app > .pop [data-act="export-conv"]').click();
    await f.page.locator('.toast').filter({ hasText: 'Saved as Markdown to Library › Documents.' }).waitFor({ timeout: 30000 });
  };
  let downloads = 0; f.page.on('download', () => downloads++);
  const before = (await documents()).length;
  await exportIt();
  const docs = await documents();
  assert.equal(docs.length, before + 1, 'one document is added');
  assert.ok(docs.some((d) => d.name === `conversation-${f.sourceId.slice(0, 8)}.md`), 'the Markdown copy is in Library › Documents');
  assert.equal(downloads, 0, 'the browser downloads nothing');
  /* The desktop app's preload, stood in for: it records what the window hands the guarded export. */
  await f.page.addInitScript(() => { window.__handed = []; window.branchDesktop = Object.freeze({ exportConversation: async (text) => { window.__handed.push(text); return { saved: true }; } }); });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await exportIt();
  await f.page.waitForFunction(() => window.__handed.length === 1, null, { timeout: 15000 });
  const archive = JSON.parse(await f.page.evaluate(() => window.__handed[0]));
  assert.equal(archive.format, 'branch-agent-conversation');
  assert.deepEqual(archive.messages, f.app.store.messages(f.sourceId));
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original, 'exporting changes nothing');
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (the saved-conversations dialog with its search and "Load more conversations", and
// importing a conversation file, are not in the design; exporting is ported above).
test.skip('saved conversations search, paginate, export/import a JSON file, and resume after reload', async (t) => {
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
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await library(f.page, 'Juniper lifecycle');
  await card(f.page, imported).getByRole('button', { name: 'Open', exact: true }).click(); await ready(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), imported);
  assert.match(await f.page.locator('#session-label').innerText(), /Imported conversation/);
  await f.page.getByLabel('Your message', { exact: true }).fill('Continue the imported conversation');
  await f.page.locator('#send').click(); await ready(f.page);
  assert.equal(await f.page.locator('#conversation').getAttribute('data-session-id'), imported);
  assert.deepEqual(f.app.store.messages(imported), [...archive.messages,
    { role: 'user', content: 'Continue the imported conversation' },
    { role: 'assistant', content: 'Follow-up finished' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('duplicating a saved conversation preserves the source and follows up in the new ID', async (t) => {
  let received;
  const f = await fixture(t, { name: 'duplicate-fixture', complete: async request => {
    received = structuredClone(request.messages); return { content: 'Independent follow-up', toolCalls: [] };
  } });
  await (await pastSession(f.page, 'Juniper', f.sourceId)).click();
  await f.page.waitForFunction((source) => {
    const id = document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id;
    return id && id !== source;
  }, f.sourceId, { timeout: 20000 });
  await ready(f.page);
  const id = await currentId(f.page);
  assert.notEqual(id, f.sourceId); assert.deepEqual(f.app.store.messages(id), f.app.store.messages(f.sourceId));
  // Redesign: replaced by the new window (the "files and saved memory are shared" line is not in the design).
  await f.page.locator('#prompt').fill('A different path');
  await f.page.locator('#send').click();
  await f.page.locator('#conversation').getByText('Independent follow-up').waitFor({ timeout: 30000 }); await ready(f.page);
  assert.equal(await currentId(f.page), id, 'the follow-up is in the new conversation');
  assert.deepEqual(received.filter(message => message.role !== 'system'), [
    ...f.app.store.messages(f.sourceId), { role: 'user', content: 'A different path' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (importing a conversation file is not in the design).
test.skip('invalid and oversized import files report errors without changing the selected conversation', async (t) => {
  const f = await fixture(t); await library(f.page);
  await card(f.page, f.sourceId).getByRole('button', { name: 'Open', exact: true }).click(); await ready(f.page);
  for (const [buffer, expected] of [[Buffer.from('{broken'), /valid conversation JSON/], [Buffer.alloc(4 * 1024 * 1024 + 1), /at most 4 MiB/], [Buffer.from('{}'), /format|Invalid/]]) {
    await f.page.locator('#conversation-import').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer });
    await shown(f.page, expected); await ready(f.page);
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
  await openConversation(f.page, f.sourceId); await ready(f.page);
  await f.page.locator('#prompt').fill('Keep working'); await f.page.locator('#send').click(); await started.promise;
  // The prototype (the lead, 2026-09-26): while a task works, an empty box shows Stop instead of Send, and Send is not
  // disabled; a message typed then is queued through the engine's busy send.
  await f.page.locator('#send[aria-label="Stop"][data-act="stop-run"]').waitFor({ timeout: 10000 });
  /* Redesign: the design lets a person move between conversations while one works (rows show "Working"), and has no
     import (replaced by the new window). Carrying the source on while its answer is pending is still refused: read now,
     asserted last. */
  /* While searching, the results stand in the list's place (as the prototype's do), so no row says which conversation is
     open: the engine's refusal is waited for, the dialog closed and the search cleared before the open row is read. */
  const carry = await pastSession(f.page, 'Juniper', f.sourceId).then(async (button) => {
    await button.evaluate(b => b.click());
    await f.page.locator('.toast').filter({ hasText: "Wait for this conversation's active task" }).waitFor({ timeout: 10000 });
    await f.page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await f.page.locator('#side [data-act="sq-clear"]').click();
    return currentId(f.page);
  }).catch(error => error.message);
  release.resolve(); await ready(f.page);
  await f.page.locator('#conversation').getByText('finished', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await currentId(f.page), f.sourceId, 'the answer lands in the conversation it was asked in');
  assert.deepEqual(f.app.store.messages(f.sourceId).slice(-2).map(m => m.content), ['Keep working', 'finished']);
  assert.deepEqual(f.errors, []);
  assert.equal(carry, f.sourceId, 'Carry it on is held while a send is pending');
});

// Redesign: replaced by the new window (the "Retry opening conversation" button and importing a conversation file are
// not in the design; a failed read is the window's toast).
test.skip('failed duplicate or imported view retains each new ID and retry never creates another copy', async (t) => {
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
