// Node-only independent numerical review, not physical/render acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const L = require('../src/shared/layers');
const sourceFiles = ['src/shared/layers.js', 'src/overlay/overlay.html', 'src/designer/designer.js', 'src/designer/designer.html', 'test/render-sharpness.test.mjs'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex')]));
const before = hashes(), results = [];
const outputRoot = path.resolve(__dirname, '../../analysis/refinement-20261027/qa-evidence');
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, 'node-bounds-review-'));
function near(a, b) { assert.ok(Number.isFinite(a) && Math.abs(a - b) <= 1e-6, `${a} != ${b}; tolerance 1e-6 CSS px`); }
function check(id, fn) {
  try { results.push({ id, verdict: 'PASS', observed: fn() }); }
  catch (e) { results.push({ id, verdict: 'FAIL', error: e.message }); }
}
const png = 'data:image/png;base64,AAAA'; // Validator-only placeholder, never decoded as PNG.
const types = [L.newModelLayer(), L.newShapeLayer(), L.newTextLayer(), L.newImageLayer(png, 8, 6), L.newDrawLayer(png, 8, 6)];
for (const raw of types) {
  check('scale-boundary-' + raw.type, () => {
    for (const scale of [0, .01, 1, 100]) assert.equal(L.validateLayers([{ ...raw, scale }])[0].scale, scale);
    assert.equal(L.validateLayers([raw])[0].scale, 1);
    for (const scale of [-.001, 100.001, NaN, Infinity, '2', null, false]) assert.throws(() => L.validateLayers([{ ...raw, scale }]), TypeError);
    return { accepted: [0, .01, 1, 100], rejected: ['negative', '>100', 'NaN', 'Infinity', 'string', 'null', 'false'] };
  });
  check('scale-bounds-linearity-' + raw.type, () => {
    const base = L.validateLayers([{ ...raw, x: 7, y: 9, rotation: 27 }])[0];
    const b = L.layerBounds(base), scaled = L.layerBounds({ ...base, scale: 2 });
    // Each exported bound rounds independently to 1e-6; compare the containing
    // rounding intervals, not two rounded numbers as if both were exact.
    for (const axis of ['w', 'h']) {
      const error = Math.abs(scaled[axis] - 2 * b[axis]);
      const roundingBudget = .5e-6 + 2 * .5e-6;
      assert.ok(error <= roundingBudget, `rounding intervals disjoint: ${error} > ${roundingBudget}`);
    }
    return { base: b, scaled, scope: raw.type === 'text' ? 'estimate linearity only; not glyph coverage' : 'numerical bounds, not pixels' };
  });
}
check('rect-independent-stroke-rotation', () => {
  const cases = [];
  for (const rotation of [0, 30, 90]) for (const scale of [.5, 2]) {
    const l = L.validateLayers([{ ...L.newShapeLayer(), w: 8, h: 4, rotation, scale, stroke: { enabled: true, width: 2, color: '#000000' } }])[0];
    const r = rotation * Math.PI / 180;
    const expected = { w: scale * (10 * Math.abs(Math.cos(r)) + 6 * Math.abs(Math.sin(r))), h: scale * (10 * Math.abs(Math.sin(r)) + 6 * Math.abs(Math.cos(r))) };
    const actual = L.layerBounds(l); near(actual.w, expected.w); near(actual.h, expected.h);
    cases.push({ rotation, scale, expected, actual });
  }
  return cases;
});
check('model-dot-ring-stroke-independent', () => {
  const observations = [];
  for (const shape of ['circle', 'square', 'diamond', 'ring']) {
    const l = L.validateLayers([{ ...L.newModelLayer(), scale: 2, dot: { enabled: true, size: 4, shape, color: '#ffffff' }, outline: { enabled: true, width: 3, color: '#000000' } }])[0];
    const expected = shape === 'ring' ? 10 : 20;
    const actual = L.layerBounds(l); near(actual.w, expected); near(actual.h, expected);
    observations.push({ shape, actual, expected });
  }
  return observations;
});
check('draw-size-rounding-then-uniform-scale', () => {
  const l = L.validateLayers([{ ...L.newDrawLayer(png, 7, 5), size: 1.5, scale: 2 }])[0];
  const b = L.layerBounds(l); near(b.w, 22); near(b.h, 16);
  return { actual: b, expected: { w: 22, h: 16 } };
});
check('text-fontsize-zero-has-no-paint-bounds', () => {
  const l = L.validateLayers([{ ...L.newTextLayer(), text: 'CQ', fontSize: 0, scale: 2 }])[0];
  const actual = L.layerBounds(l), rendered = L.renderLayers([l]);
  fs.writeFileSync(path.join(output, 'text-zero-repro.json'), JSON.stringify({ input: l, actual, rendered, expected: { w: 0, h: 0 }, scope: 'SVG font-size=0; no browser/pixel inspection' }, null, 2));
  assert.ok(rendered.includes('font-size:0px')); near(actual.w, 0); near(actual.h, 0);
});
const after = hashes();
check('reviewed-sources-stable', () => { assert.deepEqual(after, before); return { stable: true, scope: sourceFiles }; });
const report = { command: 'node test/refinement-acceptance-bounds-review.cjs', environment: { node: process.version, platform: process.platform, executable: process.execPath }, before, after, results,
  pass: results.filter(c => c.verdict === 'PASS').length, fail: results.filter(c => c.verdict === 'FAIL').length,
  notExecuted: ['Electron', 'physical pixels', 'Creator UI behavior', 'all polygon miter/ellipse/text glyph envelopes', 'full IPC', 'startup Windows', 'logo'], output };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.fail ? 1 : 0;
