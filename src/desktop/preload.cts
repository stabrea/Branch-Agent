import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("branchDesktop", Object.freeze({
  modelSettings: () => ipcRenderer.invoke("branch:model-settings"),
  saveModelSettings: (settings: unknown) =>
    ipcRenderer.invoke("branch:save-model-settings", settings),
  exportConversation: (text: unknown) =>
    ipcRenderer.invoke("branch:export-conversation", text),
  exportMemory: (text: unknown) => ipcRenderer.invoke("branch:export-memory", text),
  exportBackup: (text: unknown) => ipcRenderer.invoke("branch:export-backup", text),
  updateStatus: () => ipcRenderer.invoke("branch:update-status"),
  checkForUpdates: () => ipcRenderer.invoke("branch:update-check"),
  installUpdate: () => ipcRenderer.invoke("branch:update-install"),
  openExternal: (url: unknown) => ipcRenderer.invoke("branch:open-external", url),
  restartBranch: () => ipcRenderer.invoke("branch:restart"),
  windowLook: (dark: unknown) => ipcRenderer.invoke("branch:window-look", dark),
}));
