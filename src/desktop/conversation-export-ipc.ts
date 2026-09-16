import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { saveBackupExport, saveConversationExport, saveMemoryExport } from './conversation-export.js';

export function registerConversationExportIpc(window: BrowserWindow, origin: string): void {
  let saving = false;
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error('Conversation export access denied');
  };
  const types = [
    { channel: 'branch:export-conversation', label: 'conversation history', name: 'conversation', save: saveConversationExport },
    { channel: 'branch:export-memory', label: 'saved memory', name: 'memory', save: saveMemoryExport },
    { channel: 'branch:export-backup', label: 'backup', name: 'backup', save: saveBackupExport },
  ];
  for (const type of types) ipcMain.handle(type.channel, async (event, text: unknown) => {
    authorized(event);
    if (saving) throw new Error('An archive export is already in progress');
    saving = true;
    try {
      return await type.save(text, async () => {
        const result = await dialog.showSaveDialog(window, {
          title: `Export ${type.label}`, defaultPath: `branch-${type.name}.json`,
          filters: [{ name: 'JSON archive', extensions: ['json'] }],
          properties: ['showOverwriteConfirmation'],
        });
        authorized(event);
        return result.canceled ? undefined : result.filePath;
      });
    } finally { saving = false; }
  });
  window.on('closed', () => { for (const type of types) ipcMain.removeHandler(type.channel); });
}
