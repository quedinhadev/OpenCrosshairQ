// Designer preload: narrow IPC surface (same as the settings UI).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cq', {
  getState: () => ipcRenderer.invoke('cq:get-state'),
  set: (patch) => ipcRenderer.send('cq:set', patch),
  onState: (fn) => ipcRenderer.on('cq:state', (_e, state) => fn(state)),
});
