// Dedicated stdlib unit & integration test suite for undo/redo audit (EDIT-1 and EDIT-2).
// Run with: node --test test/undoredo-audit.test.mjs (from app/ directory)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../src/shared/undoredo.js');

// Helper to simulate action cycle matching designer.js
function createDesignerSim(initialLayers) {
  let layers = structuredClone(initialLayers);

  function deepMerge(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = (v && typeof v === 'object' && v !== null) ? structuredClone(v) : v;
      }
    }
  }

  function applyAction(action) {
    switch (action.type) {
      case 'update':
        for (const [id, patch] of action.patches) {
          const l = layers.find((x) => x.id === id);
          if (l) deepMerge(l, patch);
        }
        break;
      case 'add':
        for (let i = action.items.length - 1; i >= 0; i--) {
          layers.splice(Math.max(0, action.indices[i]), 0, structuredClone(action.items[i]));
        }
        break;
      case 'delete':
        for (const item of action.items) {
          const i = layers.findIndex((l) => l.id === item.id);
          if (i !== -1) layers.splice(i, 1);
        }
        break;
      case 'reorder': {
        const [moved] = layers.splice(action.from, 1);
        layers.splice(action.to, 0, moved);
        break;
      }
    }
  }

  function doAction(action) {
    U.pushUndo(U.computeInverse(action, layers));
    applyAction(action);
  }

  function update(id, patch) {
    doAction({ type: 'update', patches: new Map([[id, patch]]) });
  }

  function undo() {
    if (!U.canUndo()) return;
    const inverse = U.popUndo();
    const redoAction = U.computeInverse(inverse, layers);
    applyAction(inverse);
    U.pushRedo(redoAction);
  }

  function redo() {
    if (!U.canRedo()) return;
    const action = U.popRedo();
    const undoInverse = U.computeInverse(action, layers);
    applyAction(action);
    U.pushUndoFromRedo(undoInverse);
  }

  return {
    getLayers: () => structuredClone(layers),
    update,
    doAction,
    undo,
    redo,
    endDebounce: () => U.endDebounce(),
    clearStacks: () => U.clearStacks(),
  };
}

test('EDIT-1A: same path 10 -> 20 -> 35 coalesces to initial 10 on undo, 35 on redo', () => {
  U.clearStacks();
  const sim = createDesignerSim([
    { id: 'L0', armLength: 10, armThickness: 2 },
  ]);

  // Update 1: 10 -> 20
  sim.update('L0', { armLength: 20 });
  assert.equal(sim.getLayers()[0].armLength, 20);

  // Update 2 (<300ms, same path): 20 -> 35
  sim.update('L0', { armLength: 35 });
  assert.equal(sim.getLayers()[0].armLength, 35);
  assert.equal(U.undoSize(), 1, 'Coalesced into 1 stack entry');

  // Undo: reverts to original 10
  sim.undo();
  assert.equal(sim.getLayers()[0].armLength, 10, 'Undo restores initial 10');

  // Redo: restores final 35
  sim.redo();
  assert.equal(sim.getLayers()[0].armLength, 35, 'Redo restores final 35');

  // Subsequent undo restores 10 again
  sim.undo();
  assert.equal(sim.getLayers()[0].armLength, 10, 'Second undo restores initial 10');
});

test('EDIT-1B: two nested paths on the SAME object (dot.size and dot.color) merge and both revert', () => {
  U.clearStacks();
  const sim = createDesignerSim([
    { id: 'L0', dot: { size: 4, color: '#FFFFFF', blur: 0, enabled: true } },
  ]);

  // Update 1: dot.size 4 -> 10
  sim.update('L0', { dot: { size: 10 } });
  assert.equal(sim.getLayers()[0].dot.size, 10);
  assert.equal(sim.getLayers()[0].dot.color, '#FFFFFF');

  // Update 2 (<300ms, nested property in SAME object): dot.color '#FFFFFF' -> '#FF0000'
  sim.update('L0', { dot: { color: '#FF0000' } });
  assert.equal(sim.getLayers()[0].dot.size, 10);
  assert.equal(sim.getLayers()[0].dot.color, '#FF0000');
  assert.equal(U.undoSize(), 1, 'Both edits coalesced into single undo entry');

  // Undo: restores BOTH nested fields to pre-edit values
  sim.undo();
  const layerAfterUndo = sim.getLayers()[0];
  assert.equal(layerAfterUndo.dot.size, 4, 'Undo restores dot.size = 4');
  assert.equal(layerAfterUndo.dot.color, '#FFFFFF', 'Undo restores dot.color = #FFFFFF');

  // Redo: reapplies BOTH edits
  sim.redo();
  const layerAfterRedo = sim.getLayers()[0];
  assert.equal(layerAfterRedo.dot.size, 10, 'Redo restores dot.size = 10');
  assert.equal(layerAfterRedo.dot.color, '#FF0000', 'Redo restores dot.color = #FF0000');
});

test('EDIT-1C: two nested paths on SAME object with third intermediate edit preserves first pre-edit value', () => {
  U.clearStacks();
  const sim = createDesignerSim([
    { id: 'L0', dot: { size: 4, color: '#FFFFFF', blur: 0 } },
  ]);

  // Update 1: dot.size -> 10
  sim.update('L0', { dot: { size: 10 } });
  // Update 2: dot.color -> '#FF0000'
  sim.update('L0', { dot: { color: '#FF0000' } });
  // Update 3 (<300ms): dot.size -> 25 (repeated nested key in same window)
  sim.update('L0', { dot: { size: 25 } });

  assert.equal(sim.getLayers()[0].dot.size, 25);
  assert.equal(sim.getLayers()[0].dot.color, '#FF0000');
  assert.equal(U.undoSize(), 1);

  // Undo: must restore initial dot.size = 4 (NOT 10) and dot.color = '#FFFFFF'
  sim.undo();
  assert.equal(sim.getLayers()[0].dot.size, 4, 'Undo restores original dot.size = 4 past intermediate 10');
  assert.equal(sim.getLayers()[0].dot.color, '#FFFFFF', 'Undo restores initial dot.color = #FFFFFF');

  // Redo: must restore final dot.size = 25 and dot.color = '#FF0000'
  sim.redo();
  assert.equal(sim.getLayers()[0].dot.size, 25, 'Redo restores final dot.size = 25');
  assert.equal(sim.getLayers()[0].dot.color, '#FF0000', 'Redo restores final dot.color = #FF0000');
});

test('EDIT-1D: distinct fields on same layer and distinct layer IDs merge in open window', () => {
  U.clearStacks();
  const sim = createDesignerSim([
    { id: 'L0', armLength: 10, armThickness: 2 },
    { id: 'L1', armLength: 15, armThickness: 4 },
  ]);

  // Update distinct fields on L0
  sim.update('L0', { armLength: 24 });
  sim.update('L0', { armThickness: 8 });

  // Update distinct layer ID L1 in same debounce window
  sim.update('L1', { armLength: 50 });

  assert.equal(U.undoSize(), 1, 'All updates coalesce into single window entry');
  assert.equal(sim.getLayers()[0].armLength, 24);
  assert.equal(sim.getLayers()[0].armThickness, 8);
  assert.equal(sim.getLayers()[1].armLength, 50);

  // Undo reverts both fields on L0 and L1
  sim.undo();
  assert.equal(sim.getLayers()[0].armLength, 10, 'L0 armLength restored');
  assert.equal(sim.getLayers()[0].armThickness, 2, 'L0 armThickness restored');
  assert.equal(sim.getLayers()[1].armLength, 15, 'L1 armLength restored');

  // Redo reapplies all updates
  sim.redo();
  assert.equal(sim.getLayers()[0].armLength, 24);
  assert.equal(sim.getLayers()[0].armThickness, 8);
  assert.equal(sim.getLayers()[1].armLength, 50);
});

test('EDIT-1E: delimited gestures (calling endDebounce) produce discrete undo steps', () => {
  U.clearStacks();
  const sim = createDesignerSim([
    { id: 'L0', x: 0, scale: 1 },
  ]);

  // Gesture 1: move x 0 -> 10, then gesture ends
  sim.update('L0', { x: 10 });
  sim.endDebounce();

  // Gesture 2: resize scale 1 -> 2.5, then gesture ends
  sim.update('L0', { scale: 2.5 });
  sim.endDebounce();

  assert.equal(U.undoSize(), 2, 'Two discrete entries on undo stack');

  // Undo 1: reverts scale back to 1, x remains 10
  sim.undo();
  assert.equal(sim.getLayers()[0].scale, 1, 'First undo reverts scale');
  assert.equal(sim.getLayers()[0].x, 10, 'First undo preserves x');

  // Undo 2: reverts x back to 0
  sim.undo();
  assert.equal(sim.getLayers()[0].x, 0, 'Second undo reverts x');
  assert.equal(sim.getLayers()[0].scale, 1, 'Scale remains 1');

  // Redo 1: reapplies x = 10
  sim.redo();
  assert.equal(sim.getLayers()[0].x, 10);
  assert.equal(sim.getLayers()[0].scale, 1);

  // Redo 2: reapplies scale = 2.5
  sim.redo();
  assert.equal(sim.getLayers()[0].x, 10);
  assert.equal(sim.getLayers()[0].scale, 2.5);
});

test('EDIT-2A: duplicate layer in list >= 3 preserves insertion index (z-order) across undo and redo', () => {
  U.clearStacks();
  const l0 = { id: 'L0', name: 'Zero' };
  const l1 = { id: 'L1', name: 'One' };
  const l2 = { id: 'L2', name: 'Two' };
  const sim = createDesignerSim([l0, l1, l2]);

  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  // Duplicate L1 (index 1): copy goes to index 2
  const copy = { id: 'L1_copy', name: 'One copy' };
  sim.doAction({ type: 'add', items: [copy], indices: [2] });

  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L1_copy', 'L2']);

  // Undo removes copy
  sim.undo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  // Redo reinserts copy at index 2 (NOT at index 0!)
  sim.redo();
  assert.deepEqual(
    sim.getLayers().map(l => l.id),
    ['L0', 'L1', 'L1_copy', 'L2'],
    'Redo must reinsert copy at original index 2, not corrupting z-order to index 0'
  );
});

test('EDIT-2B: append layer in list >= 3 preserves order across undo and redo', () => {
  U.clearStacks();
  const l0 = { id: 'L0' };
  const l1 = { id: 'L1' };
  const l2 = { id: 'L2' };
  const sim = createDesignerSim([l0, l1, l2]);

  const l3 = { id: 'L3' };
  sim.doAction({ type: 'add', items: [l3], indices: [3] });
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2', 'L3']);

  sim.undo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  sim.redo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2', 'L3'], 'Redo appends at index 3');
});

test('EDIT-2C: multiple items added in middle of list >= 3 preserve order across undo and redo', () => {
  U.clearStacks();
  const l0 = { id: 'L0' };
  const l1 = { id: 'L1' };
  const l2 = { id: 'L2' };
  const sim = createDesignerSim([l0, l1, l2]);

  const mA = { id: 'mA' };
  const mB = { id: 'mB' };
  // Under designer.js reverse splice loop, contiguous insertion at index 1 uses [1, 1]
  sim.doAction({ type: 'add', items: [mA, mB], indices: [1, 1] });
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'mA', 'mB', 'L1', 'L2']);

  sim.undo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  sim.redo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'mA', 'mB', 'L1', 'L2'], 'Redo preserves multiple inserted items order');

  // Also verify explicit split indices [1, 2] match applyAction reverse-splice behavior across undo/redo
  const sim2 = createDesignerSim([l0, l1, l2]);
  const m1 = { id: 'm1' };
  const m2 = { id: 'm2' };
  sim2.doAction({ type: 'add', items: [m1, m2], indices: [1, 2] });
  assert.deepEqual(sim2.getLayers().map(l => l.id), ['L0', 'm1', 'L1', 'm2', 'L2']);

  sim2.undo();
  assert.deepEqual(sim2.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  sim2.redo();
  assert.deepEqual(sim2.getLayers().map(l => l.id), ['L0', 'm1', 'L1', 'm2', 'L2']);
});

test('EDIT-2D: multiple items appended at end of list >= 3 preserve order across undo and redo', () => {
  U.clearStacks();
  const l0 = { id: 'L0' };
  const l1 = { id: 'L1' };
  const l2 = { id: 'L2' };
  const sim = createDesignerSim([l0, l1, l2]);

  const mA = { id: 'mA' };
  const mB = { id: 'mB' };
  // Append mA and mB at indices [3, 4]
  sim.doAction({ type: 'add', items: [mA, mB], indices: [3, 4] });
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2', 'mA', 'mB']);

  sim.undo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2']);

  sim.redo();
  assert.deepEqual(sim.getLayers().map(l => l.id), ['L0', 'L1', 'L2', 'mA', 'mB']);
});

test('EDIT-2E: computeInverse sanitizes negative indices and falls back safely', () => {
  const layers = [{ id: 'L0' }, { id: 'L1' }, { id: 'L2' }];
  const newItem = { id: 'new' };

  // If caller passes corrupted indices [-1] for add, computeInverse must not propagate [-1]
  const inverse = U.computeInverse({ type: 'add', items: [newItem], indices: [-1] }, layers);
  assert.equal(inverse.type, 'delete');
  assert.ok(Array.isArray(inverse.indices));
  assert.ok(inverse.indices.every((i) => i >= 0), 'No negative indices propagated');

  // If caller omits indices for add, computeInverse appends at layers.length
  const inverseNoIndices = U.computeInverse({ type: 'add', items: [newItem] }, layers);
  assert.deepEqual(inverseNoIndices.indices, [3]);

  // If caller passes delete for an item in layers without indices, it looks up index in layers
  const deleteInv = U.computeInverse({ type: 'delete', items: [layers[1]] }, layers);
  assert.deepEqual(deleteInv.indices, [1], 'Delete inverse finds correct index in layers');
});
