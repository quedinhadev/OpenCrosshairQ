import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const L = createRequire(import.meta.url)('../src/shared/layers.js');
test('legacy blur survives JSON roundtrip, never changes paint or outline strategy', () => {
  const base = { ...L.newModelLayer(), id: 'sharp', armLength: 8, armThickness: 2 };
  for (const blur of [0, 2, 20, 100]) {
    const raw = { ...base, armBlur: blur, dot: { ...base.dot, blur }, outline: { ...base.outline, blur } };
    const saved = L.validateLayers(JSON.parse(JSON.stringify([raw])));
    assert.equal(saved[0].armBlur, blur); assert.equal(saved[0].dot.blur, blur); assert.equal(saved[0].outline.blur, blur);
    assert.equal(L.renderLayers(saved), L.renderLayers([base]));
    assert.doesNotMatch(L.renderLayers(saved), /filter|blur/);
  }
});
test('every layer supports validated uniform scale, legacy defaults to one', () => {
  const src = 'data:image/png;base64,AAAA';
  for (const raw of [L.newModelLayer(), L.newShapeLayer(), L.newTextLayer(), L.newImageLayer(src, 8, 6), L.newDrawLayer(src, 8, 6)]) {
    const base = { ...raw, id: raw.type };
    assert.equal(L.validateLayers([base])[0].scale, 1);
    const scaled = L.validateLayers([{ ...base, x: 7, y: 9, scale: 2 }])[0];
    assert.equal(scaled.scale, 2);
    assert.notEqual(L.renderLayers([scaled]), L.renderLayers([{ ...scaled, scale: 1 }]));
    assert.throws(() => L.validateLayers([{ ...base, scale: NaN }]), TypeError);
    assert.throws(() => L.validateLayers([{ ...base, scale: -1 }]), TypeError);
    if (base.type !== 'model') assert.match(L.renderLayers([scaled]), /translate\(7 -9\) scale\(2\) translate\(-7 9\)/);
  }
  const draw = { ...L.newDrawLayer(src, 8, 6), size: 1.5, scale: 2 };
  assert.match(L.renderLayers([draw]), /width="12" height="9"/); // size once; scale remains outer transform
});
test('model selection envelope includes gap, stroke, dot and scale; box types keep intrinsic resize bounds', () => {
  const model = { ...L.newModelLayer(), armLength: 8, armThickness: 2 };
  assert.equal(L.layerBounds(model).w, 45);
  assert.equal(L.layerBounds({ ...model, scale: 2 }).w, 90);
  assert.equal(L.layerBounds(L.newModelLayer()).w, 6);
  assert.equal(L.layerBounds({ ...L.newShapeLayer(), w: 8, h: 4, rotation: 90, scale: 2, stroke: { enabled: false } }).w, 8);
});
test('rotated shape retains intrinsic dimensions; asymmetric model envelope stays centered', () => {
  const shape = { ...L.newShapeLayer(), w: 8, h: 4, rotation: 90, scale: 2 };
  assert.deepEqual(L.layerBounds(shape), { w: 8, h: 4 });
  const model = { ...L.newModelLayer(), armCount: 1, armSpacing: 0, armLength: 8, armThickness: 2,
    dot: { enabled: false }, outline: { enabled: false } };
  assert.deepEqual(L.layerBounds(model), { w: 16, h: 2 });
  for (const count of [1, 3, 5]) {
    const b = L.layerBounds({ ...model, armCount: count });
    assert.ok(b.w >= 16 - 1e-6, 'origin-centered envelope includes rightmost arm');
  }
});
test('text bounds preserve fontSize zero; false and empty stay distinct document data', () => {
  const text = L.validateLayers([{ type: 'text', id: 'zero', text: 'CQ', fontSize: 0, scale: 2, opacity: 0, visible: false }])[0];
  assert.equal(text.fontSize, 0); assert.equal(text.opacity, 0); assert.equal(text.visible, false);
  // Existing selection estimate has an 8x4 floor; it is not measured glyph paint.
  assert.deepEqual(L.layerBounds(text), { w: 8, h: 4 });
  assert.equal(L.renderLayers([text]), '');
  assert.match(L.renderLayers([{ ...text, visible: true }]), /font-size:0px/);
  const empty = L.validateLayers([{ ...text, text: '' }])[0];
  assert.equal(empty.text, ''); assert.deepEqual(L.layerBounds(empty), { w: 8, h: 4 });
  assert.deepEqual(L.validateLayers(JSON.parse(JSON.stringify([empty])))[0], empty);
  const absent = L.validateLayers([{ type: 'text', id: 'absent' }])[0];
  assert.equal(absent.fontSize, 16); assert.equal(absent.visible, true); assert.equal(absent.opacity, 1);
  assert.notDeepEqual(L.layerBounds(absent), L.layerBounds(text));
});
test('real Designer zero-delta resize at scale2 preserves intrinsic boxes, save and undo', () => {
  const source = readFileSync(new URL('../src/designer/designer.js', import.meta.url), 'utf8');
  const start = source.indexOf('      const dx = (e.clientX - drag.cx)');
  const end = source.indexOf('      renderPreview(); positionSel(); persist();', start);
  assert.ok(start > 0 && end > start);
  const U = createRequire(import.meta.url)('../src/shared/undoredo.js');
  const src = 'data:image/png;base64,AAAA';
  for (const raw of [L.newShapeLayer(), L.newImageLayer(src, 8, 4), L.newDrawLayer(src, 8, 4), L.newTextLayer()]) {
    const l = L.validateLayers([{ ...raw, scale: 2, rotation: 90 }])[0];
    const before = structuredClone(l), b = L.layerBounds(l);
    vm.runInNewContext(source.slice(start, end), { l, e: { clientX: 0, clientY: 0 }, zoom: 1, PXU: 50,
      drag: { cx: 0, cy: 0, dir: 'se', base: { w: b.w, h: b.h, layerW: l.w, layerH: l.h, fontSize: l.fontSize, scale: l.scale } } });
    assert.deepEqual(l, before, `${l.type}: zero delta must not bake scale/rotation/stroke into dimensions`);
    const saved = L.validateLayers(JSON.parse(JSON.stringify([l])))[0];
    assert.deepEqual(saved, before);
    const patch = l.type === 'text' ? { fontSize: l.fontSize + 2 } : { w: l.w + 2, h: l.h + 2 };
    const inverse = U.extractInversePartial(l, patch);
    Object.assign(l, patch); Object.assign(l, inverse);
    assert.deepEqual(l, before, 'undo restores intrinsic values without touching scale');
  }
});
test('Creator removes blur controls, offers reversible real size; overlay allows internal overflow', () => {
  const js = readFileSync(new URL('../src/designer/designer.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/designer/designer.html', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../src/overlay/overlay.html', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /numField\('Desfoque'/);
  assert.match(html, /id="realSize"/); assert.match(js, /realSize/);
  assert.match(overlay, /overflow: visible/);
});
