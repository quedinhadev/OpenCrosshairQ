import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');

test('simple model converts losslessly to editable canonical layer', () => {
  const model = { gap: 0, armLen: 0, armThick: 0, rotation: 45, opacity: 0,
    color: '#2fc787', dot: { enabled: false, size: 0, shape: 'square' },
    outline: { enabled: false, width: 0, color: '#123456' } };
  const layer = L.modelToLayer(model, 'preset');
  assert.equal(layer.armLength, 0); assert.equal(layer.armThickness, 0);
  assert.equal(layer.armColor, model.color); assert.equal(layer.dot.color, model.color);
  assert.equal(layer.dot.enabled, false); assert.equal(layer.dot.size, 0);
  assert.equal(layer.outline.enabled, false); assert.equal(layer.outline.width, 0);
  assert.equal(layer.rotation, 45); assert.equal(layer.armRotation, 0);
  assert.equal(layer.opacity, 0);
  assert.deepEqual(L.validateLayers([structuredClone(layer)])[0], layer);
});

test('simple/library/designer/overlay share one compiler; stale drawing never wins', () => {
  const model = { color: '#67c1f5', armLen: 18, armThick: 2, gap: 4, rotation: 45,
    outline: { enabled: false }, dot: { enabled: false } };
  const layer = L.modelToLayer(model);
  const body = L.renderCrosshair({ model });
  assert.equal(body, L.renderLayers([layer]));
  assert.equal(body, L.renderCrosshair({ model, layers: [], drawing: null }));
  assert.equal(body, L.renderCrosshair({ model: {}, layers: [layer], drawing: '<script/>' }));
  assert.ok(body.includes('fill="#67c1f5"')); assert.ok(!body.includes('stroke='));
  assert.ok(!body.includes('filter='));
  assert.equal(L.renderCrosshair({ model, layers: [], drawing: '' }), '');
});

test('thumbnail shares body, fits measured vector bbox, never rewrites strokes or colors', () => {
  const payload = { layers: [{ type: 'model', id: 'dot', armLength: 0, armThickness: 0,
    dot: { enabled: true, size: 4, color: '#ff8000' }, outline: { enabled: true, width: 1 } }] };
  const body = L.renderCrosshair(payload);
  const svg = L.thumbnailSvg(payload, { x: -3, y: -3, width: 6, height: 6 });
  assert.ok(svg.includes(body));
  assert.match(svg, /viewBox="-4 -4 8 8"/);
  assert.ok(!svg.includes('256 256'));
  assert.equal(L.thumbnailSvg({ layers: [], drawing: '' }, { x: 0, y: 0, width: 0, height: 0 }), '');
  assert.throws(() => L.thumbnailSvg(payload, { x: NaN, y: 0, width: 1, height: 1 }), /limite/);
});

test('real overlay loads canonical compiler, ignores stale SVG, keeps one target scale', () => {
  const html = readFileSync(new URL('../src/overlay/overlay.html', import.meta.url), 'utf8');
  assert.ok(html.includes('../shared/layers.js'));
  const node = () => ({ style: {}, innerHTML: '', firstElementChild: { innerHTML: '' } });
  const nodes = { primary: node(), secondary: node() };
  const frames = new Map();
  let next = 0, onState;
  const window = { CQLayers: L, CQGeometry: {}, CQGameState: { isCrosshairVisible: () => true },
    performance: { now: () => 0 }, addEventListener() {},
    cq: { onState(fn) { onState = fn; }, onInput() {} } };
  const document = { getElementById: id => nodes[id], documentElement: { getBoundingClientRect: () => ({ width: 961, height: 541 }) } };
  const source = readFileSync(new URL('../src/overlay/overlay.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window, document,
    requestAnimationFrame: fn => { frames.set(++next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id) });
  const model = { color: '#67c1f5', outline: { enabled: false } };
  const payload = { model, layers: [{ type: 'model', id: 'zero', armLength: 0, armThickness: 0,
    dot: { enabled: true, size: 4, color: '#ff8000' }, outline: { enabled: false } }], drawing: '<rect fill="red"/>' };
  onState({ ...payload, model2: model, scale: 2, crosshairSize: 1.5, offsetX: 0, offsetY: 0 });
  for (const fn of frames.values()) fn();
  assert.equal(nodes.primary.firstElementChild.innerHTML, L.renderCrosshair(payload));
  assert.ok(!nodes.primary.firstElementChild.innerHTML.includes('red'));
  assert.equal(nodes.secondary.firstElementChild.innerHTML, L.renderCrosshair({ model }));
  assert.equal(nodes.primary.style.transform, 'translate(352.5px, 142.5px) scale(3)');
  onState({ model, model2: model, layers: [], drawing: '', scale: 1, offsetX: 0, offsetY: 0 });
  assert.equal(nodes.primary.firstElementChild.innerHTML, '');
});
