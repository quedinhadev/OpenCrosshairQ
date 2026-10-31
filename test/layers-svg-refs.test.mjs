// Regression: multiple inline crosshair SVGs share one HTML document (catalog
// cards via innerHTML), so id references (href="#x", url(#x)) resolve
// document-globally. Rendering two simple models side by side must not leak
// geometry/filters across cards.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');

const modelA = { gap: 2, armLen: 10, armThick: 2, color: '#ffffff', dot: { enabled: true, size: 4 }, outline: { enabled: true, width: 1 } };
const modelB = { gap: 6, armLen: 20, armThick: 4, color: '#ff0000', dot: { enabled: true, size: 2, blur: 1 }, outline: { enabled: true, width: 2, blur: 2.5 } };

// All ids referenced via href="#x" or url(#x).
const refs = (svg) => [...svg.matchAll(/(?:xlink:)?href="#([^"]+)"|url\(#([^)]+)\)/g)].map((m) => m[1] || m[2]);
// Full definition text per id: whole <filter> element when present, else the
// opening tag (enough to prove defs are not cross-card ambiguous).
const allDefs = (svg) => {
  const map = {};
  for (const m of svg.matchAll(/<filter id="([^"]+)">.*?<\/filter>/g)) map[m[1]] = m[0];
  for (const m of svg.matchAll(/<(?!filter)[\w-]+ id="([^"]+)"/g)) if (!(m[1] in map)) map[m[1]] = m[0];
  return map;
};

test('two simple models side by side: referenced ids resolve identically in both fragments', () => {
  const a = L.renderCrosshair({ model: modelA });
  const b = L.renderCrosshair({ model: modelB });
  assert.ok(a.includes('id="layer-model"') && b.includes('id="layer-model"'), 'audit premise: both simple presets reuse id=model');
  const defA = allDefs(a), defB = allDefs(b);
  for (const id of refs(a)) {
    assert.ok(defA[id], `fragment A references #${id} without local def`);
    if (id in defB) assert.equal(defB[id], defA[id], `#${id} defined differently in fragment B`);
  }
  for (const id of refs(b)) {
    assert.ok(defB[id], `fragment B references #${id} without local def`);
    if (id in defA) assert.equal(defB[id], defA[id], `#${id} defined differently in fragment A`);
  }
});

test('geometry carries no id references: no <use>, no arms def id', () => {
  const fragments = [
    L.renderCrosshair({ model: modelA }),
    L.renderCrosshair({ model: modelB }),
    L.renderLayers([L.newModelLayer(), L.newShapeLayer()]),
  ];
  for (const svg of fragments) {
    assert.doesNotMatch(svg, /<use/, 'arms geometry must be inlined, not id-referenced');
    assert.doesNotMatch(svg, /id="arms-/, 'arms def id removed');
  }
});

test('simultaneous previews with reused layer ids never reference another SVG, including blur', () => {
  const payloads = [
    { model: modelA }, { model: modelB },
    ...[1.5, 3, 1.5].map(blur => ({ layers: [{ ...L.newModelLayer(), id: 'model',
      armLength: 20, armThickness: 4, armSpacing: 6, armBlur: blur,
      dot: { enabled: true, size: 4, blur },
      outline: { enabled: true, width: 2, blur: 2.5 } }] })),
  ];
  const bodies = payloads.map(payload => L.renderCrosshair(payload));
  const previews = payloads.map(payload => L.thumbnailSvg(payload, { x: -30, y: -30, width: 60, height: 60 }));
  for (const [index, preview] of previews.entries()) {
    assert.deepEqual(refs(preview), [], `preview ${index}: no document-global fragment references`);
    assert.doesNotMatch(preview, /<use\b|<defs\b/, 'geometry and blur stay inline');
    assert.ok(preview.includes(bodies[index]), 'preview uses the canonical body');
    assert.equal(bodies[index], L.renderLayers(L.crosshairLayers(payloads[index])), 'designer/overlay body is identical');
    assert.equal(bodies[index], L.renderCrosshair(payloads[index]), 'rendering stays deterministic');
    assert.ok(preview.includes('id="layer-model"'), 'overlay animation target remains stable');
  }
  assert.notEqual(bodies[0], bodies[1], 'distinct models keep distinct geometry');
  assert.doesNotMatch(bodies[2], /filter:blur/);
  assert.doesNotMatch(bodies[3], /filter:blur/);
  assert.equal(bodies[2], bodies[4], 'identical simultaneous previews need no generated namespace');
});

test('two model layers with distinct ids each render their own arms', () => {
  const svg = L.renderCrosshair({ layers: [
    { ...L.newModelLayer(), id: 'm1', armLength: 10, armThickness: 2, armSpacing: 2 },
    { ...L.newModelLayer(), id: 'm2', armLength: 6, armThickness: 2, armSpacing: 1 },
  ] });
  assert.equal((svg.match(/<rect x="-5" y="-1" width="10" height="2"\/>/g) || []).length, 4, 'm1 arms (4 rotations) rendered locally');
  assert.equal((svg.match(/<rect x="-3" y="-1" width="6" height="2"\/>/g) || []).length, 4, 'm2 arms (4 rotations) rendered locally');
});

test('blurred/outline model: thumbnail body equals renderCrosshair', () => {
  const body = L.renderCrosshair({ model: modelB });
  assert.ok(L.thumbnailSvg({ model: modelB }, { x: -20, y: -20, width: 40, height: 40 }).includes(body));
});
