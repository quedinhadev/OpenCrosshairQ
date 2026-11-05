// Mock preload for visual QA of update panel – isolated, safe, no IPC.
const { contextBridge } = require('electron');

const mockState = {
  model: {},
  layers: [],
  scale: 1,
  visible: true,
  keybinds: {
    globalShortcut: { enabled: false },
    aim: { pressType: 'toggle' },
    global: { enabled: false }
  },
  displayId: 1,
  profiles: { currentProfileId: 'default' }
};

const listeners = new Set();
let updateCallback = null;

contextBridge.exposeInMainWorld('cq', {
  getState: async () => ({
    model: {},
    layers: [],
    scale: 1,
    visible: true,
    keybinds: {
      globalShortcut: { enabled: false },
      aim: { pressType: 'toggle' },
      global: { enabled: false }
    },
    displayId: 1,
    profiles: { currentProfileId: 'default' }
  }),
  getDisplays: async () => [{ id: 1, label: 'Monitor 1', bounds: { width: 1920, height: 1080 } }],
  getProfiles: async () => [{ id: 'default', name: 'Default' }],
  getNativeStatus: async () => ({ available: true }),
  getStreaming: async () => ({ running: false }),
  getStartupStatus: async () => ({ supported: true, available: true, enabled: false }),
  set: async (patch) => {
    if (patch && typeof patch === 'object') Object.assign(mockState, patch);
  },
  configureProfile: async () => null,
  setProfile: async () => {},
  createProfile: async () => {},
  deleteProfile: async () => {},
  renameProfile: async () => {},
  startStreamer: async () => {},
  stopStreamer: async () => {},
  getUpdateState: async () => ({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'idle',
    version: null,
    progress: null,
    error: null,
    reason: null
  }),
  checkForUpdates: async () => ({ supported: true, currentVersion: '0.9.5', phase: 'idle' }),
  installUpdate: async () => ({ supported: true, currentVersion: '0.9.5', phase: 'installing' }),
  onUpdateState: (fn) => {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  },
  onState: (fn) => {
    // No state changes in mock.
    return () => {};
  },
  windowControl: () => {},
  // Test helper exposed through cq for isolated runner.
  __testEmitUpdate: (state) => {
    listeners.forEach(fn => {
      try { fn(state); } catch {}
    });
  }
});
