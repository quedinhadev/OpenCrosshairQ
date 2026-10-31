// Run: node test/import-shortcut-security.test.mjs (no Electron process).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers');
const S = require('../src/main/state');
const G = require('../src/shared/geometry');
const model = G.defaultModel();
const raster = 'data:image/png;base64,iVBORw0KGgo=';
const drawing = '<svg onload="alert(1)"><script>bad()</script></svg>';
for (const value of [null, [], 5, {}, { model: [] }, { layers: 'bad' }]) assert.throws(() => L.validateCrosshair(value));
assert.throws(() => L.validateCrosshair({ model, drawing }));
const layers = [L.newModelLayer(), L.newShapeLayer(), { ...L.newTextLayer(), text: '<script>bad()</script>', fontFamily: '"Arial", sans-serif' }, L.newImageLayer(raster, 20, 20), L.newDrawLayer(raster, 30, 30)];
const imported = L.validateCrosshair({ model, layers, drawing });
assert.equal(imported.drawing, L.renderLayers(layers));
const animated = { ...layers[0], firingOptions: { trigger: 'left', pressType: 'hold', releaseBehavior: 'reverse', direction: 'reverse', easing: 'ease-in', loop: true, startDelay: 20, duration: 300, stages: [{ delay: 10, duration: 150, easing: 'linear', effects: [] }] } };
assert.deepEqual(L.validateLayers([animated])[0].firingOptions, animated.firingOptions, 'designer animation settings preserved');
assert.throws(() => L.validateLayers([{ ...animated, firingOptions: { stages: 'bad' } }]));
assert.ok(!imported.drawing.includes('<script>'));
assert.match(imported.drawing, /&lt;script&gt;/);
assert.match(imported.drawing, /&quot;Arial&quot;/);
assert.match(imported.drawing, /data:image\/png;base64/);
assert.equal(L.validateCrosshair({ v: 1, layers }).drawing, imported.drawing, 'designer share without model');
assert.deepEqual(S.validatePatch({ model: {}, layers, drawing }).model, L.validateModel({}), 'designer favorite empty model remains valid');
for (const color of ['red" onload="bad()', 'url(https://external.test/x)', 'url(#other)', 'var(--unsafe)', '<script>']) {
  assert.throws(() => L.validateCrosshair({ model: { ...model, color } }));
  assert.throws(() => L.renderLayers([{ ...L.newShapeLayer(), fill: color }]));
  assert.throws(() => L.renderLayers([{ ...L.newModelLayer(), outline: { color, enabled: true } }]));
}
for (const src of ['https://external.test/a.png', 'file:///secret', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,', 'data:image/png;base64,bad!', 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024)]) {
  assert.throws(() => L.renderLayers([L.newImageLayer(src, 20, 20)]));
  assert.throws(() => L.renderLayers([L.newDrawLayer(src, 20, 20)]));
}
assert.throws(() => L.renderLayers([{ ...L.newDrawLayer(raster, 20, 20), paths: [{ d: 'M0 0" onload="bad()' }] }]), 'unsupported paths cannot enter renderer');
assert.throws(() => L.renderLayers([{ ...L.newModelLayer(), id: 'x" onload="bad()' }]));
assert.throws(() => L.renderLayers([{ ...L.newModelLayer(), armCount: 1e9 }]));
assert.throws(() => L.renderLayers([{ ...L.newTextLayer(), fontFamily: 'x;background:url(https://x)' }]));
assert.throws(() => S.validatePatch({ drawing }));
assert.equal(S.validatePatch({ layers, drawing }).drawing, imported.drawing);
assert.equal(S.validatePatch({ layers: [], drawing }).drawing, '', 'raw drawing never survives even with empty layers');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-import-'));
try {
  const store = S.createStore(dir, { profiles: {} });
  const before = JSON.stringify(store.get());
  assert.throws(() => store.set({ model, layers: [L.newImageLayer('https://x', 1, 1)], drawing }));
  assert.equal(JSON.stringify(store.get()), before, 'rejected update atomic');
  store.set({ layers, drawing });
  assert.equal(store.get().drawing, imported.drawing);
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
  saved.drawing = drawing;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(saved));
  const restored = S.createStore(dir, { profiles: {} });
  assert.equal(restored.get().drawing, imported.drawing, 'disk drawing recompiled too');
  restored.flush();
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

let accepted = true, callback, toggles = 0;
const calls = [];
const registration = S.createToggleShortcut({
  register(combo, fn) { calls.push(['register', combo]); callback = fn; return accepted; },
  unregister(combo) { calls.push(['unregister', combo]); },
}, () => toggles++);
const kb = structuredClone(S.DEFAULTS.keybinds);
assert.equal(S.accelerator(kb.globalShortcut), 'Alt+Shift+Z');
assert.equal(registration.update(kb).registered, true);
callback(); assert.equal(toggles, 1);
registration.update(kb); assert.equal(calls.length, 1, 'unrelated state changes do not re-register');
kb.globalShortcut.pc = { modifiers: ['Ctrl', 'Shift'], key: 'K' };
assert.equal(registration.update(kb).accelerator, 'Control+Shift+K');
assert.deepEqual(calls.slice(1), [['register', 'Control+Shift+K'], ['unregister', 'Alt+Shift+Z']]);
kb.globalShortcut.enabled = false;
assert.equal(registration.update(kb).registered, false);
assert.deepEqual(calls.at(-1), ['unregister', 'Control+Shift+K']);
accepted = false; kb.globalShortcut.enabled = true;
assert.match(registration.update(kb).error, /indisponível/);
assert.equal(registration.getStatus().registered, false, 'conflict not false success');
const failedCalls = calls.length;
assert.match(registration.update(kb).error, /indisponível/);
assert.equal(calls.length, failedCalls + 1, 'unavailable binding retries');
accepted = true;
assert.equal(registration.update(kb).registered, true, 'unavailable binding can recover');
let bootAccept = false, bootCalls = 0;
const bootShortcut = S.createToggleShortcut({ register() { bootCalls++; return bootAccept; }, unregister() { assert.fail('no registration to remove'); } }, () => {});
assert.equal(bootShortcut.update(kb).registered, false, 'boot unavailable reports error');
assert.ok(bootShortcut.getStatus().error);
bootAccept = true;
assert.equal(bootShortcut.update(kb).registered, true);
assert.equal(bootCalls, 2, 'boot signature not cached on rejection');
const disabledBoot = structuredClone(kb);
disabledBoot.globalShortcut.enabled = false;
assert.equal(S.createToggleShortcut({ register() { assert.fail('disabled boot cannot register'); } }, () => {}).update(disabledBoot).error, null);
assert.throws(() => S.validatePatch({ keybinds: { globalShortcut: { ...kb.globalShortcut, pc: { modifiers: [], key: 'LeftClick' } } } }));
assert.equal(S.accelerator({ ...kb.globalShortcut, pc: { modifiers: ['Meta'], key: 'ArrowUp' } }), 'Super+Up');

// Overlay subscriptions clean up only their own listener, once, without Electron.
const { EventEmitter } = require('node:events');
const ipc = new EventEmitter();
let overlayApi;
let removals = 0;
const removeListener = ipc.removeListener;
ipc.removeListener = function (...args) { removals++; return removeListener.apply(this, args); };
vm.runInNewContext(fs.readFileSync(new URL('../src/overlay/preload.js', import.meta.url), 'utf8'), {
  require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'cq'); overlayApi = api; } }, ipcRenderer: ipc }; },
});
for (const [method, channel] of [['onState', 'cq:state'], ['onInput', 'cq:input']]) {
  let first = 0, second = 0;
  const payload = { hidden: false };
  const offFirst = overlayApi[method](value => { assert.equal(value, payload); first++; });
  const offSecond = overlayApi[method](() => second++);
  assert.equal(ipc.listenerCount(channel), 2);
  ipc.emit(channel, {}, payload);
  assert.equal(first, 1); assert.equal(second, 1);
  const before = removals;
  offFirst(); offFirst();
  assert.equal(removals, before + 1, 'unsubscribe idempotent');
  assert.equal(ipc.listenerCount(channel), 1, 'other subscriber preserved');
  ipc.emit(channel, {}, payload);
  assert.equal(first, 1); assert.equal(second, 2);
  offSecond(); offSecond();
  assert.equal(ipc.listenerCount(channel), 0);
}

// Execute preview builder itself: imported/local-storage model colors cannot create attributes.
const uiSource = fs.readFileSync(new URL('../src/ui/ui.js', import.meta.url), 'utf8');
const helpers = uiSource.slice(uiSource.indexOf('  function escapeHtml'), uiSource.indexOf('  function toast'));
const preview = uiSource.slice(uiSource.indexOf('  function previewColor'), uiSource.indexOf('  function paint'));
const previewSvg = vm.runInNewContext(`${helpers}\n${preview}\nmodelSvg(model, 7)`, { model: { ...model, color: 'x" onload="bad()', outline: { enabled: true, color: 'url(https://external.test)' } }, CQGeometry: G });
assert.ok(!previewSvg.includes('onload') && !previewSvg.includes('https://'));
assert.match(uiSource, /pcBtn.disabled = action !== 'globalShortcut'/);
assert.match(uiSource, /btnNewKeybind'\)\.disabled = true/);
assert.match(uiSource, /sem executor/);
console.log('PASS: import schema, SVG recompilation, raster limits, preview colors, atomic store, shortcut lifecycle/conflict and unsupported UI controls');
