// Persisted boundary/zero/rollback regressions. No Electron or Windows effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const G = require('../src/shared/geometry.js');
const L = require('../src/shared/layers.js');
const { validatePatch, createStore } = require('../src/main/state.js');

for (const key of ['scale', 'crosshairSize']) for (const value of [NaN, Infinity, -Infinity, 0, -1, 100.01, '1', null]) {
  test(`${key} rejects ${String(value)} (${typeof value})`, () => assert.throws(() => validatePatch({ [key]: value }), TypeError));
}
for (const key of ['offsetX', 'offsetY']) for (const value of [NaN, Infinity, -Infinity, 100001, -100001, '0', null]) {
  test(`${key} rejects ${String(value)} (${typeof value})`, () => assert.throws(() => validatePatch({ [key]: value }), TypeError));
}
for (const [index, value] of [null, [], false, {}, { x: 0 }, { y: 0 }, { x: '0', y: 0 }, { x: 0, y: NaN }, { x: 100001, y: 0 }].entries()) {
  test(`crosshairOffset invalid boundary ${index}`, () => assert.throws(() => validatePatch({ crosshairOffset: value }), TypeError));
}
for (const [index, model] of [{ armLen: -1 }, { armThick: -1 }, { gap: -1 }, { dot: { size: -1 } }, { opacity: NaN }, { rotation: Infinity }].entries()) {
  test(`model invalid boundary ${index}`, () => assert.throws(() => L.validateModel(model), TypeError));
}
for (const key of ['armLen', 'armThick']) test(`${key}=0 suppresses arms, retains dot`, () => {
  const model = L.validateModel({ ...G.defaultModel(), [key]: 0 });
  assert.deepEqual(G.computeArms(model), []);
  assert.deepEqual(G.buildSpec(model, 1).arms, []);
  assert.equal(G.buildSpec(model, 1).dot.r, 1);
});
test('dot enabled=false survives validation', () => assert.equal(G.buildSpec(L.validateModel({ dot: { enabled: false } }), 1).dot, null));
test('dot size=0 stays absent', () => assert.equal(G.buildSpec(L.validateModel({ dot: { enabled: true, size: 0 } }), 1).dot, null));
test('draw size=0 renders no image', () => {
  const svg = L.renderLayers([{ ...L.newDrawLayer('data:image/png;base64,AAAA', 20, 20), size: 0 }]);
  assert.doesNotMatch(svg, /<image/);
});
test('model layer zero dimensions emit no arm shapes', () => {
  const layer = L.validateLayers([{ type: 'model', armLength: 0, armThickness: 0, dot: { enabled: true, size: 4 } }])[0];
  assert.doesNotMatch(L.layerRenderers.model(layer), /<use|<defs|<rect|<polygon/);
  assert.match(L.layerRenderers.model(layer), /<circle/);
});
test('geometry scale=2 applies once', () => assert.equal(G.buildSpec(G.defaultModel(), 2).arms[0].w, 16));
test('false and zero state values survive', () => assert.deepEqual(validatePatch({ visible: false, offsetX: 0, offsetY: 0, crosshairOffset: { x: 0, y: 0 } }), { visible: false, offsetX: 0, offsetY: 0, crosshairOffset: { x: 0, y: 0 } }));
test('unknown runtime keys stripped', () => assert.deepEqual(validatePatch({ profileInFocus: false, arbitrary: 1 }), {}));
test('empty layers compile empty drawing', () => assert.deepEqual(validatePatch({ layers: [], drawing: '<script/>' }), { layers: [], drawing: '' }));
test('negative CSS coordinate snaps to physical grid', () => assert.equal(G.snapToPhysical(-10.4, 1.25), -10.4));
test('point-only crosshair roundtrip keeps zero arms', () => {
  const first = L.validateCrosshair({ model: { armLen: 0, armThick: 0, dot: { enabled: true, size: 2 } } });
  assert.deepEqual(L.validateCrosshair(JSON.parse(JSON.stringify(first))), first);
  assert.deepEqual(G.computeArms(first.model), []);
});
test('empty text and opacity=0 survive', () => {
  const [layer] = L.validateLayers([{ type: 'text', text: '', opacity: 0 }]);
  assert.equal(layer.text, ''); assert.equal(layer.opacity, 0);
});
test('legacy arm aliases preserve zero', () => {
  const [layer] = L.validateLayers([{ type: 'model', armLen: 0, armThick: 0, gap: 0 }]);
  assert.equal(layer.armLength, 0); assert.equal(layer.armThickness, 0); assert.equal(layer.armSpacing, 0);
});
for (const method of ['writeFileSync', 'renameSync']) test(`${method} failure preserves memory, disk and notifications`, () => {
  assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA required');
  const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cq-geometry-negative-'));
  try {
    const store = createStore(dir, { profiles: { default: { id: 'default' } } });
    store.set({ offsetX: 3 });
    const before = store.get(), file = path.join(dir, 'settings.json'), disk = fs.readFileSync(file, 'utf8');
    let notifications = 0;
    store.onChange(() => notifications++);
    const original = fs[method], failure = Object.assign(new Error(`test-only ${method}`), { code: 'EACCES' });
    try {
      fs[method] = () => { throw failure; };
      assert.throws(() => store.set({ offsetX: 4 }), e => e === failure);
      assert.throws(() => store.flush(), e => e === failure);
    } finally { fs[method] = original; }
    assert.equal(store.get(), before); assert.equal(notifications, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), disk);
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
