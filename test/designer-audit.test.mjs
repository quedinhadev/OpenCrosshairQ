// Tests for designer audit batch: EDIT-3, EDIT-4, EDIT-5, EDIT-6, RUN-1.
// Runs with Node test runner: node --test test/designer-audit.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../src/designer/designer.html');
const scripts = ['../src/shared/layers.js', '../src/shared/undoredo.js', '../src/designer/designer.js'];

// Simulação honesta de buffer Uint8Array para composição Canvas 2D no contexto de corte.
function createPixelContext(width = 700, height = 700) {
  const pixels = new Uint8Array(width * height * 4);
  let gco = 'source-over';
  const gcoStack = [];
  let pathType = null;
  let arcParams = null;
  let lastOperation = null;

  return {
    width,
    height,
    get globalCompositeOperation() { return gco; },
    set globalCompositeOperation(v) { gco = v; },
    get lastOperation() { return lastOperation; },
    fillStyle: '#000',
    save() { gcoStack.push(gco); },
    restore() { gco = gcoStack.pop() ?? 'source-over'; },
    beginPath() { pathType = null; arcParams = null; },
    arc(cx, cy, r, sa, ea) {
      pathType = 'arc';
      arcParams = { cx, cy, r };
    },
    clearRect(x, y, w, h) {
      const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(width, Math.ceil(x + w));
      const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(height, Math.ceil(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const idx = (py * width + px) * 4;
          pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
        }
      }
    },
    drawImage(img, dx, dy, dw, dh) {
      const x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(width, Math.ceil(dx + dw));
      const y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(height, Math.ceil(dy + dh));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const idx = (py * width + px) * 4;
          pixels[idx] = 255;     // R
          pixels[idx + 1] = 0;   // G
          pixels[idx + 2] = 0;   // B
          pixels[idx + 3] = 255; // A
        }
      }
    },
    fillRect(rx, ry, rw, rh) {
      lastOperation = gco;
      const x0 = Math.floor(rx), x1 = Math.ceil(rx + rw);
      const y0 = Math.floor(ry), y1 = Math.ceil(ry + rh);
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const inside = px >= x0 && px < x1 && py >= y0 && py < y1;
          const idx = (py * width + px) * 4;
          if (gco === 'destination-in') {
            if (!inside) pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
          } else if (gco === 'destination-out') {
            if (inside) pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
          } else {
            if (inside) { pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 255; }
          }
        }
      }
    },
    fill() {
      lastOperation = gco;
      if (pathType === 'arc' && arcParams) {
        const { cx, cy, r } = arcParams;
        const rSq = r * r;
        for (let py = 0; py < height; py++) {
          for (let px = 0; px < width; px++) {
            const dx = px - cx, dy = py - cy;
            const inside = (dx * dx + dy * dy) <= rSq;
            const idx = (py * width + px) * 4;
            if (gco === 'destination-in') {
              if (!inside) pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
            } else if (gco === 'destination-out') {
              if (inside) pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = pixels[idx + 3] = 0;
            } else {
              if (inside) { pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 255; }
            }
          }
        }
      }
    },
    getPixel(x, y) {
      const idx = (y * width + x) * 4;
      return { r: pixels[idx], g: pixels[idx + 1], b: pixels[idx + 2], a: pixels[idx + 3] };
    },
  };
}

function element(tagName = 'div', ownerDocument = null, cutCtx = null) {
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(), ownerDocument,
    value: '', textContent: '', disabled: false, hidden: false,
    style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
        return force;
      },
    },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...children) { for (const child of children) this.appendChild(child); },
    remove() {
      this.fire('blur');
      if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
      const parent = this.parentElement;
      if (parent) parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    },
    blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null; this.fire('blur'); },
    select() {},
    matches(selector) { return selector.split(',').some(part => part.trim() === this.tagName.toLowerCase() || (part.trim() === '[contenteditable="true"]' && this.contentEditable === 'true')); },
    closest(selector) { return selector === 'input, button' && (this.type === 'text' || this.type === 'button') ? this : null; },
    animate(keyframes, options) {
      const animation = {
        keyframes, options, playState: 'running', currentTime: 0, playbackRate: 1,
        listeners: {},
        cancel() { this.playState = 'idle'; this.currentTime = null; },
        pause() { this.playState = 'paused'; },
        play() { this.playState = 'running'; },
        reverse() { this.playbackRate *= -1; this.play(); },
        finish() {
          this.playState = 'finished';
          this.onfinish?.();
          for (const h of this.listeners.finish || []) h();
        },
        addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
      };
      (this.animations ??= []).push(animation);
      return animation;
    },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
    removeEventListener(type, handler) {
      const arr = this.listeners[type];
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i !== -1) arr.splice(i, 1);
    },
    fire(type, event = {}) {
      for (const handler of [...(this.listeners[type] || [])]) handler({ target: this, ...event });
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() {
      if (!this.ownerDocument || this.ownerDocument.activeElement === this) return;
      this.ownerDocument.activeElement?.blur();
      this.ownerDocument.activeElement = this;
    },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    getContext(type) {
      if (type === '2d') return cutCtx ?? {};
      return {};
    },
    toDataURL: () => 'data:image/png;base64,mock',
    set innerHTML(markup) {
      this.markup = markup;
      this.children = [];
      for (const [, attributes] of markup.matchAll(/<input\b([^>]*)>/g)) {
        const input = element('input', this.ownerDocument);
        for (const [, key, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
          input[key] = value;
        }
        this.children.push(input);
      }
    },
    get innerHTML() { return this.markup || ''; },
    querySelector(selector) {
      return this.children.find(child => selector === 'input' ||
        (selector === 'input[type=color]' ? child.type === 'color' : child.class === selector.replace('input.', '')));
    },
  };
}

async function harness() {
  const document = { activeElement: null };
  const cutCtx = createPixelContext(700, 700);
  const elements = Object.fromEntries(
    [...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(([, tag, id]) => [id, element(tag, document, cutCtx)])
  );
  const get = id => {
    if (id.startsWith('layer-')) return elements[id] ??= element('div', document, cutCtx);
    assert.ok(elements[id], `Unknown Designer element: ${id}`);
    return elements[id];
  };
  get('zoomBadge').parentElement = get('main');
  for (const id of ['apDelay', 'apDur']) {
    const attrs = html.match(new RegExp(`id="${id}"([^>]*)`))[1];
    for (const [, key, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) get(id)[key] = value;
  }
  let stateListener;
  let current;
  let LayersApi;
  const patches = [];
  const broadcasts = [];
  const documentListeners = {};
  const windowEvents = element('window', document);
  const media = element(); media.matches = false;
  const storage = new Map();
  const sandbox = {
    console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout, clearTimeout,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    matchMedia: () => media,
    document: Object.assign(document, {
      body: element('body', document),
      createElement: tag => element(tag, document, cutCtx),
      getElementById: get,
      addEventListener(type, handler) { (documentListeners[type] ??= []).push(handler); },
      querySelectorAll(selector) {
        assert.ok(['#arqMenu .menu-item', '.mode-tab'].includes(selector), `Unhandled selector: ${selector}`);
        return [];
      },
    }),
    URL: {
      createObjectURL: () => 'blob:mock-image',
      revokeObjectURL: () => {},
    },
    Image: class {
      constructor() {
        this.width = 600;
        this.height = 600;
      }
      set src(v) {
        this._src = v;
        if (typeof this.onload === 'function') this.onload();
      }
      get src() { return this._src; }
    },
    cq: {
      onState(handler) { stateListener = handler; },
      getState: () => Promise.resolve(structuredClone(current)),
      set(patch) {
        patches.push(structuredClone(patch));
        try {
          const merged = { ...current, ...structuredClone(patch) };
          if (Array.isArray(patch.layers)) merged.layers = LayersApi.validateLayers(patch.layers);
          current = merged;
          broadcasts.push(structuredClone(current));
        } catch (e) {}
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of scripts.slice(0, 2)) vm.runInContext(read(file), context, { filename: file });
  LayersApi = context.CQLayers;
  const layer = structuredClone(context.CQLayers.newModelLayer());
  layer.id = 'layer-A';
  current = { profiles: { currentProfileId: 'A' }, layers: [layer] };
  vm.runInContext(read(scripts[2]), context, { filename: scripts[2] });
  await new Promise(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(get('layers').children.length, 1, 'renderer booted');

  const flush = () => { while (broadcasts.length) stateListener(broadcasts.shift()); };
  return {
    get, patches, flush, storage, document, context, cutCtx,
    windowEvent: (type, event) => windowEvents.fire(type, event),
    reducedMotion(value) { media.matches = value; media.fire('change', { matches: value }); },
    createElement: tag => element(tag, document, cutCtx),
    allLayers: () => structuredClone(current.layers),
    setLayers(list) { current.layers = structuredClone(list); stateListener(structuredClone(current)); },
    setMode: mode => get(mode === 'animar' ? 'rpAnimar' : 'rpDesign').fire('click'),
    documentEvent(type, event = {}) { for (const handler of documentListeners[type] || []) handler(event); },
    newLayer: () => structuredClone(context.CQLayers.newModelLayer()),
    endEdit: () => context.CQUndo.endDebounce(),
    dispose: () => context.CQUndo.clearStacks(),
  };
}

// ---------------------------------------------------------------------------
// EDIT-3: Selection post-delete selects current neighbor at idx or previous at idx-1
// ---------------------------------------------------------------------------
test('EDIT-3: delete selects current neighbor at idx or previous at idx-1', async () => {
  const h = await harness();
  try {
    const lA = h.allLayers()[0]; lA.id = 'A'; lA.name = 'A';
    const lB = h.newLayer(); lB.id = 'B'; lB.name = 'B';
    const lC = h.newLayer(); lC.id = 'C'; lC.name = 'C';
    h.setLayers([lA, lB, lC]);

    // In [A, B, C], select B (idx 1).
    let rowB = h.get('layers').children.find(r => r.dataset.id === 'B');
    rowB.fire('click');
    assert.equal(rowB.classList.contains('sel'), true);

    // Delete B: remaining is [A, C]. Successor at idx 1 is C.
    rowB.children.find(c => c.textContent === 'x').fire('click', { stopPropagation() {} });
    h.flush();
    assert.deepEqual(h.allLayers().map(l => l.id), ['A', 'C']);
    const selAfter3 = h.get('layers').children.find(r => r.classList.contains('sel'));
    assert.equal(selAfter3?.dataset?.id, 'C', 'delete B in [A,B,C] must select C (layers[idx])');

    // In [A, B, C, D], delete B (idx 1) must select C, not jump over to D.
    const lD = h.newLayer(); lD.id = 'D'; lD.name = 'D';
    h.setLayers([lA, lB, lC, lD]);
    const rowB4 = h.get('layers').children.find(r => r.dataset.id === 'B');
    rowB4.fire('click');
    rowB4.children.find(c => c.textContent === 'x').fire('click', { stopPropagation() {} });
    h.flush();
    assert.deepEqual(h.allLayers().map(l => l.id), ['A', 'C', 'D']);
    const selAfter4 = h.get('layers').children.find(r => r.classList.contains('sel'));
    assert.equal(selAfter4?.dataset?.id, 'C', 'delete B in [A,B,C,D] must select C (not skip to D)');

    // In [A, C], delete last item C: fallback to idx - 1 selects A.
    h.setLayers([lA, lC]);
    const rowC = h.get('layers').children.find(r => r.dataset.id === 'C');
    rowC.fire('click');
    rowC.children.find(c => c.textContent === 'x').fire('click', { stopPropagation() {} });
    h.flush();
    assert.deepEqual(h.allLayers().map(l => l.id), ['A']);
    const selAfterLast = h.get('layers').children.find(r => r.classList.contains('sel'));
    assert.equal(selAfterLast?.dataset?.id, 'A', 'delete last item in [A,C] selects previous A (layers[idx-1])');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// EDIT-4: Stage drag finalizes on window blur matching pointercancel
// ---------------------------------------------------------------------------
test('EDIT-4: window blur ends stage drag cleanly', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.x = 0;
    h.setLayers([l]);

    const stage = h.get('stage');
    const targetA = { closest: () => ({ id: 'layer-layer-A' }) };

    // Start drag gesture on stage
    stage.fire('pointerdown', { button: 0, target: targetA, clientX: 200, clientY: 200, pointerId: 1 });
    h.documentEvent('pointermove', { clientX: 400, clientY: 200 });
    assert.equal(h.document.body.classList.contains('dragging'), true, 'dragging active during drag');

    // Window blur must finalize drag
    h.windowEvent('blur');
    assert.equal(h.document.body.classList.contains('dragging'), false, 'window blur clears dragging');

    // Pointercancel also finalizes (mirror check)
    stage.fire('pointerdown', { button: 0, target: targetA, clientX: 200, clientY: 200, pointerId: 2 });
    h.documentEvent('pointermove', { clientX: 300, clientY: 200 });
    assert.equal(h.document.body.classList.contains('dragging'), true);
    h.documentEvent('pointercancel');
    assert.equal(h.document.body.classList.contains('dragging'), false, 'pointercancel clears dragging');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// EDIT-5: preview one-shot resets aria-pressed only when all finish;
// does not kill loops/hold; immune to stale callbacks on retrigger/cancel.
// ---------------------------------------------------------------------------
test('EDIT-5: preview one-shot auto-resets when all one-shots finish', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'left', pressType: 'press', duration: 300, loop: false };
    h.setLayers([l]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');

    // Click 1: starts one-shot animation
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');
    const node = h.get('layer-layer-A');
    assert.equal(node.animations.length, 1);
    const anim = node.animations[0];

    // Finish WAAPI animation naturally
    anim.finish();

    // Trigger state must be automatically reset
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false', 'aria-pressed reset to false after one-shot finished');

    // Next click immediately re-fires without requiring double-click toggle
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true', 're-fires on first click');
    assert.equal(node.animations.length, 2, 'second animation started immediately');
  } finally {
    h.dispose();
  }
});

test('EDIT-5: multi-layer one-shot waits for all layers before resetting trigger', async () => {
  const h = await harness();
  try {
    const l1 = h.allLayers()[0];
    l1.id = 'L1';
    l1.firingOptions = { trigger: 'left', pressType: 'press', duration: 200, loop: false };
    const l2 = h.newLayer();
    l2.id = 'L2';
    l2.firingOptions = { trigger: 'left', pressType: 'press', duration: 800, loop: false };
    h.setLayers([l1, l2]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');

    const node1 = h.get('layer-L1');
    const node2 = h.get('layer-L2');
    const anim1 = node1.animations.at(-1);
    const anim2 = node2.animations.at(-1);

    // Fast animation finishes first (at 200ms)
    anim1.finish();
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true', 'longer animation still running, trigger remains active');

    // Slow animation finishes (at 800ms)
    anim2.finish();
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false', 'all one-shots finished, trigger resets');
  } finally {
    h.dispose();
  }
});

test('EDIT-5: persistent loop/hold layers do not auto-reset when one-shot finishes', async () => {
  const h = await harness();
  try {
    const l1 = h.allLayers()[0];
    l1.id = 'L1';
    l1.firingOptions = { trigger: 'left', pressType: 'press', duration: 200, loop: false };
    const l2 = h.newLayer();
    l2.id = 'L2';
    l2.firingOptions = { trigger: 'left', pressType: 'hold', duration: 500, loop: true };
    h.setLayers([l1, l2]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');

    const anim1 = h.get('layer-L1').animations.at(-1);
    anim1.finish();

    // Trigger must remain active because L2 is a loop/hold
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true', 'loop/hold layer keeps trigger active');
  } finally {
    h.dispose();
  }
});

test('EDIT-5: cancel/retrigger supersedes old session callback', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'left', pressType: 'press', duration: 300, loop: false };
    h.setLayers([l]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');

    // Session 1 starts
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');
    const anim1 = h.get('layer-layer-A').animations.at(-1);

    // User cancels (active = false)
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false');

    // User starts Session 2
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');
    const anim2 = h.get('layer-layer-A').animations.at(-1);

    // Stale callback from session 1 finishes now
    anim1.finish();

    // Must NOT turn off Session 2!
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true', 'stale session 1 callback ignored');

    // When session 2 finishes, it resets properly
    anim2.finish();
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false', 'session 2 finishes and resets');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// EDIT-6: Image crop uses destination-in (keeps selected area, clears outside);
// pixel-level verification via raster canvas buffer.
// ---------------------------------------------------------------------------
test('EDIT-6: crop modal uses destination-in and preserves pixels inside crop rect', async () => {
  const h = await harness();
  try {
    const cutFile = h.get('cutFile');
    cutFile.files = [{ name: 'test.png', size: 1024, type: 'image/png' }];
    cutFile.fire('change');

    // Image loaded: 600x600 drawn in center (from x=50, y=50 to x=650, y=650).
    // Verify pixels prior to crop:
    assert.equal(h.cutCtx.getPixel(350, 350).a, 255, 'center pixel drawn by image');
    assert.equal(h.cutCtx.getPixel(100, 100).a, 255, 'margin pixel drawn by image');
    assert.equal(h.cutCtx.getPixel(10, 10).a, 0, 'corner pixel outside image is blank');

    // Set crop size: 300x300 rect at center cx=350, cy=350 -> crop rect is [200, 500] x [200, 500]
    h.get('cutSize').value = '300';
    h.get('cutShape').value = 'rect';

    // Commit crop
    h.get('cutCommit').fire('click');

    // Operator recorded during composite must be destination-in
    assert.equal(h.cutCtx.lastOperation, 'destination-in');

    // Pixel verification:
    // Inside crop rect (350, 350): preserved!
    const insidePixel = h.cutCtx.getPixel(350, 350);
    assert.equal(insidePixel.a, 255, 'inside crop pixel retained');
    assert.equal(insidePixel.r, 255, 'inside crop color retained');

    // Outside crop rect (100, 100): cleared (alpha === 0)!
    const outsidePixel = h.cutCtx.getPixel(100, 100);
    assert.equal(outsidePixel.a, 0, 'outside crop pixel cleared to transparent');
  } finally {
    h.dispose();
  }
});

test('EDIT-6: circle crop modal preserves center circle and clears corners', async () => {
  const h = await harness();
  try {
    const cutFile = h.get('cutFile');
    cutFile.files = [{ name: 'test.png', size: 1024, type: 'image/png' }];
    cutFile.fire('change');

    // Circle crop: radius = 150 at center 350, 350
    h.get('cutSize').value = '300';
    h.get('cutShape').value = 'circle';
    h.get('cutCommit').fire('click');

    assert.equal(h.cutCtx.lastOperation, 'destination-in');

    // Center pixel (350, 350): distance 0 <= 150 -> retained
    assert.equal(h.cutCtx.getPixel(350, 350).a, 255, 'center circle pixel retained');

    // Point (220, 220): distance from 350, 350 is sqrt(130^2 + 130^2) = 183.8 > 150 -> cleared
    assert.equal(h.cutCtx.getPixel(220, 220).a, 0, 'outside circle pixel cleared');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// RUN-1: new model layer press defaults to releaseBehavior undefined
// (executes entire one-shot on release); explicit releaseBehavior preserved.
// ---------------------------------------------------------------------------
test('RUN-1: newModelLayer has releaseBehavior undefined for press and completes one-shot', async () => {
  const h = await harness();
  try {
    // Add new model layer through UI action (which passes through normalizeLayer and persists)
    h.get('toolSelect').fire('click');
    h.flush();

    const newModel = h.allLayers().at(-1);
    assert.equal(newModel.type, 'model');
    assert.equal(newModel.firingOptions.pressType, 'press');
    assert.equal(newModel.firingOptions.releaseBehavior, undefined, 'default releaseBehavior is undefined for press');

    // Validate through canonical validateLayers
    const validated = h.context.CQLayers.validateLayers([newModel])[0];
    assert.equal(validated.firingOptions.releaseBehavior, undefined, 'validateLayers preserves undefined releaseBehavior');

    // Configure trigger in animar mode
    newModel.firingOptions.trigger = 'left';
    newModel.firingOptions.duration = 400;
    h.setLayers([newModel]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');

    // Trigger press
    fireBtn.fire('click');
    const node = h.get('layer-' + newModel.id);
    const anim = node.animations.at(-1);
    assert.equal(anim.playState, 'running');

    // Release press before completion: behavior is null, animation continues running!
    fireBtn.fire('click');
    assert.equal(anim.playState, 'running', 'one-shot animation continues running on release');
  } finally {
    h.dispose();
  }
});

test('RUN-1: explicit releaseBehavior reset/pause/reverse is strictly preserved', async () => {
  const h = await harness();
  try {
    for (const explicitBehavior of ['reset', 'pause', 'reverse']) {
      h.get('toolSelect').fire('click');
      h.flush();
      const l = h.allLayers().at(-1);
      l.firingOptions = {
        trigger: 'left',
        pressType: 'press',
        releaseBehavior: explicitBehavior,
        duration: 500,
        stages: [],
      };
      h.setLayers([l]);
      h.setMode('animar');

      const fireBtn = h.get('previewFire');
      fireBtn.fire('click');
      const node = h.get('layer-' + l.id);
      const anim = node.animations.at(-1);
      anim.currentTime = 100;

      // Release press: explicit behavior takes effect!
      fireBtn.fire('click');
      if (explicitBehavior === 'reset') {
        assert.equal(anim.playState, 'idle', 'reset cancels animation');
      } else if (explicitBehavior === 'pause') {
        assert.equal(anim.playState, 'paused', 'pause pauses animation');
      } else if (explicitBehavior === 'reverse') {
        assert.equal(anim.playbackRate, -1, 'reverse inverts playback');
      }
    }
  } finally {
    h.dispose();
  }
});

test('release select clears stale explicit value and default round-trips through validation', async () => {
  const h = await harness();
  try {
    const layer = h.allLayers()[0];
    layer.firingOptions = { ...layer.firingOptions, pressType: 'press', releaseBehavior: 'pause' };
    h.setLayers([layer]);
    assert.equal(h.get('apRelease').value, 'pause');
    delete layer.firingOptions.releaseBehavior;
    h.setLayers([layer]);
    assert.equal(h.get('apRelease').value, '', 'implicit release must select Padrão, not stale Pausar');
    for (const pressType of ['press', 'hold']) {
      layer.firingOptions.pressType = pressType;
      layer.firingOptions.releaseBehavior = 'pause';
      h.setLayers([layer]);
      h.get('apRelease').value = '';
      h.get('apRelease').fire('change');
      h.flush();
      const expected = pressType === 'hold' ? 'reset' : undefined;
      assert.equal(h.allLayers()[0].firingOptions.releaseBehavior, expected);
      assert.equal(h.get('apRelease').value, expected ?? '');
    }
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Preview Audit Fixes: disable autoplay, disable press+loop, persistent sem node/animate, empty triggers
// ---------------------------------------------------------------------------
test('preview: disable autoplay cancels running animation and resets button', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'autoplay', duration: 400 };
    h.setLayers([l]);
    h.setMode('animar');

    const autoBtn = h.get('previewAutoplay');
    autoBtn.fire('click');
    assert.equal(autoBtn.getAttribute('aria-pressed'), 'true');
    const node = h.get('layer-' + l.id);
    assert.equal(node.animations.length, 1);
    const anim = node.animations.at(-1);
    assert.equal(anim.playState, 'running');

    // Click again to deactivate autoplay: must cancel animation
    autoBtn.fire('click');
    assert.equal(autoBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(anim.playState, 'idle', 'autoplay animation must be cancelled when toggled off');
  } finally {
    h.dispose();
  }
});

test('preview: disable press+loop cancels running animation and resets button', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'left', pressType: 'press', loop: true, duration: 300 };
    h.setLayers([l]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');
    const node = h.get('layer-' + l.id);
    const anim = node.animations.at(-1);
    assert.equal(anim.options.iterations, Infinity);
    assert.equal(anim.playState, 'running');

    // Toggle off: default releaseBehavior is undefined, but for loop it must stop!
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(anim.playState, 'idle', 'press+loop animation must be cancelled when stopped manually');
  } finally {
    h.dispose();
  }
});

test('preview: persistent layer without node.animate does not block one-shot auto-reset', async () => {
  const h = await harness();
  try {
    const l1 = h.allLayers()[0];
    l1.id = 'L1';
    l1.firingOptions = { trigger: 'left', pressType: 'press', duration: 200, loop: false };
    const l2 = h.newLayer();
    l2.id = 'L2-noanim';
    l2.firingOptions = { trigger: 'left', pressType: 'press', duration: 500, loop: true };
    h.setLayers([l1, l2]);
    h.setMode('animar');

    // Remove animate from L2's DOM node
    const node2 = h.get('layer-L2-noanim');
    node2.animate = null;

    const fireBtn = h.get('previewFire');
    fireBtn.fire('click');
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'true');

    const node1 = h.get('layer-L1');
    const anim1 = node1.animations.at(-1);
    anim1.finish();

    // Because L2 cannot animate and created no timeline, fireBtn must auto-reset when L1 finishes
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false', 'trigger must reset since persistent layer has no animate');
  } finally {
    h.dispose();
  }
});

test('preview: empty eligible triggers do not remain stuck on aria-pressed=true', async () => {
  const h = await harness();
  try {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'none', pressType: 'press', duration: 300 };
    h.setLayers([l]);
    h.setMode('animar');

    const fireBtn = h.get('previewFire');
    fireBtn.fire('click');

    // No layer has trigger 'left' -> button must not get stuck active
    assert.equal(fireBtn.getAttribute('aria-pressed'), 'false', 'fire trigger without eligible layers must reset to false');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Designer Polish: Delete/Escape shortcuts and modal backdrop dismissal
// ---------------------------------------------------------------------------
test('designer keydown: Delete key deletes selected layer when not typing', async () => {
  const h = await harness();
  try {
    assert.equal(h.allLayers().length, 1);
    h.documentEvent('keydown', { key: 'Delete', target: h.document.body, preventDefault() {} });
    assert.equal(h.allLayers().length, 0, 'Delete key removed selected layer');
  } finally {
    h.dispose();
  }
});

test('designer keydown: Escape dismisses open modals and clears selection', async () => {
  const h = await harness();
  try {
    const modalDraw = h.get('modalDraw');
    modalDraw.style.display = 'flex';
    h.documentEvent('keydown', { key: 'Escape', target: h.document.body, preventDefault() {} });
    assert.equal(modalDraw.style.display, 'none', 'Escape closes draw modal');

    const modalCut = h.get('modalCut');
    modalCut.style.display = 'flex';
    h.documentEvent('keydown', { key: 'Escape', target: h.document.body, preventDefault() {} });
    assert.equal(modalCut.style.display, 'none', 'Escape closes cut modal');

    // Backdrop click dismiss
    modalDraw.style.display = 'flex';
    modalDraw.fire('click', { target: modalDraw });
    assert.equal(modalDraw.style.display, 'none', 'Backdrop click closes draw modal');

    modalCut.style.display = 'flex';
    modalCut.fire('click', { target: modalCut });
    assert.equal(modalCut.style.display, 'none', 'Backdrop click closes cut modal');
  } finally {
    h.dispose();
  }
});
