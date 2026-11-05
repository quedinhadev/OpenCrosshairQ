// Run from app: node test/ui-share.test.mjs
// VM harness for the share/import flow in src/ui/ui.js (CQ2 codes + legacy fallback).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assertNode = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync('src/ui/ui.js', 'utf8');
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const Share = require('../src/shared/share.js');
const LayersShared = require('../src/shared/layers.js');
const GeometryShared = require('../src/shared/geometry.js');

function element() {
  const classes = new Set();
  return {
    textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: { setProperty(k, v) { this[k] = v; } }, listeners: {}, children: [], attributes: {},
    classList: {
      add(...cs) { cs.forEach(c => classes.add(c)); },
      remove(...cs) { cs.forEach(c => classes.delete(c)); },
      contains(c) { return classes.has(c); },
    },
    set innerHTML(value) { this.markup = value; this.children = []; },
    get innerHTML() { return this.markup || ''; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    remove() {},
    get lastChild() { return this.children.at(-1); },
    querySelector() { return null; },
  };
}
const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, element()]));
const tick = () => new Promise(resolve => setImmediate(resolve));
const model = { color: '#ffffff', armLen: 10, armThick: 2, gap: 2, rotation: 0, dot: { enabled: false, size: 2 } };
const initial = { model, scale: 1, layers: [LayersShared.newModelLayer()], drawing: null, profiles: { currentProfileId: 'default', profiles: {} } };

const boot = (withShare) => {
  const localElements = Object.fromEntries(Object.keys(elements).map(id => [id, element()]));
  const localData = new Map();
  const patches = [];
  let emit;
  const cq = {
    getState: () => new Promise(() => {}),
    onState(fn) { emit = fn; },
    set(patch) { patches.push(patch); },
    async getProfiles() { return [{ id: 'default', name: 'default', process: null }]; },
    async getNativeStatus() { return { available: false, foreground: null, error: null }; },
    async getStreaming() { return { running: false }; },
  };
  const tabSalvos = element();
  tabSalvos.dataset = { xtab: 'salvos' };
  const sandbox = {
    window: {
      cq,
      ...(withShare ? { CQShare: Share } : {}),
      CQLayers: LayersShared, CQGeometry: GeometryShared,
      addEventListener() {}, location: { hash: '#crosshairs' },
    },
    document: {
      getElementById: id => localElements[id],
      querySelectorAll: sel => sel === '[data-xtab]' ? [tabSalvos] : [],
      createElement: element,
    },
    localStorage: { getItem: key => localData.has(key) ? localData.get(key) : null, setItem(key, value) { localData.set(key, value); } },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  };
  vm.runInNewContext(ui, sandbox);
  return { localElements, localData, patches, emit: () => emit(initial) };
};

(async () => {
  // CQ2: share button emits a compact code that decodes back to the current crosshair.
  const a = boot(true);
  a.emit();
  await tick();
  a.localElements.btnShare.listeners.click();
  await tick();
  const code = a.localElements.shareCodeText.value;
  assertNode.ok(code.startsWith('CQ2:'), `expected CQ2 code, got ${code.slice(0, 12)}`);
  const decoded = await Share.decodeShareCode(code);
  assertNode.equal(decoded.name, 'Mira compartilhada');
  assertNode.equal(decoded.layers.length, 1);

  // CQ2 import: decodes, validates, saves to favorites and applies.
  const incoming = { format: 'CQ1', name: 'Mira de outrem', creator: 'Zé', layers: [LayersShared.newShapeLayer()] };
  const incomingCode = await Share.encodeShareCode(incoming);
  a.localElements.importCodeText.value = incomingCode;
  await a.localElements.btnApplyImportCode.listeners.click();
  await tick();
  const stored = () => JSON.parse(a.localData.get('cq.savedCustomCrosshairs'));
  assertNode.equal(stored().at(-1).name, 'Mira de outrem');
  assertNode.equal(stored().at(-1).creator, 'Zé');
  assertNode.deepEqual(stored().at(-1).layers, a.patches.at(-1).layers, 'applied layers match the saved entry');
  assertNode.ok(!a.localElements.importModal.classList.contains('on'), 'import modal closes on success');

  // Legacy CQ1 (plain base64 JSON) and raw JSON still import.
  const legacy = 'CQ1:' + Buffer.from(JSON.stringify({ format: 'CQ1', name: 'Legado', layers: [] }), 'utf8').toString('base64');
  a.localElements.importCodeText.value = legacy;
  await a.localElements.btnApplyImportCode.listeners.click();
  assertNode.equal(stored().at(-1).name, 'Legado');
  a.localElements.importCodeText.value = JSON.stringify({ format: 'CQ1', name: 'Cru', layers: [] });
  await a.localElements.btnApplyImportCode.listeners.click();
  assertNode.equal(stored().at(-1).name, 'Cru');

  // Rejections: broken base64, future document version, wrong prefix.
  for (const [bad, pattern] of [
    ['CQ2:!!!!', /base64/],
    ['CQ2:' + Share.bytesToBase64Url(await Share.deflateRaw(new TextEncoder().encode('{"format":"CQ9"}'))), /não suportada/],
    ['CQ9:AAAA', /não suportada/],
  ]) {
    a.localElements.importModal.classList.add('on');
    a.localElements.importCodeText.value = bad;
    await a.localElements.btnApplyImportCode.listeners.click();
    assertNode.match(a.localElements.importStatus.textContent, pattern, `expected rejection for ${bad.slice(0, 20)}`);
    assertNode.ok(a.localElements.importModal.classList.contains('on'), 'modal stays open on failure');
  }
  assertNode.equal(stored().length, 3, 'rejections must not save entries');

  // Without CQShare the UI falls back to legacy CQ1 on share and refuses CQ2 on import.
  const b = boot(false);
  b.emit();
  await tick();
  b.localElements.btnShare.listeners.click();
  await tick();
  assertNode.ok(b.localElements.shareCodeText.value.startsWith('CQ1:'), 'legacy fallback share code');
  b.localElements.importCodeText.value = incomingCode;
  await b.localElements.btnApplyImportCode.listeners.click();
  assertNode.match(b.localElements.importStatus.textContent, /CQ2 indisponível/);
  assertNode.ok(!b.localData.has('cq.savedCustomCrosshairs'), 'refused import must not save');

  console.log('PASS: ui share/import flow (CQ2 + legacy fallback + rejections)');
})().catch((error) => { console.error(error); process.exit(1); });
