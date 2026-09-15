import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { saveConversationExport } from './conversation-export.js';

export function registerConversationExportIpc(window: BrowserWindow, origin: string): void {
  let saving = false;
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error('Conversation export access denied');
  };
  ipcMain.handle('branch:export-conversation', async (event, text: unknown) => {
    authorized(event);
    if (saving) throw new Error('A conversation export is already in progress');
    saving = true;
    try {
      return await saveConversationExport(text, async () => {
        const result = await dialog.showSaveDialog(window, {
          title: 'Export conversation history', defaultPath: 'branch-conversation.json',
          filters: [{ name: 'Conversation JSON', extensions: ['json'] }],
          properties: ['showOverwriteConfirmation'],
        });
        authorized(event);
        return result.canceled ? undefined : result.filePath;
      });
    } finally { saving = false; }
  });
  window.on('closed', () => ipcMain.removeHandler('branch:export-conversation'));
}
