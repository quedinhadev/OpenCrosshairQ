// Undo/redo service. Mirrors the exact mechanism observed in the original
// designer: capped stacks (100, oldest dropped), consecutive "update" actions
// coalesced within a 300 ms window (later inverses deep-merge into the
// window's stack entry; repeated paths keep the original inverse), redo
// cleared on new undo, recursive partial inverses for update patches,
// add/delete keep indices. Dual export (renderer classic script / tests).
// Reimplemented from scratch — no original code copied.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CQUndo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STACK_SIZE = 100;
  const DEBOUNCE_MS = 300;

  const undoStack = [];
  const redoStack = [];
  const subscribers = new Set();
  let debounceTimer = null;
  let debouncing = false;
  let debounceEntry = null; // stack entry that owns the open coalescing window

  function notify() { subscribers.forEach((fn) => fn()); }
  function endDebounce() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    debouncing = false;
    debounceEntry = null;
  }

  function cap(stack) {
    if (stack.length > MAX_STACK_SIZE) stack.shift();
  }

  const cloneVal = (v) => (v && typeof v === 'object' ? (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))) : v);

  /** Recursive partial inverse: for each changed key, capture the current value. */
  function extractInversePartial(current, patch) {
    const out = {};
    for (const key of Object.keys(patch)) {
      const p = patch[key];
      const c = current?.[key];
      if (p && typeof p === 'object' && !Array.isArray(p) && p !== null &&
          c && typeof c === 'object' && !Array.isArray(c) && c !== null) {
        out[key] = extractInversePartial(c, p);
      } else {
        out[key] = cloneVal(c);
      }
    }
    return out;
  }

  function resolveIndices(action, layers, isAdd) {
    if (Array.isArray(action.indices) &&
        action.indices.length === action.items?.length &&
        action.indices.every((idx) => typeof idx === 'number' && idx >= 0)) {
      return action.indices.slice();
    }
    if (isAdd) {
      return (action.items || []).map((_, i) => layers.length + i);
    }
    return (action.items || []).map((item) => {
      const idx = layers.findIndex((l) => l.id === item.id);
      return idx >= 0 ? idx : layers.length;
    });
  }

  /** Compute the inverse action against the current layer list. */
  function computeInverse(action, layers) {
    switch (action.type) {
      case 'update': {
        const patches = new Map();
        for (const [id, patch] of action.patches) {
          const layer = layers.find((l) => l.id === id);
          if (layer) patches.set(id, extractInversePartial(layer, patch));
        }
        return { type: 'update', patches };
      }
      case 'add': {
        return { type: 'delete', items: (action.items || []).slice(), indices: resolveIndices(action, layers, true) };
      }
      case 'delete': {
        return { type: 'add', items: (action.items || []).slice(), indices: resolveIndices(action, layers, false) };
      }
      case 'reorder': {
        return { type: 'reorder', from: action.to, to: action.from };
      }
      default:
        throw new Error('No inverse defined for action type: ' + action.type);
    }
  }

  /** Merge a coalesced update inverse into the window's stack entry.
   *  Repeated keys keep the recorded inverse (the ORIGINAL pre-edit value);
   *  new keys and new nested paths enter with their pre-application value. */
  function mergeInversePatch(target, patch) {
    for (const key of Object.keys(patch)) {
      const p = patch[key];
      const t = target[key];
      if (p && typeof p === 'object' && !Array.isArray(p) && p !== null &&
          t && typeof t === 'object' && !Array.isArray(t) && t !== null) {
        mergeInversePatch(t, p);
      } else if (!Object.prototype.hasOwnProperty.call(target, key)) {
        target[key] = cloneVal(p); // first edit of this property inside the window
      }
      // Repeated key: keep the existing inverse so Undo reverts past every
      // intermediate edit to the original value.
    }
  }
  function mergeInverseUpdate(top, inverse) {
    for (const [id, patch] of inverse.patches) {
      const existing = top.patches.get(id);
      if (!existing) top.patches.set(id, cloneVal(patch)); // new layer entry in the window
      else mergeInversePatch(existing, patch);
    }
  }

  /** Push an inverse action. Consecutive updates within 300 ms coalesce:
   *  later inverses deep-merge into the window's entry (new paths enter,
   *  repeated paths keep the original inverse). */
  function pushUndo(inverse) {
    if (inverse.type === 'update') {
      if (debouncing && undoStack[undoStack.length - 1] === debounceEntry) {
        mergeInverseUpdate(debounceEntry, inverse);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(endDebounce, DEBOUNCE_MS);
        return; // coalesced into the window entry
      }
      debouncing = true;
      debounceEntry = inverse;
      debounceTimer = setTimeout(endDebounce, DEBOUNCE_MS);
    } else {
      endDebounce();
    }
    undoStack.push(inverse);
    cap(undoStack);
    redoStack.length = 0;
    notify();
  }

  function pushUndoFromRedo(inverse) {
    endDebounce();
    undoStack.push(inverse);
    cap(undoStack);
    notify();
  }

  function pushRedo(action) {
    redoStack.push(action);
    cap(redoStack);
    notify();
  }

  return {
    MAX_STACK_SIZE, DEBOUNCE_MS,
    extractInversePartial, computeInverse, pushUndo, pushUndoFromRedo, pushRedo,
    endDebounce,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    popUndo: () => { endDebounce(); return undoStack.pop(); },
    popRedo: () => { endDebounce(); return redoStack.pop(); },
    clearStacks: () => { endDebounce(); undoStack.length = 0; redoStack.length = 0; notify(); },
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    undoSize: () => undoStack.length,
    redoSize: () => redoStack.length,
  };
});
