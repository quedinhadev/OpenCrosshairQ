// Run from app: node test/ui.test.mjs
// Checks renderer logic without a browser dependency.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync('src/ui/ui.js', 'utf8');
const html = fs.readFileSync('src/ui/index.html', 'utf8');
for (const file of ['src/ui/index.html', 'src/designer/designer.html']) {
  const source = fs.readFileSync(file, 'utf8');
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `${file}: duplicate IDs`);
  for (const [, id] of source.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids.includes(id), `${file}: broken label ${id}`);
}
assert.match(html, /id="streamerStatus" role="status"/);
assert.ok(!html.includes('(detecta OBS/XSplit)'));
assert.match(html, /id="nativeStatus" role="status"/);
assert.match(html, /id="profileStatus" role="status"/);
assert.match(html, /id="keybindStatus" role="status" aria-live="polite"><\/p>/);
assert.doesNotMatch(html, /<\/\w+[ \t]*\r?\n/, 'closing tags must include >');
for (const id of ['scale', 'scaleRange']) assert.match(html, new RegExp(`id="${id}"[^>]*min="0.01" max="10" step="0.01"`));
for (const id of ['offsetX', 'offsetXRange', 'offsetY', 'offsetYRange']) assert.match(html, new RegExp(`id="${id}"[^>]*min="-2000" max="2000" step="1"`));
for (const id of ['optionStartWithWindows', 'optionStartMinimized', 'optionDiscord', 'optionCommunity']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"[^>]*disabled`));
}
assert.match(html, /id="optionLanguage"[^>]*aria-label="[^"]+"/);
assert.match(html, /id="optionSounds"[^>]*aria-label="[^"]+"/);
function element() {
  const classes = new Set();
  return {
    textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: { setProperty(k, v) { this[k] = v; } }, listeners: {}, children: [], attributes: {},
    classList: {
      add(...cs) { cs.forEach(c => classes.add(c)); },
      remove(...cs) { cs.forEach(c => classes.delete(c)); },
      contains(c) { return classes.has(c); },
    },
    set innerHTML(value) { this.markup = value; this.children = []; },
    get innerHTML() { return this.markup || ''; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    get lastChild() { return this.children.at(-1); },
    querySelector() { return null; },
  };
}
const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, element()]));
let response = false, failRead = false, failAction = false, starts = 0, stops = 0;
let release;
const deferred = () => new Promise(resolve => { release = resolve; });
let profiles = [
  { id: 'default', name: 'default', process: null },
  { id: 'game', name: '<Jogo>', process: null, hideCrosshairWhenUnfocused: false },
];
let nativeReads = 0, saves = 0, failSave = false, failProfiles = false, failNative = false;
let nativeResponse = { available: true, error: null, foreground: {
  pid: 42, errorCode: 0, executablePath: 'C:\\Jogos\\jogo.exe', executableName: 'jogo.exe',
} };
let releaseSave, lastOptions, stateListener, lastPatch, profileReads = 0;
const cq = {
  getState: () => new Promise(() => {}), onState(fn) { stateListener = fn; },
  set(patch) { lastPatch = patch; },
  async getProfiles() { profileReads++; if (failProfiles) throw new Error('profiles failed'); return profiles.slice(); },
  async getNativeStatus() { nativeReads++; if (failNative) throw new Error('native failed'); return nativeResponse; },
  async configureProfile(options) {
    saves++; lastOptions = options;
    await new Promise(resolve => { releaseSave = resolve; });
    if (failSave) throw new Error('save failed');
  const tabSalvos = element();
  tabSalvos.dataset = { xtab: 'salvos' };
    const profile = profiles.find(p => p.id === options.id);
    profile.process = options.processPath ? { path: options.processPath, name: 'jogo.exe' } : null;
    profile.hideCrosshairWhenUnfocused = options.hideCrosshairWhenUnfocused;
    return profile;
  },
  async getStreaming() { if (failRead) throw new Error('read failed'); return { running: response }; },
  async startStreamer() { starts++; await deferred(); if (failAction) throw new Error('start failed'); response = true; },
  async stopStreamer() { stops++; await deferred(); if (failAction) throw new Error('stop failed'); response = false; },
};
vm.runInNewContext(ui, { window: { cq }, document: { getElementById: id => {
  assert.ok(elements[id], `Missing element: ${id}`); return elements[id];
}, querySelectorAll: () => [], createElement: element } });
const button = elements.btnStreamer;
const status = elements.streamerStatus;
const tick = () => new Promise(resolve => setImmediate(resolve));
const click = () => button.listeners.click();
(async () => {
  assert.equal(button.disabled, true, 'initial query must lock button');
  await tick();
  assert.equal(button.textContent, 'Iniciar');
  assert.equal(button.disabled, false);
  failAction = true;
  let pending = click();
  assert.equal(button.disabled, true);
  assert.notEqual(button.textContent, 'Parar', 'no optimistic running state');
  await click();
  assert.equal(starts, 1, 'duplicate click must not start twice');
  release(); await pending;
  assert.equal(button.textContent, 'Consultar');
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /start failed/);
  failAction = false;
  await click(); // Reconcile state after failed action.
  pending = click(); release(); await pending;
  assert.equal(button.textContent, 'Parar');
  failAction = true;
  pending = click();
  assert.equal(button.disabled, true);
  release(); await pending;
  assert.equal(stops, 1);
  assert.equal(button.textContent, 'Consultar');
  assert.match(status.textContent, /stop failed/);
  failAction = false;
  await click();
  pending = click(); release(); await pending;
  assert.equal(button.textContent, 'Iniciar');
  failRead = true;
  pending = click(); release(); await pending;
  assert.equal(button.textContent, 'Consultar', 'read failure must not claim running');
  assert.match(status.textContent, /read failed/);
  // Fresh renderer boot: rejected initial getStreaming must be handled.
  vm.runInNewContext(ui, { window: { cq }, document: {
    getElementById: id => elements[id], querySelectorAll: () => [], createElement: element,
  } });
  await tick();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Consultar');
  assert.match(status.textContent, /read failed/);
  assert.equal(nativeReads, 0, 'boot must not capture foreground');
  assert.equal(profileReads, 0, 'boot must not query profiles when modal is closed');
  const event = (id, type = 'click', target = elements[id]) => elements[id].listeners[type]({ target });
  const configureButton = id => {
    const row = elements.profileList.children.find(row => row.innerHTML.includes(`>${id} ·`));
    assert.ok(row, `Missing profile row: ${id}`);
    return row.children[0].children[3];
  };
  elements.profileModal.classList.add('on');
  await event('tabPerfis'); await tick();
  assert.equal(nativeReads, 1, 'opening profiles only reads status');
  assert.equal(elements.profileProcessPath.value, '');
  assert.match(elements.nativeStatus.textContent, /PID 42/);
  assert.equal(configureButton('default').disabled, true);
  configureButton('default').listeners.click();
  assert.equal(elements.btnSaveProfile.disabled, true, 'default cannot be configured');
  configureButton('game').listeners.click();
  assert.match(elements.profileAssociationTitle.textContent, /<Jogo>/);
  assert.ok(elements.profileList.children.some(row => row.innerHTML.includes('&lt;Jogo&gt;')), 'profile names are escaped');
  const save = () => event('btnSaveProfile');
  for (const path of ['jogo.exe', 'C:jogo.exe', 'C:\\Jogos\\jogo.txt', 'C:\\Jogos\\jogo?.exe', 'C:\\Jogos\\jogo.exe:extra', 'C:\\Jo\ngos\\jogo.exe']) {
    elements.profileProcessPath.value = path;
    await save();
    assert.equal(saves, 0, `must reject ${path}`);
  }
  elements.profileProcessPath.value = 'C:\\Jogos\\Jogo.EXE';
  elements.profileHideCrosshairWhenUnfocused.checked = true;
  pending = save();
  assert.equal(elements.btnSaveProfile.disabled, true);
  await save();
  assert.equal(saves, 1, 'pending save cannot duplicate');
  assert.equal(lastOptions.id, 'game');
  assert.equal(lastOptions.processPath, 'C:\\Jogos\\Jogo.EXE');
  assert.equal(lastOptions.hideCrosshairWhenUnfocused, true);
  const readsBeforeSave = profileReads;
  releaseSave(); await pending;
  assert.ok(profileReads > readsBeforeSave, 'save refreshes profiles');
  assert.match(elements.profileStatus.textContent, /salva/);
  assert.equal(elements.btnSaveProfile.disabled, false);
  assert.match(elements.profileList.children.find(row => row.innerHTML.includes('>game ·')).innerHTML, /Ocultar sem foco/);
  elements.profileProcessPath.value = '\\\\server\\share\\jogo.exe';
  pending = save(); releaseSave(); await pending;
  assert.equal(lastOptions.processPath, '\\\\server\\share\\jogo.exe', 'UNC is absolute');
  elements.profileProcessPath.value = '';
  pending = save(); releaseSave(); await pending;
  assert.equal(lastOptions.processPath, null);
  assert.equal(lastOptions.hideCrosshairWhenUnfocused, false, 'unlink clears focus hiding');
  elements.profileProcessPath.value = 'C:\\Jogos\\jogo.exe';
  failSave = true;
  pending = save(); releaseSave(); await pending;
  assert.match(elements.profileStatus.textContent, /save failed/);
  assert.equal(elements.btnSaveProfile.disabled, false);
  failSave = false;
  const savesBeforeCapture = saves;
  await event('btnCaptureForeground');
  assert.equal(elements.profileProcessPath.value, 'C:\\Jogos\\jogo.exe');
  assert.equal(saves, savesBeforeCapture, 'capture cannot persist automatically');
  assert.match(elements.profileStatus.textContent, /Confira/);
  nativeResponse = { available: false, foreground: null, error: 'addon missing' };
  await event('btnCaptureForeground');
  assert.match(elements.nativeStatus.textContent, /addon missing/);
  assert.equal(elements.profileProcessPath.value, 'C:\\Jogos\\jogo.exe', 'failed capture preserves draft');
  nativeResponse = { available: true, foreground: { errorCode: 5, executablePath: null }, error: null };
  await event('btnNativeStatus');
  assert.match(elements.nativeStatus.textContent, /código 5/);
  failNative = true;
  await event('btnNativeStatus');
  assert.match(elements.nativeStatus.textContent, /native failed/);
  assert.equal(elements.btnNativeStatus.disabled, false);
  failProfiles = true;
  await event('tabPerfis'); await tick();
  assert.match(elements.profileStatus.textContent, /profiles failed/);
  failProfiles = false;
  elements.profileModal.classList.remove('on');
  elements.panelPerfis.style.display = 'none';
  const readsClosed = profileReads;
  const model = { color: '#ffffff', armLen: 10, armThick: 2, gap: 2, rotation: 0, dot: { enabled: false, size: 2 } };
  stateListener({ model, scale: 1, profiles: { currentProfileId: 'game' } });
  await tick();
  assert.equal(profileReads, readsClosed, 'state update while profile panel is closed must not invoke getProfiles');
  elements.profileModal.classList.add('on');
  elements.panelPerfis.style.display = '';
  await event('tabPerfis'); await tick();
  assert.ok(profileReads > readsClosed, 'opening profile panel refreshes profiles');
  assert.equal(elements.profileDetectionEnabled.checked, true, 'missing config defaults to enabled');
  elements.profileDetectionEnabled.checked = false;
  event('profileDetectionEnabled', 'change');
  assert.equal(lastPatch.profileDetectionEnabled, false);
  stateListener({ model, scale: 1, keybinds: { globalShortcut: { enabled: true, pc: { modifiers: ['Alt', 'Shift'], key: 'Z' } } } });
  assert.equal(elements.keybindList.children.length, 4, 'all keybind rows render without errors');
  assert.equal(elements.keybindList.children[0].children[0].children[0].children[1].disabled, false);
  assert.equal(elements.keybindList.children[1].children[0].children[0].children[1].disabled, true);
  assert.match(elements.keybindStatus.textContent, /sem executor/);
  for (const [id, type, input, key, expected] of [
    ['scale', 'change', '0.05', 'scale', 0.05], ['scaleRange', 'input', '1.236', 'scale', 1.24],
    ['scale', 'change', '0', 'scale', 0.01], ['scale', 'change', '11', 'scale', 10],
    ['offsetX', 'change', '1500', 'offsetX', 1500], ['offsetYRange', 'input', '-2001', 'offsetY', -2000],
    ['offsetXRange', 'input', '2001', 'offsetX', 2000], ['offsetY', 'change', '12.6', 'offsetY', 13],
  ]) {
    elements[id].value = input; event(id, type);
    assert.equal(lastPatch[key], expected, `${id}: ${input}`);
  }
  for (const id of ['scale', 'offsetX', 'offsetY']) for (const value of ['', 'invalid', 'Infinity']) {
    const before = lastPatch;
    elements[id].value = value; event(id, 'change');
    assert.equal(lastPatch, before, `${id}: invalid input cannot reach IPC`);
  }
  await tick();
  // Browser-like renderer, still VM-only: capture feedback and local library actions.
  const localElements = Object.fromEntries(Object.keys(elements).map(id => [id, element()]));
  const tabSalvos = element();
  tabSalvos.dataset = { xtab: 'salvos' };
  const localData = new Map();
  const listeners = {};
  const patches = [];
  let emit;
  let quota = false;
  const LayersShared = require('../src/shared/layers.js');
  const GeometryShared = require('../src/shared/geometry.js');
  vm.runInNewContext(ui, {
    window: { cq: { ...cq, onState(fn) { emit = fn; }, set(patch) { patches.push(patch); } },
      CQLayers: LayersShared, CQGeometry: GeometryShared,
      addEventListener(type, fn) { listeners[type] = fn; }, location: { hash: '#crosshairs' } },
    document: { getElementById: id => localElements[id], querySelectorAll: sel => sel === '[data-xtab]' ? [tabSalvos] : [], createElement: element },
    localStorage: { getItem: key => localData.get(key), setItem(key, value) { if (quota) throw new Error('quota'); localData.set(key, value); } },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  const originalBinding = { enabled: true, pc: { modifiers: ['Alt', 'Shift'], key: 'Z' } };
  const initial = { model, scale: 1, keybinds: { globalShortcut: originalBinding } };
  emit(initial);
  const capture = () => localElements.keybindList.children[0].children[0].children[0].children[1].listeners.click();
  capture();
  listeners.keydown({ key: 'Escape' });
  assert.equal(patches.length, 0, 'Escape cancels capture without IPC');
  capture();
  listeners.keydown({ key: 'LeftClick' });
  assert.equal(patches.length, 0, 'unsupported global input cannot reach IPC');
  capture();
  listeners.keydown({ key: 'K', ctrlKey: true, preventDefault() {} });
  assert.equal(patches.at(-1).keybinds.globalShortcut.pc.key, 'K');
  emit({ ...initial, keybinds: patches.at(-1).keybinds, shortcutStatus: { accelerator: 'Control+K', error: 'occupied' } });
  assert.equal(JSON.stringify(patches.at(-1).keybinds.globalShortcut), JSON.stringify(originalBinding), 'registration conflict restores prior binding');
  emit(initial);
  localElements.contSave.listeners.click();
  const stored = () => JSON.parse(localData.get('cq.savedCustomCrosshairs'));
  assert.equal(stored().length, 1);
  const duplicate = () => localElements.savedGrid.children[0].children[0].children.find(child => child.title === 'Duplicar mira salva');
  duplicate().listeners.click({ stopPropagation() {} });
  assert.equal(stored().length, 2);
  assert.notEqual(stored()[0].id, stored()[1].id);
  assert.deepEqual(stored()[1].model, stored()[0].model);
  quota = true;
  duplicate().listeners.click({ stopPropagation() {} });
  assert.equal(stored().length, 2, 'quota failure preserves saved library');
  assert.match(localElements.toast.textContent, /Não foi possível duplicar/);
  // Preview regression checks: dot-only layers, empty layers, arbitrary drawing rejection, shell previews
  quota = false;
  const dotLayer = {
    id: 'dot-only-layer', type: 'model', name: 'Ponto Rosa', visible: true,
    armCount: 4, armLength: 0, armThickness: 0, armSpacing: 0,
    dot: { enabled: true, size: 6, shape: 'circle', color: '#ff00ff' },
    outline: { enabled: false }
  };
  const dotCustom = {
    id: 'custom-dot', name: 'Mira Ponto', creator: 'Local',
    model: {}, layers: [dotLayer], drawing: '<g id="injected-evil"><circle cx="0" cy="0" r="99"/></g>',
    savedAt: Date.now()
  };
  localData.set('cq.savedCustomCrosshairs', JSON.stringify([dotCustom]));
  // Re-render saved grid
  tabSalvos.listeners.click();
  assert.ok(localElements.savedGrid.children.length > 0, 'Saved grid should have items');
  const cardMedia = localElements.savedGrid.children[0].children[0];
  assert.ok(cardMedia && cardMedia.className === 'mod-card-media', 'Card media must exist');
  assert.doesNotMatch(cardMedia.innerHTML, /injected-evil/, 'received drawing string must never be injected');
  assert.doesNotMatch(cardMedia.innerHTML, /rect.*transform="rotate/, 'dot-only layers with model:{} must not resurrect 4-arm crosshair');
  assert.match(cardMedia.innerHTML, /#ff00ff/, 'dot-only layers must compile dot color');

  // Shell state preview test
  emit({ model: {}, layers: [dotLayer], drawing: '<g id="state-evil"></g>' });
  assert.doesNotMatch(localElements.modelPreview.innerHTML, /state-evil/, 'state preview never injects drawing string directly');
  assert.doesNotMatch(localElements.modelPreview.innerHTML, /rect.*transform="rotate/, 'state preview with model:{} does not resurrect cross');
  assert.match(localElements.modelPreview.innerHTML, /#ff00ff/, 'state preview renders dot layer');

  // Empty layers crosshair
  emit({ model: {}, layers: [], drawing: '' });
  assert.equal(localElements.modelPreview.innerHTML, '', 'empty layers crosshair renders empty preview, not default cross');

  // Legacy model crosshair
  const legacyModel = { gap: 6, armLen: 12, armThick: 2, rotation: 0, color: '#00ff88', dot: { enabled: true, size: 3 } };
  emit({ model: legacyModel, layers: [], drawing: null });
  assert.match(localElements.modelPreview.innerHTML, /#00ff88/, 'legacy model crosshair renders arms/color');

  // Fixed overlay-contract viewBox (-128..128): ad-hoc autofit removed.
  // Geometria fora do teto é recortada; fit de documento arbitrário não é prometido.
  const fixedBox = /viewBox="-128 -128 256 256"/;
  const bigDot = { id: 'bigdot', type: 'model', visible: true, x: 0, y: 0, scale: 8, armCount: 4, armLength: 0, armThickness: 0, armSpacing: 0, armShape: 'rect', armColor: '#ffffff', dot: { enabled: true, size: 20, shape: 'circle', color: '#ff0000' }, outline: { enabled: false } };
  emit({ model: {}, layers: [bigDot], drawing: null });
  assert.match(localElements.modelPreview.innerHTML, fixedBox, 'dot 20/scale 8 keeps contract viewBox (old extent math gave 28 and clipped)');
  assert.match(localElements.modelPreview.innerHTML, /<g fill="#ff0000"><circle cx="0" cy="0" r="10"/, 'dot radius compiled at full size; scale stays in the layer transform');
  const bigShape = { id: 'bigshape', type: 'shape', visible: true, x: 0, y: 0, w: 300, h: 300, rotation: 45, fill: '#00ff00', stroke: { enabled: true, color: '#000000', width: 1 } };
  emit({ model: {}, layers: [bigShape], drawing: null });
  assert.match(localElements.modelPreview.innerHTML, fixedBox, '300-unit rotated shape keeps contract viewBox (old extent math gave 158 and clipped)');
  const bigDraw = { id: 'bigdraw', type: 'draw', visible: true, x: 0, y: 0, w: 20, h: 20, size: 10, src: 'data:image/png;base64,AAAA' };
  emit({ model: {}, layers: [bigDraw], drawing: null });
  assert.match(localElements.modelPreview.innerHTML, fixedBox, 'draw layer keeps contract viewBox (old extent math gave 24 and clipped)');

  // Range --fill update check
  elements.armLen.min = '0'; elements.armLen.max = '40'; elements.armLen.value = '20';
  elements.armLen.listeners.input({ target: elements.armLen });
  assert.equal(elements.armLen.style['--fill'], '50.0%', 'slider input updates --fill css variable');

  // UI-2 fallback modelSvg rotation test (without CQGeometry)
  const startModelSvg = ui.indexOf('  function modelSvg(');
  const endModelSvg = ui.indexOf('  function crosshairSvg(', startModelSvg);
  assert.ok(startModelSvg >= 0 && endModelSvg > startModelSvg);
  const fallbackSandbox = { previewColor: (v, fallback) => v || fallback };
  vm.runInNewContext(ui.slice(startModelSvg, endModelSvg), fallbackSandbox);
  const fallbackSvg = fallbackSandbox.modelSvg({ rotation: 45 }, 7);
  assert.ok(fallbackSvg.includes('transform="rotate(45)"'), 'fallback modelSvg must include valid rotation transform');
  assert.ok(!fallbackSvg.includes('"="rotate('), 'fallback modelSvg must not produce malformed rotation attribute');

  // UI-3 onState catches with diagnostics
  assert.doesNotMatch(ui, /catch\s*\{\s*\/\*\s*\*\/\s*\}/, 'empty catch blocks in onState must be replaced with diagnostics');
  assert.match(ui, /catch\s*\(err\)\s*\{\s*console\.error\('\[ui:applyToDom\]',\s*err\);?\s*\}/, 'applyToDom catch must log [ui:applyToDom]');
  assert.match(ui, /catch\s*\(err\)\s*\{\s*console\.error\('\[ui:renderProfiles\]',\s*err\);?\s*\}/, 'renderProfiles catch must log [ui:renderProfiles]');
  assert.match(ui, /catch\s*\(err\)\s*\{\s*console\.error\('\[ui:forwardDesignerState\]',\s*err\);?\s*\}/, 'forwardDesignerState catch must log [ui:forwardDesignerState]');
  const loggedErrors = [];
  let onStateCb = null;
  let triggerError = false;
  vm.runInNewContext(ui, {
    window: { cq: { ...cq, onState(cb) { onStateCb = cb; } } },
    document: {
      getElementById(id) {
        if (triggerError && id === 'visible') throw new Error('simulated applyToDom failure');
        return elements[id] || element();
      },
      querySelectorAll: () => [],
      createElement: element,
    },
    console: { error(...args) { loggedErrors.push(args); }, log() {} },
  });
  assert.ok(onStateCb, 'onState callback must be registered');
  triggerError = true;
  onStateCb({ visible: true });
  assert.ok(loggedErrors.some(([tag]) => tag === '[ui:applyToDom]'), 'onState must catch and log [ui:applyToDom]');

  // UI-7 cleanups
  assert.doesNotMatch(ui, /if\s*\(action\s*!==\s*'captured-only'\)\s*\{\}/, 'dead empty block in renderKeybinds must be removed');
  assert.doesNotMatch(ui, /renderLibraryCall\(\);/, 'duplicate renderLibraryCall must be removed');

  const preload = fs.readFileSync('src/ui/preload.js', 'utf8');
  let exposed;
  const invocations = [];
  vm.runInNewContext(preload, { require(name) {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'cq'); exposed = api; } },
      ipcRenderer: { invoke(...args) { invocations.push(args); } },
    };
  } });
  exposed.getNativeStatus();
  exposed.configureProfile({ id: 'game', processPath: null, hideCrosshairWhenUnfocused: false });
  exposed.getStartupStatus();
  exposed.setStartup(true);
  assert.equal(invocations[0][0], 'cq:get-native-status');
  assert.equal(invocations[1][0], 'cq:configure-profile');
  assert.equal(invocations[1][1].id, 'game');
  assert.equal(invocations[2][0], 'cq:get-startup-status');
  assert.equal(invocations[3][0], 'cq:set-startup');
  assert.equal(invocations[3][1], true);
  console.log('PASS: HTML labels/IDs/status/disabled settings; position precision/bounds/invalid input; keybind rows/cancel/validation/conflict rollback; favorite duplication/quota; streamer/profile regressions; preload contracts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
