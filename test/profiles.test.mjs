import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { saveProfile, loadProfiles, deleteProfileFile, configureProfile } = require('../src/main/profiles.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-profiles-'));
try {
  const registry = { default: { id: 'default', settings: {} }, a: { id: 'a', settings: {} }, b: { id: 'b', settings: {} } };
  const options = { id: 'a', processPath: 'C:\\Games\\Game.exe', hideCrosshairWhenUnfocused: true };
  const updated = configureProfile(registry, options);
  assert.equal(updated.process.path, options.processPath);
  assert.equal(updated.process.name, 'Game.exe');
  assert.equal(updated.hideCrosshairWhenUnfocused, true);
  registry.a = updated;
  assert.throws(() => configureProfile(registry, { ...options, id: 'b' }), /already/i);
  assert.throws(() => configureProfile(registry, { ...options, id: 'default' }), /default/i);
  for (const invalid of ['relative.exe', 'C:relative.exe', 'C:\\x.txt', 'C:\\x\u0000.exe', '\\\\server\\share\\x.exe']) {
    assert.throws(() => configureProfile(registry, { ...options, processPath: invalid }), /path/i);
  }
  assert.throws(() => configureProfile(registry, { ...options, hideCrosshairWhenUnfocused: 'true' }), /boolean/i);
  const cleared = configureProfile(registry, { ...options, processPath: null });
  assert.equal(cleared.process, null);
  assert.equal(cleared.hideCrosshairWhenUnfocused, false);
  saveProfile(dir, updated);
  assert.deepEqual(loadProfiles(dir).profiles.a, updated);
  assert.throws(() => saveProfile(dir, { id: '../escape' }), /id/i);
  assert.throws(() => deleteProfileFile(dir, '../escape'), /id/i);
  fs.writeFileSync(path.join(dir, 'profiles', 'malformed.json'), '{');
  assert.equal(Object.keys(loadProfiles(dir).profiles).length, 1);
  deleteProfileFile(dir, 'a');
  assert.deepEqual(loadProfiles(dir).profiles, {});

  // BACK-6: recovery from orphan .tmp when target .json is missing
  const orphanProf = { id: 'recovered', settings: { scale: 2 } };
  fs.writeFileSync(path.join(dir, 'profiles', 'recovered.json.tmp'), JSON.stringify(orphanProf));
  const recoveredResult = loadProfiles(dir);
  assert.deepEqual(recoveredResult.profiles.recovered, orphanProf, 'orphan .tmp recovered into profile directory');
  assert.ok(fs.existsSync(path.join(dir, 'profiles', 'recovered.json')), 'target .json created on recovery');
  assert.ok(!fs.existsSync(path.join(dir, 'profiles', 'recovered.json.tmp')), 'temporary removed after recovery');

  // BACK-6: cleanup of stale .tmp when target .json already exists
  fs.writeFileSync(path.join(dir, 'profiles', 'recovered.json.tmp'), 'stale garbage');
  loadProfiles(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'profiles', 'recovered.json.tmp')), 'stale .tmp cleaned up');

  deleteProfileFile(dir, 'recovered');
  assert.deepEqual(loadProfiles(dir).profiles, {});
  console.log('PASS: profile process validation + persistence + path boundaries');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// Run main handlers with window/native stubs: no Electron process or visible window.
const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-profiles-'));
try {
  const handlers = new Map();
  const events = new Map();
  const sends = [];
  const active = new Map();
  const shortcutCalls = [];
  let acceptShortcut = true;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  class Window {
    constructor() { this.webContents = { send: (channel, state) => sends.push({ channel, state }), setZoomFactor() {} }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() {} once() {} on() {} setBounds() {} isDestroyed() { return false; }
  }
  const app = { whenReady: () => Promise.resolve(), getPath: () => ipcDir, once() {}, on() {} };
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: { on: (channel, fn) => events.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) },
    globalShortcut: {
      register(combo, callback) {
        shortcutCalls.push(['register', combo]);
        if (!acceptShortcut || active.has(combo)) return false;
        active.set(combo, callback); return true;
      },
      unregister(combo) { shortcutCalls.push(['unregister', combo]); active.delete(combo); },
      unregisterAll() { active.clear(); },
    },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, on() {} },
  };
  const localRequire = createRequire(new URL('../src/main/main.js', import.meta.url));
  const monitor = () => ({ getStatus: () => ({ available: false, foreground: null }), start() {}, stop() {} });
  const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './foreground') return { createForegroundMonitor: monitor };
      if (name === './input') return { createInputMonitor: monitor };
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'), console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const get = () => handlers.get('cq:get-state')();
  const send = (channel, payload) => events.get(channel)({}, payload);
  send('cq:set', { hidden: true });
  send('cq:create-profile', { name: 'Hidden profile' });
  const second = get().profiles.currentProfileId;
  assert.notEqual(second, 'default');
  send('cq:set', { hidden: false });
  send('cq:set-profile', { id: 'default' });
  assert.equal(get().hidden, true, 'profile switch restores hidden');
  send('cq:set-profile', { id: second });
  assert.equal(get().hidden, false, 'second profile restores its own hidden');
  assert.equal(loadProfiles(ipcDir).profiles.default.settings.hidden, true, 'hidden persisted in PROFILE_KEYS');
  assert.equal(loadProfiles(ipcDir).profiles[second].settings.hidden, false);
  for (const patch of [{ scale: 'abc' }, { hidden: 'yes' }, { offsetX: null }, { crosshairOffset: { x: 'bad' } }, { onlyInGame: 1 }, { profileDetectionEnabled: 'yes' }]) {
    const before = fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8');
    send('cq:set', patch);
    assert.equal(fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8'), before, 'invalid IPC leaves disk untouched');
    assert.match(get().validationError, /Configuração rejeitada/);
  }
  const selected = get().profiles.currentProfileId;
  send('cq:set', { profileInFocus: false, profiles: { currentProfileId: 'missing' }, scale: 2 });
  assert.equal(get().profiles.currentProfileId, selected, 'renderer cannot change registry');
  assert.equal(get().profileInFocus, true, 'renderer cannot change focus');
  assert.equal(get().scale, 2);
  const original = fs.renameSync;
  const before = get().scale;
  try {
    fs.renameSync = () => { throw new Error('disk unavailable'); };
    send('cq:set', { scale: 3 });
  } finally { fs.renameSync = original; }
  assert.equal(get().scale, before, 'IPC write failure leaves memory untouched');
  assert.match(get().validationError, /disk unavailable/);
  assert.equal(sends.at(-1).state.scale, before, 'IPC broadcasts old state with error');
  const originalBinding = structuredClone(get().keybinds);
  const replacement = structuredClone(originalBinding);
  replacement.globalShortcut.pc = { modifiers: ['Ctrl', 'Shift'], key: 'K' };
  const originalCombo = 'Alt+Shift+Z', newCombo = 'Control+Shift+K';
  const originalDisk = fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8');
  acceptShortcut = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const calls = shortcutCalls.length;
    send('cq:set', { keybinds: replacement });
    assert.equal(get().keybinds.globalShortcut.pc.key, 'Z', 'conflict preserves applied configuration');
    assert.deepEqual([...active.keys()], [originalCombo], 'conflict preserves old physical registration');
    assert.equal(fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8'), originalDisk);
    assert.equal(shortcutCalls.length, calls + 1, 'same rejected payload retries');
    assert.ok(get().shortcutStatus.error);
    assert.ok(get().validationError);
  }
  // Mirror UI's one-shot rollback; old configuration must clear error without register churn.
  const beforeRollback = shortcutCalls.length;
  send('cq:set', { keybinds: originalBinding });
  assert.equal(get().shortcutStatus.error, null);
  assert.equal(get().validationError, null);
  assert.equal(shortcutCalls.length, beforeRollback);
  acceptShortcut = true;
  for (const method of ['writeFileSync', 'renameSync']) {
    const originalMethod = fs[method];
    const calls = shortcutCalls.length;
    try {
      fs[method] = () => { throw new Error(`shortcut ${method} unavailable`); };
      send('cq:set', { keybinds: replacement });
    } finally { fs[method] = originalMethod; }
    assert.equal(get().keybinds.globalShortcut.pc.key, 'Z', 'persistence failure preserves applied binding');
    assert.deepEqual([...active.keys()], [originalCombo], 'new physical binding rolled back, old never removed');
    assert.deepEqual(shortcutCalls.slice(calls), [['register', newCombo], ['unregister', newCombo]]);
    assert.equal(fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8'), originalDisk);
    assert.ok(get().validationError.includes(method));
  }
  send('cq:set', { keybinds: replacement });
  assert.deepEqual([...active.keys()], [newCombo]);
  assert.equal(get().keybinds.globalShortcut.pc.key, 'K');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ipcDir, 'settings.json'))).keybinds.globalShortcut.pc.key, 'K');
  const sameCalls = shortcutCalls.length;
  send('cq:set', { keybinds: replacement });
  assert.equal(shortcutCalls.length, sameCalls, 'accepted signature does not re-register');
  for (const method of ['writeFileSync', 'renameSync']) {
    const originalMethod = fs[method];
    const disk = fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8');
    const hidden = get().hidden, broadcasts = sends.length;
    try {
      fs[method] = () => { throw new Error(`toggle ${method} unavailable`); };
      assert.doesNotThrow(() => active.get(newCombo)(), 'native callback contains persistence error');
    } finally { fs[method] = originalMethod; }
    assert.equal(get().hidden, hidden);
    assert.equal(fs.readFileSync(path.join(ipcDir, 'settings.json'), 'utf8'), disk);
    assert.ok(get().validationError.includes(method));
    assert.ok(sends.length > broadcasts, 'native error broadcasts previous state');
    assert.equal(sends.at(-1).state.hidden, hidden);
  }
  const hidden = get().hidden;
  active.get(newCombo)();
  assert.equal(get().hidden, !hidden, 'physical toggle recovers');
  assert.equal(get().validationError, null);
  const disabled = structuredClone(replacement);
  disabled.globalShortcut.enabled = false;
  const disabledRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('disable unavailable'); };
    send('cq:set', { keybinds: disabled });
  } finally { fs.renameSync = disabledRename; }
  assert.deepEqual([...active.keys()], [newCombo], 'failed disable keeps physical binding');
  assert.equal(get().keybinds.globalShortcut.enabled, true);
  send('cq:set', { keybinds: disabled });
  assert.equal(active.size, 0);
  assert.equal(get().keybinds.globalShortcut.enabled, false);
  for (const disabledAtBoot of [false, true]) {
    const bootDir = fs.mkdtempSync(path.join(ipcDir, 'boot-'));
    const bootBinding = structuredClone(originalBinding);
    bootBinding.globalShortcut.enabled = !disabledAtBoot;
    fs.writeFileSync(path.join(bootDir, 'settings.json'), JSON.stringify({ keybinds: bootBinding }));
    let bootAttempts = 0;
    vm.runInNewContext(source, {
      require(name) {
        if (name === 'electron') return { ...electron, app: { ...app, getPath: () => bootDir }, globalShortcut: { register() { bootAttempts++; return false; }, unregister() { assert.fail('boot has no active binding'); } } };
        if (name === './foreground') return { createForegroundMonitor: monitor };
        if (name === './input') return { createInputMonitor: monitor };
        return localRequire(name);
      },
      __dirname: path.resolve('src/main'), console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get().shortcutStatus.registered, false);
    assert.equal(bootAttempts, disabledAtBoot ? 0 : 1);
    assert.equal(!!get().shortcutStatus.error, !disabledAtBoot);
    send('cq:set', { hidden: true });
    assert.equal(bootAttempts, disabledAtBoot ? 0 : 1, 'unrelated commit cannot cause retry loop');
    if (!disabledAtBoot) {
      send('cq:set', { keybinds: bootBinding });
      assert.equal(bootAttempts, 2, 'explicit retry after unavailable boot');
    }
  }
  const switchDir = fs.mkdtempSync(path.join(ipcDir, 'switch-'));
  const { DEFAULTS } = localRequire('./state');
  const { profiles: _registry, ...profileDefaults } = DEFAULTS;
  const targetBinding = structuredClone(originalBinding);
  targetBinding.globalShortcut.pc = { modifiers: ['Ctrl', 'Shift'], key: 'K' };
  for (const profile of [
    { id: 'default', process: null, settings: { ...profileDefaults, scale: 1 } },
    { id: 'target', process: { path: 'C:\\Game.exe' }, hideCrosshairWhenUnfocused: true, settings: { ...profileDefaults, keybinds: targetBinding, scale: 3, hidden: true } },
    { id: 'auto', process: { path: 'C:\\Other.exe' }, hideCrosshairWhenUnfocused: true, settings: { ...profileDefaults, scale: 4 } },
  ]) saveProfile(switchDir, profile);
  let foreground = { available: true, foreground: { executablePath: 'C:\\Other.exe' } };
  let pollForeground;
  active.clear(); acceptShortcut = true;
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return { ...electron, app: { ...app, getPath: () => switchDir } };
      if (name === './foreground') return { createForegroundMonitor(_native, callback) { pollForeground = callback; return { getStatus: () => foreground, start() {}, stop() {} }; } };
      if (name === './input') return { createInputMonitor: monitor };
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'), console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  send('cq:set', { scale: 2 });
  const selectedState = () => {
    const state = get();
    return [state.profiles.currentProfileId, state.scale, state.hidden, state.profileInFocus, state.keybinds.globalShortcut.pc.key];
  };
  const previousSelection = selectedState();
  assert.deepEqual(previousSelection, ['default', 2, false, true, 'Z']);
  acceptShortcut = false;
  const rejectedAt = sends.length;
  assert.doesNotThrow(() => send('cq:set-profile', { id: 'target' }), 'profile conflict contained in handler');
  assert.deepEqual(selectedState(), previousSelection, 'conflict preserves selected profile/config/focus');
  assert.deepEqual([...active.keys()], [originalCombo]);
  assert.ok(sends.length > rejectedAt);
  assert.ok(sends.at(-1).state.validationError);
  assert.ok(sends.at(-1).state.shortcutStatus.error);
  const persistedSelection = () => {
    const state = JSON.parse(fs.readFileSync(path.join(switchDir, 'settings.json')));
    return [state.profiles.currentProfileId, state.scale, state.hidden, state.keybinds.globalShortcut.pc.key];
  };
  assert.deepEqual(persistedSelection(), ['default', 2, false, 'Z']);
  acceptShortcut = true;
  for (const stage of ['profile', 'registry', 'candidate']) for (const method of ['writeFileSync', 'renameSync']) {
    send('cq:set', { offsetX: get().offsetX + 1 }); // Force previous profile's registry snapshot to need persistence.
    const originalMethod = fs[method];
    let injected = false;
    const offsetBefore = get().offsetX;
    const broadcastsBefore = sends.length;
    const calls = shortcutCalls.length;
    try {
      fs[method] = function (file, ...args) {
        const filename = String(file);
        const content = method === 'writeFileSync' ? args[0] : (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
        const settings = filename.includes('settings.json');
        const match = stage === 'profile' ? filename.includes('default.json')
          : settings && JSON.parse(content).profiles.currentProfileId === (stage === 'candidate' ? 'target' : 'default');
        if (match) { injected = true; throw new Error(`${stage} ${method} failed`); }
        return originalMethod.call(this, file, ...args);
      };
      assert.doesNotThrow(() => send('cq:set-profile', { id: 'target' }), 'profile persistence error contained');
    } finally { fs[method] = originalMethod; }
    assert.equal(injected, true, `${stage}/${method} fault reached`);
    assert.deepEqual(selectedState(), previousSelection);
    assert.equal(get().offsetX, offsetBefore);
    assert.ok(sends.length > broadcastsBefore, 'persistence rejection always published');
    assert.equal(sends.at(-1).state.profiles.currentProfileId, 'default');
    assert.equal(sends.at(-1).state.profileInFocus, true);
    assert.deepEqual(persistedSelection(), ['default', 2, false, 'Z']);
    assert.deepEqual([...active.keys()], [originalCombo]);
    assert.ok(sends.at(-1).state.validationError.includes(`${stage} ${method}`));
    if (stage === 'candidate') {
      assert.ok(sends.at(-1).state.shortcutStatus.error.includes(method));
      assert.deepEqual(shortcutCalls.slice(calls), [['register', newCombo], ['unregister', newCombo]]);
    }
  }
  const successAt = sends.length;
  assert.doesNotThrow(() => send('cq:set-profile', { id: 'target' }));
  assert.deepEqual(selectedState(), ['target', 3, true, false, 'K']);
  assert.equal(get().validationError, null);
  assert.equal(get().shortcutStatus.error, null);
  assert.deepEqual([...active.keys()], [newCombo]);
  for (const { state } of sends.slice(successAt)) if (state.profiles.currentProfileId === 'target') {
    assert.equal(state.profileInFocus, false, 'no committed candidate broadcast with stale focus');
    assert.equal(state.validationError, null, 'successful switch clears prior rejection before publication');
  }
  foreground = { available: true, foreground: { executablePath: 'C:\\Game.exe' } };
  pollForeground(foreground);
  assert.equal(get().profileInFocus, true);
  acceptShortcut = false;
  foreground = { available: true, foreground: { executablePath: 'C:\\Other.exe' } };
  assert.doesNotThrow(() => pollForeground(foreground), 'autoswitch conflict contained');
  assert.deepEqual(selectedState(), ['target', 3, true, false, 'K'], 'autoswitch failure evaluates focus for still-selected target');
  assert.ok(sends.at(-1).state.validationError);
  assert.ok(sends.at(-1).state.shortcutStatus.error);
  assert.deepEqual([...active.keys()], [newCombo]);
  acceptShortcut = true;
  const autoAt = sends.length;
  pollForeground(foreground);
  assert.deepEqual(selectedState(), ['auto', 4, false, true, 'Z']);
  assert.equal(get().validationError, null);
  assert.deepEqual([...active.keys()], [originalCombo]);
  for (const { state } of sends.slice(autoAt)) if (state.profiles.currentProfileId === 'auto') assert.equal(state.profileInFocus, true);
  console.log('PASS: main profile conflict/persistence containment + committed focus broadcasts + autoswitch recovery (no Electron)');
  console.log('PASS: main IPC + hidden profiles + shortcut conflict/retry/rollback/boot + native write failures (no Electron)');
} finally { fs.rmSync(ipcDir, { recursive: true, force: true }); }
