// UI preload: narrow IPC surface.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cq', {
  getState: () => ipcRenderer.invoke('cq:get-state'),
  getDisplays: () => ipcRenderer.invoke('cq:get-displays'),
  set: (patch) => ipcRenderer.send('cq:set', patch),
  getProfiles: () => ipcRenderer.invoke('cq:get-profiles'),
  getNativeStatus: () => ipcRenderer.invoke('cq:get-native-status'),
  configureProfile: (options) => ipcRenderer.invoke('cq:configure-profile', options),
  setProfile: (id) => ipcRenderer.send('cq:set-profile', { id }),
  createProfile: (name) => ipcRenderer.send('cq:create-profile', { name }),
  deleteProfile: (id) => ipcRenderer.send('cq:delete-profile', { id }),
  renameProfile: (id, name) => ipcRenderer.send('cq:rename-profile', { id, name }),
  startStreamer: (port) => ipcRenderer.invoke('cq:streamer-start', { port }),
  stopStreamer: () => ipcRenderer.invoke('cq:streamer-stop'),
  getStreaming: () => ipcRenderer.invoke('cq:get-streaming'),
  getStartupStatus: () => ipcRenderer.invoke('cq:get-startup-status'),
  setStartup: (enabled) => ipcRenderer.invoke('cq:set-startup', enabled),
  browseGameExecutable: () => ipcRenderer.invoke('cq:browse-game-executable'),
  windowControl: (action) => ipcRenderer.send('cq:window-control', action),
  onState: (fn) => ipcRenderer.on('cq:state', (_e, state) => fn(state)),
});
