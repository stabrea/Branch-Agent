import test from 'node:test';
import { openSettingFor } from "./places.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

async function fixture(t) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-identity-ui-')), requests = [];
  const provider = { name: 'identity-fixture', complete: async request => {
    requests.push(structuredClone(request.messages)); return { content: 'Identity task complete', toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor({ state: 'visible', timeout: 120000 }); await openSettingFor(page, '#identity-name');
  return { page, requests, errors, server };
}
async function edit(page, name, instructions) {
  await page.getByLabel('Assistant name', { exact: true }).fill(name);
  await page.getByLabel('Working instructions', { exact: true }).fill(instructions);
}
/* DG-025: no Save button; a field is kept when you leave it. Waits for the save that carries these words. */
async function save(page) {
  const instructions = await page.locator('#identity-instructions').inputValue();
  const sent = page.waitForResponse(response => response.url().endsWith('/api/identity') && response.request().method() === 'POST'
    && response.request().postDataJSON().instructions === instructions);
  await page.locator('#identity-instructions').blur(); await sent;
  await page.locator('#identity-status').filter({ hasText: 'Identity saved.' }).waitFor();
}
async function controls(page, disabled) {
  for (const id of ['identity-name', 'identity-instructions'])
    assert.equal(await page.locator('#' + id).isDisabled(), disabled, id);
}
async function update(server, input) {
  const response = await fetch(new URL('/api/identity', server.url), { method: 'POST',
    headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.ok, true); return response.json();
}

test('identity saves across reload and the next task receives its name and instructions', async t => {
  const f = await fixture(t);
  assert.equal(await f.page.locator('#identity-name').inputValue(), 'Branch Agent');
  await edit(f.page, 'Juniper', 'Use concise answers and cite saved sources.'); await save(f.page);
  await f.page.reload(); await f.page.locator('#workspace').waitFor({ state: 'visible', timeout: 120000 });
  await openSettingFor(f.page, '#identity-name');
  assert.equal(await f.page.locator('#identity-name').inputValue(), 'Juniper');
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Use concise answers and cite saved sources.');
  assert.equal(await f.page.locator('.brand').count(), 0, 'the old assistant-name header is not built');
  assert.equal(await f.page.locator('#rail-target-name').innerText(), 'This computer', 'the sidebar identifies this computer, not the assistant');
  assert.match(await f.page.locator('.rail-maker').innerText(), /Branch Agent[\s\S]*by[\s\S]*KeepOak/i, 'the rail names the product and its maker');
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.BRANCH_IDENTITY_SCREENSHOT) {
    await f.page.evaluate(() => window.scrollTo(0, 0));
    await f.page.screenshot({ path: process.env.BRANCH_IDENTITY_SCREENSHOT, fullPage: true });
  }
  await f.page.locator('.lx-settings-close').click();
  await f.page.getByLabel('Your message', { exact: true }).fill('Start a task'); await f.page.locator('#send').click();
  await f.page.waitForFunction(() => !document.getElementById('send').disabled);
  const system = f.requests[0].find(message => message.role === 'system').content;
  assert.match(system, /Juniper/); assert.match(system, /Use concise answers and cite saved sources/);
  assert.deepEqual(f.errors, []);
});

test('identity draft and focus survive actual polling, including a blurred name field', async t => {
  const f = await fixture(t);
  await edit(f.page, 'Unsaved name', 'Draft instructions');
  await f.page.locator('#identity-instructions').evaluate(node => node.setSelectionRange(6, 18, 'backward'));
  await f.page.waitForResponse(response => response.url().endsWith('/api/state'));
  await f.page.waitForTimeout(100);
  assert.equal(await f.page.locator('#identity-name').inputValue(), 'Unsaved name');
  assert.deepEqual(await f.page.locator('#identity-instructions').evaluate(node => ({ focused: document.activeElement === node,
    start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })),
  { focused: true, start: 6, end: 18, direction: 'backward' });
  await f.page.keyboard.type('correction');
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Draft correction');
  assert.deepEqual(f.errors, []);
});

test('identity conflict retains draft until Reload, offered only then, discards it for saved values', async t => {
  const f = await fixture(t);
  assert.equal(await f.page.locator('#identity-reload').isVisible(), false);
  await f.page.locator('#identity-instructions').fill('Keep this draft on conflict');
  await update(f.server, { name: 'Newer saved identity', instructions: 'Other editor', expectedRevision: 0 });
  await f.page.locator('#identity-instructions').blur();
  await f.page.locator('#identity-status').filter({ hasText: /changed/ }).waitFor();
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Keep this draft on conflict');
  await controls(f.page, false);
  await f.page.locator('#identity-reload').click();
  await f.page.locator('#identity-status').filter({ hasText: 'Saved identity loaded.' }).waitFor();
  assert.equal(await f.page.locator('#identity-name').inputValue(), 'Newer saved identity');
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Other editor');
  assert.equal(await f.page.locator('#identity-reload').isVisible(), false);
  await edit(f.page, 'Final identity', 'Final instructions'); await save(f.page);
  assert.deepEqual(f.errors, []);
});

test('a save on its way leaves the fields usable, and a failed one keeps the draft', async t => {
  const f = await fixture(t); let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  await f.page.route('**/api/identity', async route => {
    started(); await held;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Save unavailable"}' });
  });
  await f.page.locator('#identity-instructions').fill('Held instructions');
  await f.page.locator('#identity-instructions').blur(); await pending;
  await controls(f.page, false);
  await f.page.locator('#identity-instructions').focus();
  assert.equal(await f.page.locator('#identity-instructions').evaluate(node => document.activeElement === node), true);
  release(); await f.page.locator('#identity-status').filter({ hasText: 'Save unavailable' }).waitFor();
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Held instructions');
  assert.equal(await f.page.locator('#identity-reload').isVisible(), true);
  await f.page.unroute('**/api/identity');
  await f.page.locator('#identity-instructions').fill('Held instructions, kept'); await save(f.page);
  assert.equal(await f.page.locator('#identity-reload').isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test('Reload freezes the fields until saved values arrive', async t => {
  const f = await fixture(t); let release, started;
  await f.page.locator('#identity-instructions').fill('Unsaved instructions');
  await update(f.server, { name: 'Current saved identity', instructions: 'Current instructions', expectedRevision: 0 });
  await f.page.locator('#identity-instructions').blur();
  await f.page.locator('#identity-status').filter({ hasText: /changed/ }).waitFor();
  const held = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  await f.page.route('**/api/state', async route => {
    const response = await route.fetch(); started(); await held; await route.fulfill({ response });
  });
  await f.page.locator('#identity-reload').click(); await pending;
  await controls(f.page, true);
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Unsaved instructions');
  release(); await f.page.locator('#identity-status').filter({ hasText: 'Saved identity loaded.' }).waitFor();
  await controls(f.page, false);
  assert.equal(await f.page.locator('#identity-name').inputValue(), 'Current saved identity');
  assert.equal(await f.page.locator('#identity-instructions').inputValue(), 'Current instructions');
  // The window keeps asking for /api/state every 3 s: a route.fetch still running as the browser closes fails.
  await f.page.unrouteAll({ behavior: 'ignoreErrors' });
  assert.deepEqual(f.errors, []);
});
