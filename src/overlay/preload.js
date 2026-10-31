// Overlay preload: exposes only the state subscription (no Node in the renderer,
// mirroring the original's isolated overlay preload).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cq', {
  onState: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on('cq:state', listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener('cq:state', listener);
    };
  },
  onInput: (fn) => {
    const listener = (_e, input) => fn(input);
    ipcRenderer.on('cq:input', listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener('cq:input', listener);
    };
  },
});
