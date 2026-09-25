import test from 'node:test';
import { openPlace } from "./places.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

const document = (name, body) => `---\nname: ${name}\ndescription: Use this skill for local fixture checks.\nallowed-tools: files.read\n---\n\n${body}\n`;
async function fixture(t, provider = { name: 'skill-fixture', complete: async () => ({ content: 'Done', toolCalls: [] }) }) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-skills-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 }); await openPlace(page, 'skills');
  const api = async (path, body) => {
    const response = await fetch(new URL('/api/' + path, server.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.ok, true); return response.json();
  };
  return { page, api, errors };
}
async function settled(page) { await page.waitForFunction(() => !document.getElementById('skill-save').disabled); }
async function install(f, text = document('juniper', 'Version one body')) {
  await f.page.locator('#skill-document').fill(text); await f.page.locator('#skill-save').click(); await settled(f.page);
  return (await f.api('state')).skills[0];
}
async function view(f) { const [skill] = (await f.api('state')).skills; return f.api('skills/' + skill.id); }

test('single-file skill import, version editing, retained activation, disabling and removal', async t => {
  const f = await fixture(t), first = document('juniper', 'Version one body');
  await f.page.locator('#skill-import').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(first) });
  await settled(f.page); assert.equal(await f.page.locator('#skill-document').inputValue(), first);
  assert.equal((await f.api('state')).skills.length, 0);
  await f.page.locator('#skill-save').click(); await settled(f.page);
  assert.equal((await view(f)).activeVersion, 1);
  await f.page.locator('#skill-document').fill(document('juniper-updated', 'Version two body'));
  await f.page.locator('#skill-save').click(); await settled(f.page);
  assert.equal((await view(f)).headVersion, 2); assert.equal((await view(f)).activeVersion, 1);
  await f.page.locator('#skill-version').selectOption('2'); await f.page.locator('#skill-activate').click(); await settled(f.page);
  assert.equal((await view(f)).activeVersion, 2);
  await f.page.locator('#skill-version').selectOption('1'); await f.page.locator('#skill-read').click(); await settled(f.page);
  assert.equal(await f.page.locator('#skill-document').inputValue(), first);
  await f.page.locator('#skill-activate').click(); await settled(f.page);
  assert.equal((await view(f)).activeVersion, 1);
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.BRANCH_SKILLS_SCREENSHOT) {
    await f.page.evaluate(() => window.scrollTo(0, 0));
    await f.page.screenshot({ path: process.env.BRANCH_SKILLS_SCREENSHOT, fullPage: true });
  }
  await f.page.locator('#skill-disable').click(); await settled(f.page);
  assert.equal((await view(f)).activeVersion, null);
  await f.page.locator('#skill-remove').click(); await settled(f.page);
  assert.equal((await f.api('state')).skills.length, 0);
  assert.deepEqual(f.errors, []);
});

test('invalid skill documents and oversized file imports leave saved skills unchanged', async t => {
  const f = await fixture(t); await install(f);
  const before = await view(f);
  await f.page.locator('#skill-document').fill('Missing YAML frontmatter');
  await f.page.locator('#skill-save').click(); await settled(f.page);
  assert.notEqual(await f.page.locator('#skill-status').innerText(), 'Skill changes ready.');
  assert.deepEqual(await view(f), before);
  for (const buffer of [Buffer.alloc(48 * 1024 + 1), Buffer.from('a'.repeat(16001))]) {
    await f.page.locator('#skill-import').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer });
    await settled(f.page); assert.match(await f.page.locator('#skill-status').innerText(), /at most/);
    assert.equal(await f.page.locator('#skill-document').inputValue(), 'Missing YAML frontmatter');
  }
  assert.deepEqual(await view(f), before); assert.deepEqual(f.errors, []);
});

test('skill draft focus survives polling and stale save retains edits until explicit reload', async t => {
  const f = await fixture(t), skill = await install(f);
  await f.page.locator('#skill-document').fill(document('draft-name', 'Unsaved draft text'));
  await f.page.locator('#skill-document').evaluate(node => node.setSelectionRange(5, 10, 'backward'));
  await f.page.waitForResponse(response => response.url().endsWith('/api/state')); await f.page.waitForTimeout(100);
  assert.deepEqual(await f.page.locator('#skill-document').evaluate(node => ({ focused: document.activeElement === node,
    start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })),
  { focused: true, start: 5, end: 10, direction: 'backward' });
  const newer = await f.api(`skills/${skill.id}/update`, { expectedRevision: skill.revision, document: document('newer', 'Other editor') });
  await f.page.locator('#skill-save').click(); await settled(f.page);
  assert.match(await f.page.locator('#skill-status').innerText(), /changed|revision|stale|Reload/i);
  assert.equal(await f.page.locator('#skill-document').inputValue(), document('draft-name', 'Unsaved draft text'));
  await f.page.locator('#skill-reload').click(); await settled(f.page);
  assert.equal(await f.page.locator('#skill-document').inputValue(), newer.document);
  assert.deepEqual(f.errors, []);
});

test('pending skill saves lock all controls and ignore duplicate or switching handlers', async t => {
  const f = await fixture(t), skill = await install(f); let release, started, calls = 0;
  const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; });
  await f.page.route(`**/api/skills/${skill.id}/update`, async route => {
    calls++; started(); await held; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Retry save"}' });
  });
  const draft = document('pending-draft', 'Do not discard');
  await f.page.locator('#skill-document').fill(draft); await f.page.locator('#skill-save').click(); await pending;
  assert.equal(await f.page.locator('#skills').evaluate(node => [...node.querySelectorAll('button,input,textarea,select')].every(control => control.disabled)), true);
  await f.page.locator('#skill-new').evaluate(node => node.dispatchEvent(new Event('click')));
  await f.page.locator('#skill-form').evaluate(node => node.dispatchEvent(new Event('submit', { cancelable: true })));
  assert.equal(calls, 1); release(); await settled(f.page);
  assert.equal(await f.page.locator('#skill-document').inputValue(), draft);
  assert.equal(await f.page.locator('#skill-document').isEnabled(), true);
  assert.match(await f.page.locator('#skill-status').innerText(), /Retry save/);
  assert.deepEqual(f.errors, []);
});

test('a task discovers skill metadata and reads the selected active document through skills.read', async t => {
  let id, readDocument;
  const selected = document('juniper-selected', 'SELECTED_BODY_ONLY_AFTER_READ');
  const provider = { name: 'skill-reader-fixture', async complete(request) {
    const reply = request.messages.findLast(message => message.role === 'tool');
    if (reply) {
      const result = JSON.parse(reply.content).result;
      assert.equal(result.id, id); assert.equal(result.version, 2);
      readDocument = result.document;
      return { content: 'Selected skill instructions loaded.', toolCalls: [] };
    }
    const initial = JSON.stringify(request.messages);
    assert.match(initial, /juniper-selected/);
    assert.doesNotMatch(initial, /SELECTED_BODY_ONLY_AFTER_READ/);
    return { content: '', toolCalls: [{ id: 'read-selected', name: 'skills.read', arguments: JSON.stringify({ id, version: 2 }) }] };
  } };
  const f = await fixture(t, provider); id = (await install(f)).id;
  await f.page.locator('#skill-document').fill(selected);
  await f.page.locator('#skill-save').click(); await settled(f.page);
  await f.page.locator('#skill-version').selectOption('2'); await f.page.locator('#skill-activate').click(); await settled(f.page);
  await openPlace(f.page, 'chat');
  await f.page.getByLabel('Your message', { exact: true }).fill('Use the installed Juniper skill.');
  await f.page.locator('#send').click(); await f.page.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal(readDocument, selected);
  assert.match(await f.page.locator('#conversation').innerText(), /Selected skill instructions loaded/);
  assert.deepEqual(f.errors, []);
});
