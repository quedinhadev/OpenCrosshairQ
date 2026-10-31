// Assert-based self-check for layers + undoredo (no frameworks).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');
const U = require('../src/shared/undoredo.js');
import assert from 'node:assert/strict';

// --- layers ---

// Creator default is dot-only. Zero-length arms never emit degenerate shapes.
const m = L.newModelLayer();
const svg = L.renderLayers([m]);
assert.ok(svg.includes('opacity="1"'));
assert.equal((svg.match(/<rect /g) || []).length, 0, 'default model has no arm rects');
assert.ok(svg.includes('<circle'), 'default dot remains visible');
const armed = L.renderLayers([{ ...m, armLength: 8, armThickness: 2 }]);
assert.equal((armed.match(/<rect /g) || []).length, 4, 'positive arm dimensions render four rects');
assert.ok(armed.includes('-18) rotate(-90)'), '90° arm points up; local +X follows negative SVG y');

// Triangle arm shape uses the registered renderer.
const t = { ...m, armShape: 'triangle', armLength: 8, armThickness: 2 };
assert.ok(L.renderLayers([t]).includes('<polygon'), 'triangle arm renders polygon');

// Dot shapes: ring uses fill=none.
const ring = { ...m, dot: { enabled: true, shape: 'ring', size: 4, color: '#fff' } };
const ringSvg = L.renderLayers([ring]);
assert.ok(ringSvg.includes('fill="none"') && ringSvg.includes('stroke="#fff"'), 'ring dot outlined');

// Dot outline: filled shape behind the dot, size = dot radius + outline width
// (probed live in the original: dot r=2, dotOutline r=3 fill #000000).
const dotOutlineSvg = L.renderLayers([{ ...m, dot: { enabled: true, shape: 'circle', size: 4, color: '#ffffff' }, outline: { enabled: true, width: 1, color: '#000000' } }]);
assert.ok(dotOutlineSvg.includes('r="2"'), 'dot keeps its own radius');
const outlineCircle = dotOutlineSvg.match(/<circle cx="0" cy="0" r="3"\/>/);
assert.ok(outlineCircle, 'dot outline drawn as filled circle r=dot+outlineWidth');
assert.ok(dotOutlineSvg.indexOf('r="3"') < dotOutlineSvg.indexOf('r="2"'), 'dot outline painted behind the dot');

// Invisible layer skipped; paint order = array order.
const s = L.newShapeLayer();
const hidden = { ...s, visible: false };
assert.equal(L.renderLayers([hidden]).trim(), '', 'hidden layer not rendered');

// Shape layer: rect centered at (x, -y).
const sh = { ...s, x: 10, y: 20, w: 8, h: 6 };
assert.ok(L.renderLayers([sh]).includes('x="6" y="-23"'), 'shape rect centered, +Y up');

// Text escaping.
const tx = { ...L.newTextLayer(), text: '<b>&\'"' };
const txSvg = L.renderLayers([tx]);
assert.ok(!txSvg.includes('<b>'), 'text escaped');

// escapeXml produces entities.
assert.equal(L.escapeXml('<'), '&' + 'lt;');
assert.equal(L.escapeXml('"'), '&' + 'quot;');

// IDs are unique even when an omitted id collides with an explicit fallback.
assert.throws(() => L.validateLayers([m, { ...m }]), /duplicado/);
assert.throws(() => L.validateLayers([{ ...m, id: 'layer_1' }, { type: 'model' }]), /duplicado/);
assert.throws(() => L.renderLayers([m, { ...m }]), /duplicado/);
assert.throws(() => L.validateLayers(Array.from({ length: 129 }, (_, i) => ({ ...m, id: 'unique_' + i }))), /máximo 128/);
for (const invalid of [null, undefined, {}, [null]]) {
  assert.throws(() => L.validateLayers(invalid), TypeError);
}
assert.deepEqual(L.validateLayers([]), []);
assert.equal(L.validateLayers([m, s]).length, 2, 'distinct layer ids preserved');

// --- undo/redo: exact original semantics ---

// Recursive partial inverse.
const inv = U.extractInversePartial({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } });
assert.deepEqual(inv, { b: { c: 2 } }, 'inverse only over patched paths');

// add inverse → delete with indices; delete inverse → add.
const layer = { id: 'x', type: 'model' };
const addInv = U.computeInverse({ type: 'add', items: [layer], indices: [0] }, []);
assert.equal(addInv.type, 'delete');
const delInv = U.computeInverse({ type: 'delete', items: [layer], indices: [0] }, [layer]);
assert.equal(delInv.type, 'add');

// reorder inverse swaps from/to.
assert.deepEqual(U.computeInverse({ type: 'reorder', from: 1, to: 2 }, []),
  { type: 'reorder', from: 2, to: 1 });

// Update coalescing within the window: only the first push lands.
U.clearStacks();
U.pushUndo({ type: 'update', patches: new Map() });
U.pushUndo({ type: 'update', patches: new Map() });
U.pushUndo({ type: 'update', patches: new Map() });
assert.equal(U.undoSize(), 1, 'consecutive updates coalesce');
// A non-update action ends the window and pushes.
U.pushUndo({ type: 'add', items: [layer], indices: [0] });
assert.equal(U.undoSize(), 2, 'non-update ends coalescing and pushes');

// Cap at 100: oldest dropped.
U.clearStacks();
for (let i = 0; i < 105; i++) U.pushUndoFromRedo({ type: 'update', patches: new Map() });
assert.equal(U.undoSize(), 100, 'stack capped at MAX_STACK_SIZE');

console.log('PASS: layers + undoredo self-check');
