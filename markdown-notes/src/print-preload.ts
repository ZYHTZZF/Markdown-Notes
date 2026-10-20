import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('pdfDocument', {
  source: () => ipcRenderer.invoke('pdf:source'),
  ready: (ok: boolean) => ipcRenderer.invoke('pdf:ready', ok === true),
});
