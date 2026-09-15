import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright';
import { saveConversationExport } from '../dist/desktop/conversation-export.js';
import { desktopOptions } from './fixtures/desktop-options.mjs';

const archive = { format: 'branch-agent-conversation', version: 1, exportedAt: '2026-09-15T00:00:00.000Z',
  messages: [{ role: 'user', content: 'Export fixture' }, { role: 'assistant', content: 'Saved response' }] };

test('native export validates text before choosing a file and writes only a chosen destination', async (t) => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-export-')), path = join(root, 'conversation.json');
  t.after(() => rm(root, { recursive: true, force: true }));
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

test('native conversation export uses guarded IPC and leaves the blanket download blocker enabled', { timeout: 90000 }, async () => {
  const { home, options } = await desktopOptions(), path = join(home, 'exported-conversation.json');
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow(); page.setDefaultTimeout(10000);
    await page.getByText('Connected', { exact: true }).waitFor();
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
    await page.getByLabel('Your message', { exact: true }).fill('Export the demo conversation');
    await page.locator('#send').click(); await page.waitForFunction(() => !document.getElementById('send').disabled);
    await page.locator('#saved-conversations summary').click();
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
  } finally { await electron.close(); }
});

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
  } finally { await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id); }
}
