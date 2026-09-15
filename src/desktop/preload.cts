import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("branchDesktop", Object.freeze({
  modelSettings: () => ipcRenderer.invoke("branch:model-settings"),
  saveModelSettings: (settings: unknown) =>
    ipcRenderer.invoke("branch:save-model-settings", settings),
  exportConversation: (text: unknown) =>
    ipcRenderer.invoke("branch:export-conversation", text),
}));
