import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');

// Real renderer, in-memory DOM/IPC only. No userData, app launch or raster claims.
function element(tag = 'div', document) {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(), value: '', textContent: '', style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k),
      toggle(k, force = !classes.has(k)) { if (force) classes.add(k); else classes.delete(k); return force; } },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); },
    fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, ...event }); },
    setAttribute(k, v) { this.attributes[k] = v; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    getContext: () => ({}),
    focus() { document.activeElement = this; },
    matches() { return false; },
    set innerHTML(markup) {
      this.markup = markup; this.children = [];
      for (const [, attrs] of markup.matchAll(/<input\b([^>]*)>/g)) {
        const input = element('input', document);
        for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) input[k] = v;
        this.appendChild(input);
      }
    },
    get innerHTML() { return this.markup || ''; },
    querySelector(selector) {
      const found = this.children.find(c => selector === 'input' ||
        (selector === 'input[type=color]' ? c.type === 'color' : c.class === selector.replace('input.', '')));
      assert.ok(found, `Missing ${selector}`); return found;
    },
  };
}

async function designer(initial) {
  const document = { activeElement: null };
  const html = read('../src/designer/designer.html');
  const nodes = Object.fromEntries([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map(([, tag, id]) => [id, element(tag, document)]));
  const get = id => { assert.ok(nodes[id], `Unknown ${id}`); return nodes[id]; };
  get('zoomBadge').parentElement = get('main');
  let current = structuredClone(initial), listener;
  const patches = [], timers = new Map();
  let seq = 0;
  const window = {
    console, document, localStorage: { getItem: () => null, setItem() {} },
    // Boot timeout recorded, never fires: getState resolves synchronously below.
    setTimeout(fn) { timers.set(++seq, fn); return seq; }, clearTimeout(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
    cq: { getState: async () => structuredClone(current), onState(fn) { listener = fn; },
      set(patch) { patches.push(structuredClone(patch)); current = { ...current, ...structuredClone(patch) }; } },
  };
  Object.assign(document, { getElementById: get, querySelectorAll: () => [],
    createElement: tag => element(tag, document), body: element('body', document), addEventListener() {} });
  window.window = window; window.self = window;
  const context = vm.createContext(window);
  for (const file of ['../src/shared/layers.js', '../src/shared/undoredo.js', '../src/designer/designer.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // Await getState, Promise.race and then/applyState; no real timers/resources.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return { get, patches, emit(state) { current = structuredClone(state); listener(structuredClone(state)); },
    preview: () => get('preview').innerHTML,
    dispose() { context.CQUndo.clearStacks(); timers.clear(); } };
}

function overlay() {
  const nodes = Object.fromEntries(['primary', 'secondary'].map(id => [id, { style: {}, firstElementChild: { innerHTML: '' } }]));
  let listener;
  const frames = new Map(); let seq = 0;
  const window = { CQLayers: L, CQGeometry: {}, CQGameState: { isCrosshairVisible: () => true },
    performance: { now: () => 0 }, addEventListener() {}, cq: { onState(fn) { listener = fn; }, onInput() {} } };
  vm.runInNewContext(read('../src/overlay/overlay.js'), { window,
    document: { getElementById: id => nodes[id], documentElement: { getBoundingClientRect: () => ({ width: 961, height: 541 }) } },
    requestAnimationFrame(fn) { frames.set(++seq, fn); return seq; }, cancelAnimationFrame(id) { frames.delete(id); } });
  return { emit(payload) { listener({ model2: {}, scale: 1, offsetX: 0, offsetY: 0, ...payload }); },
    body: () => nodes.primary.firstElementChild.innerHTML };
}

const preset = { model: { gap: 0, armLen: 11, armThick: 3, rotation: 30, opacity: 1, color: '#67c1f5',
  dot: { enabled: true, size: 5, shape: 'square' }, outline: { enabled: true, width: 2, color: '#123456' } },
  layers: [], drawing: null, profiles: { currentProfileId: 'A' } };

test('preset -> canonical thumbnail -> real Designer preview -> real overlay, no passive writes', async () => {
  const state = { ...preset, ...L.validateCrosshair(preset) };
  const h = await designer(state), o = overlay();
  try {
    const body = L.renderCrosshair(state);
    assert.equal(h.preview(), body);
    // Synthetic bbox input; compares canonical body only, not UI paint measurement.
    assert.ok(L.thumbnailSvg(state, { x: -16, y: -16, width: 32, height: 32 }).includes(body));
    o.emit(state); assert.equal(o.body(), body);
    assert.match(body, /fill="#67c1f5"/); assert.match(body, /stroke="#123456" stroke-width="2"/);
    assert.match(body, /width="5" height="5"/);
    assert.equal(h.patches.length, 0, 'opening preset never persists converted layers');
    const row = h.get('layers').children[0];
    h.emit({ ...state, visible: false, scale: 2 });
    assert.equal(h.get('layers').children[0], row, 'unrelated broadcast does not rebuild document');
    assert.equal(h.patches.length, 0);
    const changed = { ...state, model: { ...state.model, color: '#ff8000', armLen: 0, armThick: 0 } };
    h.emit(changed); o.emit(changed);
    assert.equal(h.preview(), L.renderCrosshair(changed)); assert.equal(o.body(), h.preview());
    assert.doesNotMatch(h.preview(), /<rect[^>]*width="11"/);
    assert.equal(h.patches.length, 0, 'model changes with empty layers refresh without writing');
    h.get('lnAdd').fire('click');
    assert.equal(h.patches.length, 1, 'explicit edit commits converted document');
    assert.equal(h.patches[0].layers[0].armLength, 0);
    assert.equal(h.patches[0].layers[0].dot.color, '#ff8000');
  } finally { h.dispose(); }
});

test('explicit empty survives first boot/profile switch; add command alone creates intentional default', async () => {
  const empty = { ...preset, layers: [], drawing: '' };
  const h = await designer(empty), o = overlay();
  try {
    assert.equal(h.preview(), ''); assert.equal(h.get('layers').children.length, 0); assert.equal(h.patches.length, 0);
    h.emit({ ...preset, profiles: { currentProfileId: 'B' } });
    assert.equal(h.preview(), L.renderCrosshair(preset));
    h.emit({ ...empty, profiles: { currentProfileId: 'C' } }); o.emit(empty);
    assert.equal(h.preview(), ''); assert.equal(o.body(), ''); assert.equal(h.patches.length, 0);
    assert.equal(h.get('undoBtn').disabled, true);
    h.get('lnAdd').fire('click');
    const layer = h.patches[0].layers[0];
    assert.equal(h.patches.length, 1); assert.equal(layer.armLength, 0); assert.equal(layer.armThickness, 0);
    assert.equal(layer.dot.enabled, true); assert.equal(layer.dot.size, 4); assert.equal(layer.outline.enabled, true);
    assert.equal(h.preview(), L.renderLayers(h.patches[0].layers));
  } finally { h.dispose(); }
});

test('absent/false/zero/empty remain distinct across preset and editable round trips', async () => {
  const value = { ...preset, model: { ...preset.model, opacity: 0, armLen: 0, armThick: 0,
    dot: { enabled: false, size: 0, shape: 'circle' }, outline: { enabled: false, width: 0, color: '#000000' } } };
  const h = await designer(value);
  try {
    assert.equal(h.preview(), L.renderCrosshair(value)); assert.equal(h.patches.length, 0);
    h.get('lnAdd').fire('click');
    const doc = L.validateCrosshair(JSON.parse(JSON.stringify(h.patches[0])));
    const layer = doc.layers[0];
    assert.equal(layer.opacity, 0); assert.equal(layer.armLength, 0); assert.equal(layer.armThickness, 0);
    assert.equal(layer.dot.enabled, false); assert.equal(layer.dot.size, 0); assert.equal(layer.outline.width, 0);
    assert.equal(layer.outline.enabled, false);
    assert.equal(L.renderCrosshair(doc), h.preview());
  } finally { h.dispose(); }
});
