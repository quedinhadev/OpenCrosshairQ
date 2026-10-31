// QA ownership: ux-acceptance* only. Pure real validators; not UI/IPC/pixel approval.
// Run from app: node --test test/ux-acceptance-boundaries.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');
const limit = 8 * 1024 * 1024;
const prefix = 'data:image/png;base64,';
// Encoded-data boundary only. These large strings are deliberately not PNG files.
const raster = bytes => prefix + 'A'.repeat(bytes);
const maxData = Math.floor((limit - prefix.length) / 4) * 4;
const image = (id, src) => ({ id, type: 'image', src, w: 1, h: 1 });
const text = (id, value = '') => ({ id, type: 'text', text: value });

test('UX boundary: 128 distinct layers accepted; 129 rejected without truncation', () => {
  const layers = Array.from({ length: 128 }, (_, i) => text(`text-${i}`));
  assert.equal(L.validateCrosshair({ layers }).layers.length, 128);
  assert.throws(() => L.validateCrosshair({ layers: [...layers, text('extra')] }), /128/);
});

test('UX boundary: duplicate IDs rejected even when last layer is invisible', () => {
  assert.throws(() => L.validateCrosshair({ layers: [text('same'), { ...text('same'), visible: false }] }), /duplicado/);
});

test('UX boundary: text 4096 code units accepted; 4097 rejected', () => {
  assert.equal(L.validateLayers([text('max', 'x'.repeat(4096))])[0].text.length, 4096);
  assert.throws(() => L.validateLayers([text('over', 'x'.repeat(4097))]), /texto/);
});

test('UX boundary: Unicode, empty text and explicit false/zero survive JSON roundtrip', () => {
  const layers = [text('unicode', 'Mira 日本語 😀 e\u0301 <script>'), { ...text('empty'), visible: false, opacity: 0, fontSize: 0, bold: false }];
  const before = JSON.stringify(layers);
  const validated = L.validateCrosshair({ layers });
  assert.equal(JSON.stringify(layers), before, 'validator must not mutate source');
  assert.equal(validated.layers[0].text, layers[0].text);
  assert.equal(validated.layers[1].text, '');
  assert.equal(validated.layers[1].visible, false);
  assert.equal(validated.layers[1].fontSize, 0);
  assert.equal(validated.layers[1].opacity, 0);
  assert.deepEqual(L.validateCrosshair(JSON.parse(JSON.stringify(validated))), validated);
  assert.ok(!validated.drawing.includes('<script>'));
});

test('UX boundary: last aligned raster below 8 MiB accepted; next base64 quantum rejected', () => {
  assert.ok(raster(maxData).length <= limit);
  assert.ok(raster(maxData + 4).length > limit);
  assert.equal(L.validateLayers([image('max', raster(maxData))])[0].src.length, prefix.length + maxData);
  assert.throws(() => L.validateLayers([image('over', raster(maxData + 4))]), /8 MiB/);
});

test('UX boundary: aggregate raster 16 MiB budget enforced independently of per-image budget', () => {
  const first = raster(Math.floor(maxData / 2));
  const thirdData = Math.floor((limit * 2 - first.length * 2 - prefix.length) / 4) * 4;
  const layers = [image('a', first), image('b', first), image('c', raster(thirdData))];
  const size = layers.reduce((sum, layer) => sum + layer.src.length, 0);
  assert.ok(size <= limit * 2 && size + 4 > limit * 2);
  assert.equal(L.validateLayers(layers).length, 3);
  assert.throws(() => L.validateLayers([...layers.slice(0, 2), image('c', raster(thirdData + 4))]), /16 MiB/);
});

for (const src of [
  'https://example.invalid/mira.png', 'file:///C:/secret.png',
  'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,',
  'data:image/png;base64,AAA', 'data:image/png;base64,AA!A',
]) test(`UX boundary: reject raster source ${src}`, () => {
  assert.throws(() => L.validateCrosshair({ layers: [image('bad', src)] }));
});

test('UX boundary: valid layer document recompiles SVG and strips unknown/prototype keys', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"layers":[{"id":"safe","type":"text","text":"<img onerror=bad>","unknown":"not persisted"}],"drawing":"<script>bad()</script>"}');
  const validated = L.validateCrosshair(payload);
  assert.equal(Object.hasOwn(validated, '__proto__'), false);
  assert.equal(Object.hasOwn(validated.layers[0], 'unknown'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(validated.drawing, L.renderLayers(validated.layers));
  assert.ok(!validated.drawing.includes('<script>'));
  assert.ok(validated.drawing.includes('&lt;img'));
});

test('UX boundary: explicit empty layered document stays empty through repeated validation', () => {
  const payload = { model: { color: '#ff00ff' }, layers: [], drawing: '' };
  const once = L.validateCrosshair(payload);
  assert.equal(once.drawing, '');
  assert.deepEqual(once.layers, []);
  assert.deepEqual(L.validateCrosshair(once), once);
});

test('UX boundary: isolated caller SVG never becomes an import document', () => {
  assert.throws(() => L.validateCrosshair({ model: {}, drawing: '<svg/>' }), /camadas/);
  assert.throws(() => L.validateCrosshair({ drawing: '<svg/>' }));
});

test('UX boundary: numeric strings, NaN and Infinity rejected rather than silently coerced', () => {
  for (const opacity of ['0', NaN, Infinity, -Infinity, null]) {
    assert.throws(() => L.validateCrosshair({ layers: [{ ...text('invalid'), opacity }] }), /número/);
  }
});
