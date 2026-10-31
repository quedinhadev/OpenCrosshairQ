import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');
const G = require('../src/shared/geometry.js');
const clone = value => JSON.parse(JSON.stringify(value));

const dot = { ...G.defaultModel(), gap: 0, armLen: 0, armThick: 0, opacity: 0,
  dot: { enabled: false, size: 0, shape: 'square' }, outline: { enabled: false, width: 0, color: '#000000', blur: 0 } };
const canonical = L.validateCrosshair({ model: dot });
assert.deepEqual(canonical.model, dot, 'model false and zero survive validation');
assert.deepEqual(L.validateCrosshair(clone(canonical)), canonical, 'model JSON roundtrip is idempotent');
assert.deepEqual(G.buildSpec(canonical.model, 1), { arms: [], dot: null });

for (const disabled of [{ armLength: 0, armLen: 8, armThickness: 2 }, { armLength: 8, armThickness: 0, armThick: 2 }]) {
  for (const armShape of ['rect', 'triangle', 'chevron']) {
    const layer = { ...L.newModelLayer(), ...disabled, armShape };
    const payload = L.validateCrosshair({ model: {}, layers: [layer], drawing: '<rect width="8" height="2"/>' });
    assert.ok(!/<rect|<polygon/.test(payload.drawing), 'disabled arms never resurrect through aliases, shapes, or stale drawing');
    assert.ok(payload.drawing.includes('<circle'), 'layer dot remains present');
    assert.deepEqual(L.validateCrosshair(clone(payload)), payload, 'layers + regenerated drawing survive JSON roundtrip');
  }
}

const off = { ...L.newModelLayer(), visible: false, opacity: 0, scale: 0, dot: { enabled: false, size: 0 }, outline: { enabled: false, width: 0 } };
const hidden = L.validateCrosshair({ layers: [off] });
assert.equal(hidden.drawing, '', 'hidden layers retain empty drawing, not model fallback');
assert.deepEqual(L.validateCrosshair(clone(hidden)), hidden);
assert.deepEqual(hidden.layers[0].dot, { enabled: false, size: 0, shape: 'circle', color: '#ffffff', blur: 0 });
assert.equal(hidden.layers[0].scale, 0);
assert.equal(hidden.layers[0].opacity, 0);
const empty = L.validateCrosshair({ layers: [], drawing: '' });
assert.equal(empty.drawing, '');
assert.deepEqual(L.validateCrosshair(clone(empty)), empty);

const raster = 'data:image/png;base64,AAAA';
const draw = L.validateCrosshair({ layers: [{ ...L.newDrawLayer(raster, 10, 10), size: 0 }] });
assert.ok(!draw.drawing.includes('<image'), 'draw size zero never defaults back to one');
assert.deepEqual(L.validateCrosshair(clone(draw)), draw);
assert.throws(() => L.validateCrosshair({ layers: [{ ...off, opacity: '0' }] }), /número/);
console.log('PASS: crosshair model/layers/drawing roundtrip');
