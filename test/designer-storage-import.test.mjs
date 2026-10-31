import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const KEY = 'cq.savedCustomCrosshairs';
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_SHARE_CODE_LEN = 2 * 1024 * 1024;

// Actual renderer/validators/undo, isolated DOM/storage/FileReader/Image; no Electron/userData.
function element(tag = 'div', document) {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(), value: '', textContent: '', style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k),
      toggle(k, force = !classes.has(k)) { if (force) classes.add(k); else classes.delete(k); return force; } },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener() {},
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

async function designer(saved = []) {
  const document = { activeElement: null };
  const nodes = Object.fromEntries([...read('../src/designer/designer.html').matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map(([, tag, id]) => [id, element(tag, document)]));
  const get = id => { assert.ok(nodes[id], `Unknown ${id}`); return nodes[id]; };
  get('zoomBadge').parentElement = get('main');
  const storage = new Map([[KEY, JSON.stringify(saved)]]), patches = [], alerts = [], readers = [], images = [], copied = [], downloads = [];
  let quota = false;
  const window = {
    console, document, Blob, navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    alert: message => alerts.push(message), setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: key => storage.get(key) ?? null,
      setItem(key, value) { if (quota) throw new Error('QuotaExceededError'); storage.set(key, value); } },
    FileReader: class {
      constructor() { readers.push(this); }
      readAsDataURL(file) { this.file = file; }
      load(result) { this.result = result; this.onload(); }
    },
    Image: class {
      constructor() { images.push(this); this.width = 200; this.height = 100; }
      load() { this.onload(); }
    },
    cq: { getState: async () => ({ model: {}, layers: [], drawing: '', profiles: { currentProfileId: 'A' } }),
      onState() {}, set(patch) { window.CQLayers.validateCrosshair(patch); patches.push(structuredClone(patch)); } },
  };
  Object.assign(document, { getElementById: get, querySelectorAll: () => [],
    createElement: tag => Object.assign(element(tag, document), { click() {}, remove() {} }), body: element('body', document), addEventListener() {} });
  window.window = window; window.self = window;
  const context = vm.createContext(window);
  for (const file of ['../src/shared/layers.js', '../src/shared/undoredo.js', '../src/designer/designer.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return { get, storage, patches, alerts, readers, images, copied, downloads, undo: window.CQUndo, layers: window.CQLayers,
    withoutClipboard() { window.navigator.clipboard = null; },
    quota() { quota = true; }, status: () => get('docStatus').textContent,
    import(file) { get('fileInput').files = [file]; get('fileInput').fire('change'); },
    preview: () => get('preview').innerHTML };
}

const raster = bytes => 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil(bytes / 3));

test('save keeps all 51 previous favorites plus new, canonical favorite remains compatible', async () => {
  const saved = Array.from({ length: 51 }, (_, i) => ({ id: `previous_${i}`, name: `Mira ${i}` }));
  const h = await designer(saved);
  h.get('lnAdd').fire('click');
  h.get('btnSave').fire('click');
  const result = JSON.parse(h.storage.get(KEY));
  assert.equal(result.length, 52);
  assert.deepEqual(result.slice(1), saved);
  assert.equal(new Set(result.map(item => item.id)).size, 52);
  const favorite = h.layers.validateCrosshair(result[0]);
  assert.equal(favorite.drawing, h.preview());
  assert.match(h.status(), /Salvo nos favoritos/);
});

test('quota failure preserves exact stored favorites and current document', async () => {
  const h = await designer(Array.from({ length: 51 }, (_, i) => ({ id: `previous_${i}` })));
  h.get('lnAdd').fire('click');
  const before = h.storage.get(KEY), preview = h.preview(), undoSize = h.undo.undoSize();
  h.quota(); h.get('btnSave').fire('click');
  assert.equal(h.storage.get(KEY), before);
  assert.equal(h.preview(), preview); assert.equal(h.undo.undoSize(), undoSize);
  assert.match(h.status(), /favoritos indisponiveis/);
});

test('6.5 MiB file rejected before reading because encoded raster exceeds 8 MiB; next edit works', async () => {
  const h = await designer();
  h.get('lnAdd').fire('click');
  const preview = h.preview(), undoSize = h.undo.undoSize(), writes = h.patches.length;
  h.import({ size: 6.5 * 1024 * 1024, type: 'image/png' });
  assert.equal(h.readers.length, 0);
  assert.match(h.alerts.join(' '), /8 MiB.*base64/i);
  assert.equal(h.preview(), preview); assert.equal(h.undo.undoSize(), undoSize); assert.equal(h.patches.length, writes);
  h.get('addShape').fire('click');
  assert.equal(h.patches.at(-1).layers.length, 2);
});

test('FileReader result validated before mutation; rejection preserves document, undo/redo, next edit', async () => {
  const h = await designer();
  h.get('lnAdd').fire('click'); h.get('addShape').fire('click'); h.get('undoBtn').fire('click');
  const preview = h.preview(), undoSize = h.undo.undoSize(), redoSize = h.undo.redoSize(), writes = h.patches.length;
  h.import({ size: 100, type: 'image/png' });
  h.readers[0].load(raster(6.5 * 1024 * 1024));
  assert.doesNotThrow(() => h.images[0]?.load());
  assert.match(h.status(), /Imagem.*8 MiB/i);
  assert.equal(h.preview(), preview); assert.equal(h.undo.undoSize(), undoSize);
  assert.equal(h.undo.redoSize(), redoSize); assert.equal(h.patches.length, writes);
  h.get('redoBtn').fire('click');
  assert.equal(h.patches.at(-1).layers.length, 2);
  h.get('addText').fire('click');
  assert.equal(h.patches.at(-1).layers.length, 3);
});

test('valid FileReader/Image raster commits once; undo restores previous document', async () => {
  const h = await designer();
  h.get('lnAdd').fire('click');
  const preview = h.preview(), undoSize = h.undo.undoSize();
  h.import({ size: 3, type: 'image/png' });
  h.readers[0].load(raster(3)); h.images[0].load();
  assert.equal(h.patches.at(-1).layers.length, 2); assert.equal(h.undo.undoSize(), undoSize + 1);
  const image = h.patches.at(-1).layers[1];
  assert.equal(image.src, raster(3)); assert.equal(image.w, 100); assert.equal(image.h, 50);
  h.get('undoBtn').fire('click'); assert.equal(h.preview(), preview);
});

test('encoded boundary accepted; aggregate raster budget checked before mutation', async () => {
  const h = await designer();
  const bytes = Math.floor((MAX_IMAGE - 'data:image/png;base64,'.length) / 4) * 3;
  const src = raster(bytes);
  assert.ok(src.length <= MAX_IMAGE);
  for (let i = 0; i < 2; i++) {
    h.import({ size: bytes, type: 'image/png' }); h.readers[i].load(src); h.images[i].load();
  }
  const preview = h.preview(), undoSize = h.undo.undoSize(), writes = h.patches.length;
  h.import({ size: 3, type: 'image/png' }); h.readers[2].load(raster(3));
  assert.doesNotThrow(() => h.images[2].load());
  assert.match(h.status(), /Imagem.*16 MiB/i);
  assert.equal(h.preview(), preview); assert.equal(h.undo.undoSize(), undoSize); assert.equal(h.patches.length, writes);
});

test('share exports named CQ1 JSON without derived drawing; clipboard and download import equivalently', async () => {
  const h = await designer();
  h.get('lnAdd').fire('click'); h.get('docName').value = 'Mira ação 🎯';
  h.get('btnShare').fire('click'); await Promise.resolve();
  assert.equal(h.copied.length, 1); assert.equal(h.downloads.length, 0);
  const json = h.copied[0], payload = JSON.parse(json);
  assert.equal(payload.format, 'CQ1'); assert.equal(payload.name, 'Mira ação 🎯');
  assert.equal(Object.hasOwn(payload, 'drawing'), false);
  assert.equal(h.layers.validateCrosshair(payload).drawing, h.preview());
  assert.ok(json.length <= MAX_SHARE_CODE_LEN); assert.ok(new Blob([json]).size <= MAX_SHARE_CODE_LEN);
  h.withoutClipboard(); h.get('btnShare').fire('click');
  assert.equal(h.downloads.length, 1); assert.equal(await h.downloads[0].text(), json);
});

test('oversized JSON blocks clipboard and download before side effects; document/undo stay intact', async () => {
  const h = await designer();
  h.import({ size: MAX_SHARE_CODE_LEN, type: 'image/png' });
  h.readers[0].load(raster(MAX_SHARE_CODE_LEN)); h.images[0].load();
  const preview = h.preview(), undoSize = h.undo.undoSize(), writes = h.patches.length;
  h.get('btnShare').fire('click');
  assert.match(h.status(), /2 MiB.*reduza/i);
  h.withoutClipboard(); h.get('btnShare').fire('click');
  assert.equal(h.copied.length, 0); assert.equal(h.downloads.length, 0);
  assert.equal(h.preview(), preview); assert.equal(h.undo.undoSize(), undoSize); assert.equal(h.patches.length, writes);
});

test('UTF-8 JSON bytes over 2 MiB rejected even when character count fits', async () => {
  const h = await designer();
  h.get('addText').fire('click');
  h.get('docName').value = 'é'.repeat(MAX_SHARE_CODE_LEN / 2);
  const json = JSON.stringify({ format: 'CQ1', name: h.get('docName').value, layers: h.patches.at(-1).layers }, null, 2);
  assert.ok(json.length < MAX_SHARE_CODE_LEN); assert.ok(new Blob([json]).size > MAX_SHARE_CODE_LEN);
  h.get('btnShare').fire('click'); h.withoutClipboard(); h.get('btnShare').fire('click');
  assert.match(h.status(), /2 MiB.*reduza/i);
  assert.equal(h.copied.length, 0); assert.equal(h.downloads.length, 0);
});
