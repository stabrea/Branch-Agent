import test from 'node:test';
import { openPlace } from "./places.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { _electron } from 'playwright';
import { saveConversationExport, saveMemoryExport } from '../dist/desktop/conversation-export.js';
import { connected, desktopOptions, STARTUP_MS } from './fixtures/desktop-options.mjs';

/* Redesign phase 1: a conversation begun in the window starts on Ask first, and the practice run writes
   a file. This checks the desktop app, so its conversation follows the setting as before
   (tests/conversation-mode.test.mjs covers Ask first). */
const followSetting = (page) => page.evaluate(async () => {
  await fetch("/api/conversation-mode/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newConversation: "follow" }) });
  await globalThis.branchConversationMode?.refresh();
});

const archive = { format: 'branch-agent-conversation', version: 1, exportedAt: '2026-09-15T00:00:00.000Z',
  messages: [{ role: 'user', content: 'Export fixture' }, { role: 'assistant', content: 'Saved response' }] };
const memoryArchive = { format: 'branch-agent-memory', version: 1, exportedAt: archive.exportedAt,
  records: [{ id: 'memory-fixture', data: { text: 'Saved fact', source: 'Fixture', sourceRunId: '' },
    createdAt: archive.exportedAt, updatedAt: archive.exportedAt, revision: 1 }] };

test('native export validates text before choosing a file and writes only a chosen destination', async (t) => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-export-')), path = join(root, 'conversation.json');
  t.after(() => discardTemp(root));
  let dialogs = 0;
  const choose = async () => { dialogs++; return path; };
  for (const value of [archive, '{broken', '{}', '☃'.repeat(1500000), JSON.stringify({ ...archive, path })])
    await assert.rejects(saveConversationExport(value, choose));
  assert.equal(dialogs, 0);
  assert.deepEqual(await saveConversationExport(JSON.stringify(archive), async () => undefined), { saved: false });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await saveConversationExport(JSON.stringify(archive), choose), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), archive);
  assert.equal(dialogs, 1);
});

test('native memory export validates archive and raw UTF8 size before opening the save dialog', async t => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-memory-export-')), path = join(root, 'memory.json');
  t.after(() => discardTemp(root));
  let dialogs = 0; const choose = async () => { dialogs++; return path; };
  for (const value of [memoryArchive, '{}', JSON.stringify(archive), '☃'.repeat(5600000), JSON.stringify({ ...memoryArchive, path })])
    await assert.rejects(saveMemoryExport(value, choose));
  assert.equal(dialogs, 0);
  assert.deepEqual(await saveMemoryExport(JSON.stringify(memoryArchive), async () => undefined), { saved: false });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await saveMemoryExport(JSON.stringify(memoryArchive), choose), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), memoryArchive);
});

test('native conversation export uses guarded IPC and leaves the blanket download blocker enabled', { timeout: 360000 }, async () => {
  const { home, options } = await desktopOptions(), path = join(home, 'exported-conversation.json');
  const electron = await _electron.launch(options);
  try {
    // Each click waits for the window to take it. With other desktop files starting beside it, a
    // loaded CI Mac spent over ten seconds on the Send click alone (Playwright's log ended at
    // "performing click action", with nothing covering the button), so every step gets a minute.
    const page = await electron.firstWindow(); page.setDefaultTimeout(60000);
    await connected(page);
    // History is on demand, not a disclosure built into the conversation thread.
    await electron.evaluate(({ dialog }, path) => {
      globalThis.fixtureExportDialogs = [];
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.fixtureExportDialogs.push(options);
        return { canceled: false, filePath: path };
      };
    }, path);
    const invalid = await page.evaluate(() => window.branchDesktop.exportConversation('{}').then(() => 'allowed', error => error.message));
    assert.notEqual(invalid, 'allowed');
    assert.equal(await electron.evaluate(() => globalThis.fixtureExportDialogs.length), 0);
    // The message box can still be settling (the welcome card, the first state load) just after
    // "Connected" shows; a loaded CI Mac took longer than the ten-second default. Wait for the box
    // itself to take typing, with the same allowance as the start-up.
    await page.getByLabel('Your message', { exact: true }).fill('Export the demo conversation', { timeout: STARTUP_MS });
    await followSetting(page);
    await page.locator('#send').click();
    // Waiting for a whole task to finish, not for the page to paint: the model answers, the reply is
    // written down and the conversation is saved before Send comes back. Ten seconds is enough on a
    // desktop and not on a loaded build machine, where this timed out at 32 seconds having done
    // nothing wrong. The wait is widened here rather than anything in the app being made faster.
    await page.waitForFunction(() => !document.getElementById('send').disabled, undefined, { timeout: 120000 });
    await page.keyboard.press('Control+k');
    await page.locator('#cmd-input').fill('Conversation history');
    await page.locator('.cmd-item').filter({ hasText: 'Conversation history' }).click();
    await page.locator('#saved-list').getByRole('button', { name: 'Export JSON', exact: true }).first().click();
    await page.locator('#toast').filter({ hasText: 'Conversation exported.' }).waitFor();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.format, 'branch-agent-conversation');
    assert.equal(saved.messages[0].content, 'Export the demo conversation');
    assert.equal(saved.messages.at(-1).role, 'assistant');
    const dialogs = await electron.evaluate(() => globalThis.fixtureExportDialogs);
    assert.equal(dialogs.length, 1); assert.deepEqual(dialogs[0].filters[0].extensions, ['json']);
    assert.equal(await downloadBlocked(electron), true);
    await rejectOtherWindow(electron, page.url());
    await exportNativeMemory(electron, page, path);
  } finally { await electron.close(); }
});

async function exportNativeMemory(electron, page, path) {
  const invalid = await page.evaluate(() => window.branchDesktop.exportMemory('{}').then(() => 'allowed', error => error.message));
  assert.notEqual(invalid, 'allowed');
  await openPlace(page, 'memory');
  await page.locator('#memory-text').fill('Native exported memory');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.locator('#memory-count').filter({ hasText: '1 of 500' }).waitFor();
  await page.getByRole('button', { name: 'Export memory JSON', exact: true }).click();
  await page.locator('#toast').filter({ hasText: 'Memory exported.' }).waitFor();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.format, 'branch-agent-memory');
  assert.equal(saved.records[0].data.text, 'Native exported memory');
  assert.equal(saved.records[0].revision, 1);
  const dialogs = await electron.evaluate(() => globalThis.fixtureExportDialogs);
  assert.equal(dialogs.length, 2); assert.equal(dialogs[1].defaultPath, 'branch-memory.json');
}

async function downloadBlocked(electron) {
  return electron.evaluate(({ BrowserWindow }) => {
    let blocked = false;
    BrowserWindow.getAllWindows()[0].webContents.session.emit('will-download', { preventDefault() { blocked = true; } });
    return blocked;
  });
}
async function rejectOtherWindow(electron, url) {
  const opened = electron.waitForEvent('window');
  const id = await electron.evaluate(({ app, BrowserWindow }, url) => {
    const other = new BrowserWindow({ show: false, webPreferences: {
      preload: `${app.getAppPath()}/dist/desktop/preload.cjs`, sandbox: true, contextIsolation: true,
    } });
    void other.loadURL(url); return other.id;
  }, url);
  try {
    const other = await opened;
    const result = await other.evaluate(text => window.branchDesktop.exportConversation(text).then(() => 'allowed', error => error.message), JSON.stringify(archive));
    assert.match(result, /access denied/);
    const memory = await other.evaluate(text => window.branchDesktop.exportMemory(text).then(() => 'allowed', error => error.message), JSON.stringify(memoryArchive));
    assert.match(memory, /access denied/);
  } finally { await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id); }
}
