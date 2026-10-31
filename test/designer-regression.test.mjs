// Run from any directory: node app/test/designer-regression.test.mjs
// Executes real renderer/layers/undo scripts; DOM and IPC are in-memory stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../src/designer/designer.html');
const scripts = ['../src/shared/layers.js', '../src/shared/undoredo.js', '../src/designer/designer.js'];

function element(tagName = 'div', ownerDocument = null) {
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
      this.removes = (this.removes || 0) + 1;
      this.fire('blur'); // Chromium may reenter blur while detaching focused input.
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
      const animation = { keyframes, options, playState: 'running', currentTime: 0, playbackRate: 1,
        cancel() { this.playState = 'idle'; this.currentTime = null; },
        pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; },
        reverse() { this.playbackRate *= -1; this.play(); },
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
      for (const handler of this.listeners[type] || []) handler({ target: this, ...event });
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {
      if (!this.ownerDocument || this.ownerDocument.activeElement === this) return;
      this.ownerDocument.activeElement?.blur();
      this.ownerDocument.activeElement = this;
    }, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    getContext: () => ({}), // Canvas drawing is outside these regressions.
    set innerHTML(markup) {
      this.markup = markup;
      this.children = [];
      // Only input attributes are needed by renderer property-field builders.
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
      assert.ok(['input', 'input[type=color]', 'input.hex', 'input.op'].includes(selector), `Unhandled selector: ${selector}`);
      const found = this.children.find(child => selector === 'input' ||
        (selector === 'input[type=color]' ? child.type === 'color' : child.class === selector.replace('input.', '')));
      assert.ok(found, `Missing ${selector} in ${this.innerHTML}`);
      return found;
    },
  };
}

async function harness() {
  const document = { activeElement: null };
  const elements = Object.fromEntries([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(([, tag, id]) => [id, element(tag, document)]));
  const get = id => {
    if (id.startsWith('layer-')) return elements[id] ??= element();
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
  let LayersApi; // bound after layers.js runs; harness set() canonicalizes like main/state.js.
  const patches = [];
  const broadcasts = [];
  const documentListeners = {};
  const windowEvents = element();
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
      body: element('body', document), createElement: tag => element(tag, document), getElementById: get,
      addEventListener(type, handler) { (documentListeners[type] ??= []).push(handler); },
      querySelectorAll(selector) {
        assert.ok(['#arqMenu .menu-item', '.mode-tab'].includes(selector), `Unhandled selector: ${selector}`);
        return [];
      },
    }),
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
        } catch (e) { /* main rejeita patch inválido sem broadcast de estado */ }
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
  // getState() real passa por Promise.race (estado + timeout): dá um tick de
  // macrotarefa e as microtarefas do race para o applyState concluir.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(get('layers').children.length, 1, 'renderer booted with initial layer');
  const flush = () => { while (broadcasts.length) stateListener(broadcasts.shift()); };
  const field = label => {
    const row = get('bodyLayer').children.find(child => child.children[0]?.textContent === label);
    assert.ok(row, `Missing field: ${label}`);
    return row.children[1].querySelector('input');
  };
  return {
    get, field, patches, flush, storage, document,
    windowEvent: (type, event) => windowEvents.fire(type, event),
    reducedMotion(value) { media.matches = value; media.fire('change', { matches: value }); },
    createElement: tag => element(tag, document),
    allLayers: () => structuredClone(current.layers),
    setLayers(list) { current.layers = structuredClone(list); stateListener(structuredClone(current)); },
    deliver(state) { stateListener(structuredClone(state)); }, // broadcast sem alterar current (eco atrasado/externo)
    setProfile(id, list) { current = { profiles: { currentProfileId: id }, layers: structuredClone(list) }; stateListener(structuredClone(current)); },
    setMode: mode => get(mode === 'animar' ? 'rpAnimar' : 'rpDesign').fire('click'),
    documentEvent(type, event = {}) { for (const handler of documentListeners[type] || []) handler(event); },
    lastLayer: () => patches.at(-1)?.layers[0],
    validate: value => context.CQLayers.validateLayers(Array.isArray(value) ? value : [value])[0],
    newLayer: () => structuredClone(context.CQLayers.newModelLayer()),
    xField: () => get('bodyLayer').children.find(child => child.className === 'grid2').children[0].children[0],
    yField: () => get('bodyLayer').children.find(child => child.className === 'grid2').children[1].children[0],
    windowListeners: type => (windowEvents.listeners[type] || []).length,
    switchProfile(empty = false) {
      const other = structuredClone(context.CQLayers.newShapeLayer());
      other.id = 'layer-B';
      current = { profiles: { currentProfileId: 'B' }, layers: empty ? [] : [other] };
      stateListener(structuredClone(current));
    },
    endEdit: () => context.CQUndo.endDebounce(),
    canRedo: () => context.CQUndo.canRedo(),
    dispose: () => context.CQUndo.clearStacks(),
  };
}

async function check(name, test) {
  const h = await harness();
  try { test(h); console.log(`PASS: ${name}`); }
  catch (error) { console.error(`FAIL: ${name}`, error); process.exitCode = 1; }
  finally { h.dispose(); }
}

// Deep search by aria-label through the stubbed element tree.
function findByAria(root, label) {
  const stack = [root];
  while (stack.length) {
    const node = stack.shift();
    if (node?.attributes?.['aria-label'] === label) return node;
    stack.push(...(node?.children || []));
  }
  assert.ok(false, `Missing element with aria-label: ${label}`);
}

await check('animation edits round-trip actual Undo/Redo without pre-mutating model', h => {
  const initial = h.allLayers()[0];
  // Forma canônica: main aplica validateLayers no set, então before/after
  // precisam comparar o mesmo shape que o estado real guarda.
  initial.firingOptions = { trigger: 'none', pressType: 'press', releaseBehavior: 'reset', direction: 'normal', easing: 'ease-out', loop: false, startDelay: 0, duration: 300, stages: [] };
  h.setLayers([initial]);
  const undoFailures = [];
  const roundTrip = (edit, expected) => {
    const before = h.allLayers()[0].firingOptions;
    h.endEdit(); // Separate user edits, not the shared 300ms coalescing window.
    edit(); h.flush();
    const after = h.allLayers()[0].firingOptions;
    expected(after);
    assert.notDeepEqual(after, before);
    h.get('undoBtn').fire('click'); h.flush();
    try { assert.deepEqual(h.allLayers()[0].firingOptions, before, 'Undo restores entire animation'); }
    catch { undoFailures.push(after); }
    h.get('redoBtn').fire('click'); h.flush();
    assert.deepEqual(h.allLayers()[0].firingOptions, after, 'Redo restores entire edit');
  };
  const control = label => findByAria(h.get('animPanel'), label);
  const change = (label, value) => { const el = control(label); el.value = value; el.fire('change'); };
  roundTrip(() => h.get('stageAdd').fire('click'), fo => assert.equal(fo.stages.length, 1));
  roundTrip(() => change('Atraso estágio 1 (s)', '0.42'), fo => assert.equal(fo.stages[0].delay, 420));
  roundTrip(() => change('Duração estágio 1 (s)', '0.77'), fo => assert.equal(fo.stages[0].duration, 770));
  roundTrip(() => change('Suavizacao estágio 1', 'linear'), fo => assert.equal(fo.stages[0].easing, 'linear'));
  roundTrip(() => control('Adicionar efeito estágio 1').fire('click'), fo => assert.equal(fo.stages[0].effects.length, 1));
  roundTrip(() => change('Propriedade efeito 1.1', 'x'), fo => assert.equal(fo.stages[0].effects[0].property, 'x'));
  roundTrip(() => change('Valor efeito 1.1', '23'), fo => assert.equal(fo.stages[0].effects[0].to, 23));
  roundTrip(() => control('Remover efeito 1.1').fire('click'), fo => assert.equal(fo.stages[0].effects.length, 0));
  roundTrip(() => control('Remover estágio 1').fire('click'), fo => assert.equal(fo.stages.length, 0));
  assert.equal(undoFailures.length, 0, `${undoFailures.length}/9 edits failed Undo`);
});

await check('header draft survives same-layer broadcast; selection/profile changes discard it', h => {
  const input = h.get('layerTitleSide');
  const begin = () => input.fire('dblclick', { stopPropagation() {} });
  const enter = () => input.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  begin(); input.value = 'Nome ainda digitando'; h.setLayers(h.allLayers());
  assert.equal(input.value, 'Nome ainda digitando'); assert.equal(input.readOnly, false);
  enter(); h.flush(); assert.equal(h.allLayers()[0].name, 'Nome ainda digitando');
  const other = h.newLayer(); other.id = 'other'; other.name = 'Outra';
  h.setLayers([...h.allLayers(), other]);
  begin(); input.value = 'Não transferir';
  h.get('layers').children[0].fire('click'); enter(); h.flush();
  assert.equal(input.value, 'Outra'); assert.equal(input.readOnly, true);
  assert.equal(h.allLayers()[0].name, 'Nome ainda digitando');
  begin(); input.value = 'Não transferir perfil';
  h.setProfile('B', [{ ...other, name: 'Mesmo ID, outro perfil' }]); enter();
  assert.equal(input.readOnly, true); assert.equal(input.value, 'Mesmo ID, outro perfil');
  begin(); input.value = 'Camada removida'; h.setLayers([]); enter();
  assert.equal(input.readOnly, true); assert.equal(input.value, '');
});

for (const pressType of ['press', 'hold']) for (const releaseBehavior of ['reset', 'pause', 'reverse', undefined]) {
  await check(`preview ${pressType}/${releaseBehavior ?? 'legacy'} release and restart`, h => {
    const l = h.allLayers()[0];
    l.firingOptions = { trigger: 'left', pressType, duration: 1000, ...(releaseBehavior ? { releaseBehavior } : {}) };
    h.setLayers([l]); h.setMode('animar'); h.get('previewFire').fire('click');
    const node = h.get('layer-layer-A'), animation = node.animations.at(-1);
    animation.currentTime = 200; h.get('previewFire').fire('click');
    const behavior = releaseBehavior ?? (pressType === 'hold' ? 'reset' : null);
    assert.equal(animation.playState, behavior === 'reset' ? 'idle' : behavior === 'pause' ? 'paused' : 'running');
    assert.equal(animation.playbackRate, behavior === 'reverse' ? -1 : 1);
    h.get('previewFire').fire('click');
    const resumes = pressType === 'hold' && ['pause', 'reverse'].includes(behavior);
    assert.equal(node.animations.length, resumes ? 1 : 2);
    assert.equal(node.animations.at(-1).playbackRate, 1);
    assert.equal(node.animations.at(-1).currentTime, resumes ? 200 : 0);
  });
}

await check('preview clamps pulse scale and preserves inherited endpoints/zero opacity', h => {
  const l = h.allLayers()[0]; l.opacity = 0;
  l.firingOptions = { trigger: 'left', duration: 100, stages: [
    { duration: 100, effects: [{ property: 'scale', to: 8 }, { property: 'x', to: 10 }] },
    { duration: 100, effects: [] }, { duration: 100, effects: [{ property: 'y', to: 20 }] },
  ] };
  h.setLayers([l]); h.setMode('animar'); h.get('previewFire').fire('click');
  const frames = h.get('layer-layer-A').animations.at(-1).keyframes;
  assert.ok(frames.every(f => Number(f.transform.match(/scale\(([^)]+)\)/)[1]) <= 8));
  assert.ok(frames.every(f => f.opacity === 0));
  assert.equal(frames.at(-1).transform, 'translate(10px, -20px) rotate(0deg) scale(8)');
});

await check('keyboard focus CSS contract and easing accessible name', () => {
  for (const selector of ['input:focus-visible', 'select:focus-visible', 'textarea:focus-visible']) {
    assert.ok(html.includes(selector), `missing ${selector}`);
  }
  assert.match(html, /<label[^>]+for="apEase"[^>]*>Suavização<\/label>/);
});

await check('preview cancels on pagehide/reduced motion; typing never fires shortcuts', h => {
  const l = h.allLayers()[0]; l.firingOptions = { trigger: 'left', duration: 1000 };
  h.setLayers([l]); h.setMode('animar');
  for (const tag of ['input', 'textarea', 'select']) for (const key of ['1', '2', '3', '4']) {
    const target = h.createElement(tag); target.type = 'number';
    h.documentEvent('keydown', { target, key, preventDefault() { assert.fail('typing intercepted'); } });
  }
  h.get('previewFire').fire('click'); const first = h.get('layer-layer-A').animations.at(-1);
  h.windowEvent('pagehide'); assert.equal(first.playState, 'idle');
  h.get('previewFire').fire('click'); const next = h.get('layer-layer-A').animations.at(-1);
  h.reducedMotion(true); assert.equal(next.playState, 'idle');
  const count = h.get('layer-layer-A').animations.length;
  h.get('previewFire').fire('click'); assert.equal(h.get('layer-layer-A').animations.length, count);
  assert.equal(h.get('previewFire').attributes['aria-pressed'], 'false');
});

await check('zoom finalizes before reentrant blur/removal', h => {
  h.get('zoomBadge').fire('dblclick');
  const input = h.get('main').children.at(-1);
  input.value = '3';
  input.fire('keydown', { key: 'Enter', preventDefault() {} });
  input.fire('blur');
  assert.equal(input.removes, 1);
  assert.equal(h.get('zoomRange').value, 3);
  h.get('zoomBadge').fire('dblclick');
  const cancel = h.get('main').children.at(-1);
  cancel.value = '8';
  cancel.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(cancel.removes, 1);
  assert.equal(h.get('zoomRange').value, 1);
});

await check('drawer rename retains input across click; Enter/blur commit once, Escape cancels', h => {
  const row = h.get('layers').children[0];
  const input = row.children[1];
  assert.equal(input.readOnly, true);
  row.fire('click', { target: input });
  assert.equal(h.get('layers').children[0], row, 'click on selected input must not rebuild drawer');
  input.fire('dblclick', { stopPropagation() {} });
  assert.equal(input.readOnly, false);
  input.value = 'Nova mira';
  const before = h.patches.length;
  input.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  input.fire('blur');
  assert.equal(h.patches.length, before + 1);
  assert.equal(h.lastLayer().name, 'Nova mira');
  const nextRow = h.get('layers').children[0];
  const next = nextRow.children[1];
  nextRow.fire('keydown', { key: 'F2', preventDefault() {} }); next.value = 'Pelo teclado';
  next.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.lastLayer().name, 'Pelo teclado');
  const cancel = h.get('layers').children[0].children[1];
  cancel.fire('dblclick', { stopPropagation() {} }); cancel.value = 'Descartar';
  cancel.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} }); cancel.fire('blur');
  assert.equal(h.lastLayer().name, 'Pelo teclado');
});

await check('drawer DnD and Alt+Arrow reorder persist and undo', h => {
  const b = h.newLayer(); b.id = 'b'; const c = h.newLayer(); c.id = 'c';
  h.setLayers([h.allLayers()[0], b, c]);
  const rows = h.get('layers').children;
  const data = new Map();
  const dataTransfer = { setData: (k, v) => data.set(k, v), getData: k => data.get(k) || '' };
  rows[0].fire('dragstart', { target: rows[0], dataTransfer });
  rows[2].fire('drop', { preventDefault() {}, dataTransfer });
  assert.deepEqual(h.allLayers().map(l => l.id), ['c', 'layer-A', 'b']);
  h.get('undoBtn').fire('click');
  assert.deepEqual(h.allLayers().map(l => l.id), ['layer-A', 'b', 'c']);
  const row = h.get('layers').children[0];
  row.focus();
  row.fire('keydown', { key: 'ArrowDown', altKey: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(h.allLayers().map(l => l.id), ['layer-A', 'c', 'b']);
  assert.equal(h.document.activeElement, h.get('layers').children.find(row => row.dataset.id === 'c'), 'modelled focus follows reordered row; no visual claim');
});

await check('seconds convert to milliseconds; invalid timing preserves data', h => {
  assert.equal(h.get('apDur').value, '0.30');
  h.get('apDelay').value = '1.25'; h.get('apDelay').fire('change');
  assert.equal(h.lastLayer().firingOptions.startDelay, 1250);
  h.get('apDur').value = '0.75'; h.get('apDur').fire('change');
  assert.equal(h.lastLayer().firingOptions.duration, 750);
  h.get('apDur').value = ''; h.get('apDur').fire('change');
  assert.equal(h.lastLayer().firingOptions.duration, 750);
  assert.equal(h.get('apDur').value, '0.75');
  h.get('stageAdd').fire('click');
  const delay = findByAria(h.get('animPanel'), 'Atraso estágio 1 (s)');
  assert.equal(delay.value, '0.00');
  delay.value = '0.42'; delay.fire('change');
  assert.equal(h.lastLayer().firingOptions.stages[0].delay, 420);
  assert.equal(h.get('apFx').textContent, 'Sem efeitos');
});

await check('FCB preview triggers animate locally; reload only resets pause timelines', h => {
  const left = h.allLayers()[0]; left.firingOptions = { trigger: 'left', pressType: 'hold', releaseBehavior: 'pause', duration: 300, stages: [{ duration: 200, effects: [{ property: 'x', to: 10 }] }] };
  const right = h.newLayer(); right.id = 'right'; right.firingOptions = { trigger: 'right', pressType: 'hold', releaseBehavior: 'reset', duration: 400 };
  const auto = h.newLayer(); auto.id = 'auto'; auto.firingOptions = { trigger: 'autoplay', duration: 500 };
  h.setLayers([left, right, auto]); h.setMode('animar');
  const writes = h.patches.length;
  h.get('previewFire').fire('click');
  const animation = h.get('layer-layer-A').animations.at(-1);
  assert.equal(animation.options.duration, 500);
  assert.ok(animation.keyframes.at(-1).transform.includes('translate(10px'));
  h.get('previewFire').fire('click'); assert.equal(animation.playState, 'paused');
  animation.currentTime = 200;
  h.get('previewAim').fire('click');
  const aim = h.get('layer-right').animations.at(-1); aim.currentTime = 120;
  h.get('previewReload').fire('click');
  assert.equal(animation.currentTime, 0); assert.equal(aim.currentTime, 120);
  h.documentEvent('keydown', { key: '1', preventDefault() {} });
  assert.equal(h.get('layer-auto').animations.length, 1);
  h.get('previewAim').fire('click'); assert.equal(aim.playState, 'idle');
  assert.equal(h.patches.length, writes, 'preview never persists');
  h.setMode('design'); assert.equal(animation.playState, 'idle');
  assert.equal(h.get('previewFire').attributes['aria-pressed'], 'false');
});

await check('opacity percentage input and bounds', h => {
  // Opacity moved to the color row next to each Cor field (matches original).
  const input = findByAria(h.get('bodyLinhas'), 'Opacidade');
  assert.ok(input, 'Missing field: Opacidade');
  assert.equal(Number(String(input.value).replace('%', '')), 100);
  for (const [typed, expected] of [[50, 0.5], [100, 1], [5, 0.05], [0, 0.05], [150, 1]]) {
    input.value = `${typed}%`;
    input.fire('change');
    h.flush();
    assert.equal(h.lastLayer().opacity, expected, `typed ${typed}%`);
    assert.equal(Number(String(input.value).replace('%', '')), Math.round(expected * 100));
  }
});

await check('numeric scrub persists final value; Undo/Redo restore both ends', h => {
  const field = h.xField();
  field.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  field.fire('pointermove', { clientX: 40 });
  assert.equal(h.lastLayer().x, 40, 'live scrub preview persisted');
  h.flush();
  field.fire('pointerup');
  h.flush();
  assert.equal(h.lastLayer().x, 40, 'release keeps final value');
  assert.equal(h.get('undoBtn').disabled, false);
  h.get('undoBtn').fire('click');
  h.flush();
  assert.equal(h.lastLayer().x, 0, 'Undo restores pre-scrub value');
  h.get('redoBtn').fire('click');
  h.flush();
  assert.equal(h.lastLayer().x, 40, 'Redo restores scrub result');
});

await check('profile switch clears Undo and selection, including pending echo', h => {
  h.get('btnDel').fire('click');
  assert.equal(h.patches.at(-1).layers.length, 0);
  assert.equal(h.get('undoBtn').disabled, false);
  // No echo yet: profile-change handling must precede suppressBroadcast guard.
  h.switchProfile();
  assert.equal(h.get('layers').children.length, 1, 'new document accepted despite pending echo');
  assert.equal(h.get('layers').children[0].dataset.id, 'layer-B');
  assert.ok(h.get('layers').children[0].classList.contains('sel'), 'selection belongs to B');
  assert.equal(h.get('undoBtn').disabled, true);
  assert.equal(h.get('redoBtn').disabled, true);
  const writes = h.patches.length;
  h.get('undoBtn').fire('click');
  assert.equal(h.patches.length, writes, 'Undo cannot insert deleted A layer into B');
});

await check('save uses same favorites key and format as library', h => {
  h.get('docName').value = 'Minha mira';
  h.get('btnSave').fire('click');
  const saved = JSON.parse(h.storage.get('cq.savedCustomCrosshairs'));
  assert.equal(saved[0].name, 'Minha mira');
  assert.equal(saved[0].layers[0].id, 'layer-A');
  assert.ok(saved[0].id && saved[0].drawing && saved[0].model);
  assert.equal(h.storage.has('crosshairq.favorites'), false);
});

await check('resize handle keeps final size after release and supports Undo/Redo', h => {
  const handle = element(); handle.classList.add('h'); handle.classList.add('se');
  h.get('selBox').fire('pointerdown', { target: handle, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  h.documentEvent('pointermove', { clientX: 24, clientY: 0 });
  const finalScale = h.lastLayer().scale;
  assert.ok(finalScale > 1, 'handle enlarges layer');
  h.flush();
  h.documentEvent('pointerup'); h.flush();
  assert.equal(h.lastLayer().scale, finalScale, 'release keeps resize result');
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.lastLayer().scale, 1, 'undo restores original size');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.lastLayer().scale, finalScale, 'redo restores resized layer');
});

await check('empty profile replaces previous document without retaining layers', h => {
  h.switchProfile(true);
  assert.equal(h.get('layers').children.length, 0, 'empty profile has no old layers');
  assert.equal(h.get('preview').innerHTML, '', 'old drawing removed');
  const writes = h.patches.length;
  h.get('btnDel').fire('click');
  assert.equal(h.patches.length, writes, 'no stale selection can modify profile');
});

await check('wheel zoom preserves world point under cursor on both axes', h => {
  const preview = h.get('preview');
  const screenPoint = { x: 280, y: 260 };
  const worldPoint = () => {
    const size = Number.parseFloat(preview.style.width);
    const [panX, panY] = preview.style.transform.match(/translate3d\(([^p]+)px, ([^p]+)px/).slice(1).map(Number);
    const zoom = size / 60;
    return { x: (screenPoint.x - 200 - panX) / zoom, y: (200 + panY - screenPoint.y) / zoom };
  };
  const before = worldPoint();
  for (const deltaY of [-100, -100, 100]) {
    h.get('stageWrap').fire('wheel', { clientX: screenPoint.x, clientY: screenPoint.y, deltaY, preventDefault() {} });
    const after = worldPoint();
    assert.ok(Math.abs(before.x - after.x) < 1e-8, 'horizontal cursor anchor');
    assert.ok(Math.abs(before.y - after.y) < 1e-8, 'vertical cursor anchor');
  }
});

await check('profile switch also clears Redo history', h => {
  h.get('btnDel').fire('click');
  h.flush();
  h.get('undoBtn').fire('click');
  h.flush();
  assert.equal(h.canRedo(), true, 'Redo action exists before switching');
  h.switchProfile();
  assert.equal(h.get('redoBtn').disabled, true);
  const writes = h.patches.length;
  h.get('redoBtn').fire('click');
  assert.equal(h.patches.length, writes, 'Redo cannot replay A action in B');
});

await check('stageAdd creates stage; override UI persists and validates', h => {
  h.get('stageAdd').fire('click');
  h.flush();
  assert.equal(h.lastLayer().firingOptions.stages.length, 1, 'stageAdd creates one stage');
  assert.deepEqual(h.lastLayer().firingOptions.stages[0], { delay: 0, duration: 300, easing: 'ease-out', effects: [] });
  const panel = h.get('animPanel');
  const host = () => panel.children[0];
  assert.ok(host().children.some((c) => c.textContent === 'Sem efeitos'), 'empty stage shows Sem efeitos');
  findByAria(panel, 'Adicionar efeito estágio 1').fire('click');
  h.flush();
  assert.deepEqual(h.lastLayer().firingOptions.stages[0].effects, [{ property: 'scale', to: 1 }], 'default override persisted');
  const sel = findByAria(panel, 'Propriedade efeito 1.1');
  sel.value = 'opacity'; sel.fire('change');
  h.flush();
  assert.deepEqual(h.lastLayer().firingOptions.stages[0].effects, [{ property: 'opacity', to: 1 }], 'property change clamps to range and persists');
  const inp = findByAria(panel, 'Valor efeito 1.1');
  assert.equal(inp.min, '0'); assert.equal(inp.max, '1', 'value input follows property limits');
  inp.value = '0.5'; inp.fire('change');
  h.flush();
  assert.deepEqual(h.lastLayer().firingOptions.stages[0].effects, [{ property: 'opacity', to: 0.5 }], 'typed value persists');
  const valid = structuredClone(h.validate(h.lastLayer()));
  assert.deepEqual(valid.firingOptions.stages[0].effects, [{ property: 'opacity', to: 0.5 }], 'validated layer keeps the override');
  assert.equal(h.get('apFx').textContent, 'Efeitos configurados', 'footer never claims configured overrides are absent');
  findByAria(panel, 'Remover efeito 1.1').fire('click');
  h.flush();
  assert.deepEqual(h.lastLayer().firingOptions.stages[0].effects, [], 'remove clears overrides');
  assert.ok(host().children.some((c) => c.textContent === 'Sem efeitos'), 'stage shows Sem efeitos again');
});

await check('layer validation enforces stage effect contract', h => {
  const mk = effects => { const l = h.newLayer(); l.firingOptions = { trigger: 'left', stages: [{ delay: 0, duration: 300, easing: 'linear', effects }] }; return l; };
  // structuredClone moves the vm-realm result into the host realm for deepEqual (strict assert).
  const out = effects => structuredClone(h.validate(mk(effects)).firingOptions.stages[0].effects);
  assert.deepEqual(out([]), [], 'empty effects valid');
  assert.deepEqual(
    out([{ property: 'x', to: -200 }, { property: 'y', to: 200 }, { property: 'rotation', to: 360 }, { property: 'opacity', to: 1 }, { property: 'scale', to: 0.05 }]),
    [{ property: 'x', to: -200 }, { property: 'y', to: 200 }, { property: 'rotation', to: 360 }, { property: 'opacity', to: 1 }, { property: 'scale', to: 0.05 }],
    'boundary values valid');
  assert.deepEqual(out([{ property: 'x', to: -199.5 }]), [{ property: 'x', to: -199.5 }], 'in-range fractional to valid');
  assert.throws(() => h.validate(mk([{ property: 'hue', to: 1 }])), 'allowlist enforced');
  assert.throws(() => h.validate(mk([{ to: 1 }])), 'property required');
  assert.throws(() => h.validate(mk([{ property: 'scale', to: 99 }])), 'scale upper bound');
  assert.throws(() => h.validate(mk([{ property: 'opacity', to: -0.1 }])), 'opacity lower bound');
  assert.throws(() => h.validate(mk([{ property: 'x', to: NaN }])), 'to must be finite');
  assert.throws(() => h.validate(mk(Array.from({ length: 9 }, () => ({ property: 'x', to: 0 })))), 'max 8 effects per stage');
});

await check('props sync preserves input focus and activeElement during broadcast', h => {
  const xBox = h.xField();
  const input = xBox.querySelector('input');
  input.focus();
  assert.equal(h.document.activeElement, input, 'input has focus');
  assert.equal(input.removes || 0, 0, 'input not removed');
  const current = h.allLayers();
  current[0].y = 15;
  h.setLayers(current);
  assert.equal(h.document.activeElement, input, 'input retains focus across same-layer broadcast');
  assert.equal(input.removes || 0, 0, 'input was never removed or recreated');
});

await check('FIFO scrub echoes before release keep final renderer write and value', h => {
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 10 });
  xBox.fire('pointermove', { clientX: 30 });
  h.flush(); // x=10 then x=30, both before pointerup
  const before = h.patches.length;
  xBox.fire('pointerup');
  assert.equal(h.patches.length, before + 1);
  assert.equal(h.patches.at(-1).layers[0].x, 30, 'next renderer write must not revert to 10');
  assert.equal(+xBox.querySelector('input').value, 30);
  h.flush();
  assert.equal(h.allLayers()[0].x, 30);
});

await check('FIFO move/resize echoes before release retain final values', h => {
  const target = { closest: () => ({ id: 'layer-layer-A' }) };
  const stage = h.get('stage');
  stage.fire('pointerdown', { button: 0, target, clientX: 200, clientY: 200, pointerId: 1 });
  h.documentEvent('pointermove', { clientX: 700, clientY: 200 });
  h.documentEvent('pointermove', { clientX: 1700, clientY: 200 });
  const finalX = h.lastLayer().x;
  assert.notEqual(finalX, 0);
  h.flush();
  const beforeMove = h.patches.length;
  h.documentEvent('pointerup');
  assert.ok(h.patches.length > beforeMove);
  assert.equal(h.patches.at(-1).layers[0].x, finalX, 'move next write retains final x');
  assert.equal(+h.xField().querySelector('input').value, finalX, 'field X reflects finalX in renderer before flush');
  h.flush();
  assert.equal(+h.xField().querySelector('input').value, finalX, 'field X retains finalX in renderer after flush');
  assert.equal(h.allLayers()[0].x, finalX);

  // Próxima ação partindo do documento interno: Undo restaura estado pré-move no renderer e modelo
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(+h.xField().querySelector('input').value, 0, 'undo restores pre-move field X');
  assert.equal(h.allLayers()[0].x, 0, 'undo restores pre-move model x');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(+h.xField().querySelector('input').value, finalX, 'redo reapplies move field X');
  assert.equal(h.allLayers()[0].x, finalX);

  const handle = element(); handle.classList.add('h'); handle.classList.add('se');
  h.get('selBox').fire('pointerdown', { target: handle, clientX: 0, clientY: 0, pointerId: 2, preventDefault() {}, stopPropagation() {} });
  h.documentEvent('pointermove', { clientX: 12, clientY: 0 });
  h.documentEvent('pointermove', { clientX: 24, clientY: 0 });
  const finalScale = h.lastLayer().scale;
  h.flush();
  const beforeResize = h.patches.length;
  h.documentEvent('pointerup');
  assert.ok(h.patches.length > beforeResize);
  assert.equal(h.patches.at(-1).layers[0].scale, finalScale, 'resize next write retains final scale');
  assert.equal(+h.field('Escala').value, finalScale, 'field Escala reflects finalScale in renderer before flush');
  h.flush();
  assert.equal(+h.field('Escala').value, finalScale, 'field Escala retains finalScale in renderer after flush');
  assert.equal(h.allLayers()[0].scale, finalScale);

  // Próxima ação partindo do documento interno: Undo restaura escala prévia no renderer e modelo
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(+h.field('Escala').value, 1, 'undo restores initial scale in field Escala');
  assert.equal(h.allLayers()[0].scale, 1, 'undo restores initial model scale');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(+h.field('Escala').value, finalScale, 'redo reapplies finalScale in field Escala');
  assert.equal(h.allLayers()[0].scale, finalScale, 'redo reapplies finalScale in model');

  // Gesto de arrasto finalizado por pointercancel de forma idempotente sem segundo commit
  stage.fire('pointerdown', { button: 0, target, clientX: 200, clientY: 200, pointerId: 3 });
  h.documentEvent('pointermove', { clientX: 800, clientY: 200 });
  const cancelX = h.lastLayer().x;
  assert.equal(h.document.body.classList.contains('dragging'), true);
  h.documentEvent('pointercancel');
  assert.equal(h.document.body.classList.contains('dragging'), false, 'pointercancel releases dragging class');
  const writesAfterCancel = h.patches.length;
  h.documentEvent('pointerup'); // redundância: evento subsequente não produz segundo commit
  h.documentEvent('pointercancel');
  assert.equal(h.patches.length, writesAfterCancel, 'redundant pointerup/pointercancel must not create second commit');
  assert.equal(+h.xField().querySelector('input').value, cancelX, 'field X holds pointercancel value in renderer before flush');
  h.flush();
  assert.equal(+h.xField().querySelector('input').value, cancelX, 'field X holds pointercancel value in renderer after flush');
  assert.equal(h.allLayers()[0].x, cancelX);
  h.get('undoBtn').fire('click');
  h.flush();
  assert.equal(+h.xField().querySelector('input').value, finalX, 'undo reverts pointercancel commit cleanly');
  assert.equal(h.allLayers()[0].x, finalX);
});

await check('scrub echoes reconcile by document equality; renderer keeps final value', h => {
  const xBox = h.xField();
  const input = xBox.querySelector('input');
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 10 });
  xBox.fire('pointermove', { clientX: 30 });
  xBox.fire('pointerup');
  h.flush(); // ecos próprios em ordem FIFO, inclusive o intermediário
  assert.equal(input.value, 30, 'renderer field converges to final scrub value');
  assert.equal(h.allLayers()[0].x, 30);
  // A próxima escrita do renderer parte do documento reconciliado.
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'Undo restores pre-scrub value from reconciled doc');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 30, 'Redo restores scrub result');
});

await check('undo/redo buttons reflect stack depth right after the click (no echo needed)', h => {
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 30 });
  xBox.fire('pointerup');
  h.flush();
  assert.equal(h.get('undoBtn').disabled, false, 'scrub enables Undo');
  h.get('undoBtn').fire('click'); h.flush();
  // Eco do undo é no-op por igualdade; o botão precisa habilitar sozinho.
  assert.equal(h.get('undoBtn').disabled, true, 'Undo disabled after consuming the stack');
  assert.equal(h.get('redoBtn').disabled, false, 'Redo enabled immediately after Undo');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.get('redoBtn').disabled, true, 'Redo disabled after consuming the stack');
  assert.equal(h.get('undoBtn').disabled, false, 'Undo re-enabled immediately after Redo');
  assert.equal(h.allLayers()[0].x, 30, 'document round-trips');
});

await check('external edit during gesture defers to gesture end; own echo is a no-op', h => {
  const xBox = h.xField();
  const input = xBox.querySelector('input');
  const yInput = h.yField().querySelector('input');
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 25 });
  h.flush(); // eco próprio: igual ao documento do renderer -> no-op
  assert.equal(input.removes || 0, 0, 'echo no-op never rebuilds the field');
  const ext = structuredClone(h.allLayers());
  ext[0].y = 77; ext[0].x = 25;
  h.setLayers(ext); // documento externo no meio do gesto
  assert.equal(+yInput.value, 0, 'external deferred while gesture is active');
  xBox.fire('pointerup'); // fim do gesto: externa aplicada, depois o scrub grava por cima
  assert.equal(+yInput.value, 77, 'external applied at gesture end');
  assert.equal(h.allLayers()[0].x, 25, 'scrub commit preserved');
  assert.equal(h.allLayers()[0].y, 77, 'scrub commit keeps the external edit');
  h.flush();
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'Undo restores pre-scrub x');
  assert.equal(h.allLayers()[0].y, 77, 'Undo does not revert the external edit');
});

await check('delayed own echo is applied, then the final echo reconverges', h => {
  const xBox = h.xField();
  const input = xBox.querySelector('input');
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 10 });
  xBox.fire('pointermove', { clientX: 30 });
  xBox.fire('pointerup');
  h.flush(); // documento final (x=30) em tela e no main
  // Main já está no documento final; um eco atrasado do move intermediário chega:
  const delayed = structuredClone(h.allLayers());
  delayed[0].x = 10;
  h.deliver({ profiles: { currentProfileId: 'A' }, layers: delayed });
  assert.equal(+input.value, 10, 'delayed echo is applied, never silently swallowed');
  const finalEcho = structuredClone(h.allLayers()); // main segue no documento final
  h.deliver({ profiles: { currentProfileId: 'A' }, layers: finalEcho });
  assert.equal(+input.value, 30, 'final echo reconverges the document');
  assert.equal(h.allLayers()[0].x, 30);
});

await check('external broadcast is never swallowed by pending write state (rejection case)', h => {
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 15 });
  xBox.fire('pointerup');
  // Nenhum eco entregue — como se o main tivesse rejeitado ou perdido o set.
  const ext = structuredClone(h.allLayers());
  ext[0].y = 55; ext[0].x = 15;
  h.setLayers(ext); // externo chega mesmo assim
  assert.equal(+h.yField().querySelector('input').value, 55, 'externo aplicado sem eco prévio');
  assert.equal(h.allLayers()[0].y, 55);
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'gesto sem eco ainda produz Undo válido');
  assert.equal(h.allLayers()[0].y, 55);
});

await check('scrub is bound to its origin layer; mid-gesture selection switch cannot steal Undo', h => {
  const b = h.newLayer(); b.id = 'b'; b.x = 100;
  h.setLayers([...h.allLayers(), b]);
  const rowA = h.get('layers').children.find(r => r.dataset.id === 'layer-A');
  rowA.fire('click'); // seleciona A
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 40 }); // A.x: 0 -> 40
  const rowB = h.get('layers').children.find(r => r.dataset.id === 'b');
  rowB.fire('click'); // troca de seleção no meio do gesto
  xBox.fire('pointerup'); // pointerup no campo capturado
  h.flush();
  const doc = h.allLayers();
  assert.equal(doc.find(l => l.id === 'layer-A').x, 40, 'scrub applies to its origin layer');
  assert.equal(doc.find(l => l.id === 'b').x, 100, 'selection switch cannot become a false Undo target');
  h.get('undoBtn').fire('click'); h.flush();
  const undone = h.allLayers();
  assert.equal(undone.find(l => l.id === 'layer-A').x, 0, 'Undo restores the origin layer');
  assert.equal(undone.find(l => l.id === 'b').x, 100, 'B untouched by Undo');
});

await check('scrub window listeners are per-gesture; blur, lostpointercapture and pointercancel finalize idempotently', h => {
  const before = h.windowListeners('pointerup');
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 20 });
  assert.equal(h.windowListeners('pointerup'), before + 1, 'gesture adds its own window listener');
  h.windowEvent('blur'); // janela perde foco no meio do gesto
  assert.equal(h.windowListeners('pointerup'), before, 'gesture end removes its window listeners');
  assert.equal(+xBox.querySelector('input').value, 20, 'blur finalizes with current value');
  const writes = h.patches.length;
  xBox.fire('pointerup'); // idempotente: segundo finalizador não grava de novo
  assert.equal(h.patches.length, writes, 'repeated finalization writes nothing');
  h.flush();
  assert.equal(h.allLayers()[0].x, 20);
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'blur-finalized gesture still creates one Undo entry');
  // lostpointercapture no label (fl) também finaliza:
  const row = h.get('bodyLayer').children.find(child => child.children[0]?.textContent === 'Escala');
  const label = row.children[0];
  label.fire('pointerdown', { currentTarget: label, clientX: 0, pointerId: 2, preventDefault() {} });
  label.fire('pointermove', { clientX: 40 });
  label.fire('lostpointercapture');
  const labelWrites = h.patches.length;
  label.fire('pointerup');
  assert.equal(h.patches.length, labelWrites, 'lostpointercapture already finalized the gesture');
  h.flush();
  assert.equal(h.allLayers()[0].scale, 2, 'label capture finalizes with the scrubbed value');

  // pointercancel na janela também finaliza o scrub de forma idempotente sem segundo commit
  xBox.fire('pointerdown', { clientX: 0, pointerId: 3, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 15 });
  assert.equal(h.windowListeners('pointerup'), before + 1, 'scrub adds window listener');
  h.windowEvent('pointercancel');
  assert.equal(h.windowListeners('pointerup'), before, 'pointercancel removes window listeners');
  assert.equal(+xBox.querySelector('input').value, 15, 'pointercancel finalizes with current value');
  const writesAfterCancel = h.patches.length;
  xBox.fire('pointerup'); // redundância: pointerup não duplica escrita
  assert.equal(h.patches.length, writesAfterCancel, 'repeated pointerup after pointercancel writes nothing');
  h.flush();
  assert.equal(h.allLayers()[0].x, 15);
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'undo restores pre-pointercancel value');
});

await check('profile switch mid-gesture cancels the scrub without false Undo', h => {
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 30 });
  h.switchProfile(); // perfil B no meio do gesto
  const writes = h.patches.length;
  xBox.fire('pointerup');
  assert.equal(h.patches.length, writes, 'cancelled gesture writes nothing to the new profile');
  assert.equal(h.get('undoBtn').disabled, true, 'no Undo entry leaked across profiles');
  const doc = h.allLayers();
  assert.equal(doc[0].id, 'layer-B');
  assert.equal(doc[0].x, 0);
});

await check('focused select mirrors Undo/Redo; only real text draft survives broadcast', h => {
  const sel = findByAria(h.get('bodyLinhas'), 'Estilo');
  sel.focus();
  assert.equal(h.document.activeElement, sel);
  sel.value = 'triangle'; sel.fire('change');
  h.flush();
  assert.equal(h.allLayers()[0].armShape, 'triangle');
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].armShape, 'rect', 'Undo restores the document');
  assert.equal(sel.value, 'rect', 'focused select mirrors the document after Undo');
  assert.equal(h.document.activeElement, sel, 'sync never steals focus');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(sel.value, 'triangle');
  // Rascunho de num realmente pendente preserva; blur sincroniza:
  const input = h.xField().querySelector('input');
  input.focus();
  input.value = '55'; // digitando, sem change
  const ext = structuredClone(h.allLayers());
  ext[0].x = 77;
  h.setLayers(ext);
  assert.equal(input.value, '55', 'typing draft survives external broadcast');
  input.blur();
  assert.equal(+input.value, 77, 'blur resyncs the field to the document');
  assert.equal(h.allLayers()[0].x, 77);
});


await check('numeric scrub with fractional step eliminates decimal floating-point noise', h => {
  const scaleRow = h.get('bodyLayer').children.find(child => child.children[0]?.textContent === 'Escala');
  const scaleBox = scaleRow.children[1];
  scaleBox.fire('pointerdown', { clientX: 0, pointerId: 1, preventDefault() {} });
  for (let dx = 1; dx <= 25; dx += 3) {
    scaleBox.fire('pointermove', { clientX: dx });
    const currentScale = h.lastLayer().scale;
    assert.equal(typeof currentScale, 'number');
    const str = String(currentScale);
    assert.doesNotMatch(str, /0000000\d/, 'scale ' + str + ' must not have floating point noise');
    assert.doesNotMatch(str, /9999999\d/, 'scale ' + str + ' must not have floating point noise');
    const decimals = (str.split('.')[1] || '').length;
    assert.ok(decimals <= 4, 'scale ' + str + ' must have at most 4 decimal places');
  }
  scaleBox.fire('pointerup');
});

await check('rapid consecutive gestures without sleep/endEdit record discrete undo steps (two layers, move+resize, scrub+cancel)', h => {
  const l1 = { id: 'layer-A', name: 'M1', type: 'model', x: 0, y: 0, scale: 1, armLength: 10, armThickness: 2, armSpacing: 5, armRotation: 0 };
  const l2 = { id: 'layer-B', name: 'S1', type: 'shape', shapeType: 'rect', x: 20, y: 30, w: 50, h: 50, scale: 1 };
  h.setLayers([l1, l2]);

  // Gesto 1: move Layer A (x=0 -> x=10)
  const targetA = { closest: () => ({ id: 'layer-layer-A' }) };
  const stage = h.get('stage');
  stage.fire('pointerdown', { button: 0, target: targetA, clientX: 200, clientY: 200, pointerId: 1 });
  h.documentEvent('pointermove', { clientX: 700, clientY: 200 });
  const finalX = h.allLayers()[0].x;
  assert.equal(finalX, 10);
  h.flush();
  const writesBeforeRelease1 = h.patches.length;
  h.documentEvent('pointerup');
  assert.ok(h.patches.length > writesBeforeRelease1, 'move commits on pointerup');
  assert.equal(h.patches.at(-1).layers[0].x, 10, 'next renderer write retains moved x');
  assert.equal(+h.xField().querySelector('input').value, 10, 'field X reflects moved x');
  h.flush();

  // Gesto 2 síncrono (<300ms, sem sleep/h.endEdit): resize Layer A (scale=1 -> finalScale)
  const handle = element(); handle.classList.add('h'); handle.classList.add('se');
  h.get('selBox').fire('pointerdown', { target: handle, clientX: 0, clientY: 0, pointerId: 2, preventDefault() {}, stopPropagation() {} });
  h.documentEvent('pointermove', { clientX: 24, clientY: 0 });
  const finalScale = h.allLayers()[0].scale;
  assert.ok(finalScale > 1, 'layer resized');
  h.flush();
  const writesBeforeRelease2 = h.patches.length;
  h.documentEvent('pointerup');
  assert.ok(h.patches.length > writesBeforeRelease2, 'resize commits on pointerup');
  assert.equal(h.patches.at(-1).layers[0].scale, finalScale, 'next renderer write retains scale');
  assert.equal(+h.field('Escala').value, finalScale, 'field Escala reflects finalScale');
  assert.equal(+h.xField().querySelector('input').value, 10, 'field X still 10');
  h.flush();

  // Primeiro Undo: reverte o resize (gesto 2). Escala volta para 1, mas X continua 10!
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].scale, 1, 'first undo restores initial scale');
  assert.equal(+h.field('Escala').value, 1, 'field Escala reflects 1');
  assert.equal(h.allLayers()[0].x, 10, 'first undo preserves moved x');
  assert.equal(+h.xField().querySelector('input').value, 10, 'field X reflects 10');

  // Segundo Undo: reverte o move (gesto 1). X volta para 0, escala continua 1!
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 0, 'second undo restores initial x');
  assert.equal(+h.xField().querySelector('input').value, 0, 'field X reflects 0');
  assert.equal(h.allLayers()[0].scale, 1, 'second undo keeps scale 1');
  assert.equal(+h.field('Escala').value, 1, 'field Escala keeps 1');

  // Primeiro Redo: reaplica o move (gesto 1). X volta para 10, escala continua 1!
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 10, 'first redo reapplies move x');
  assert.equal(+h.xField().querySelector('input').value, 10, 'field X reflects 10');
  assert.equal(h.allLayers()[0].scale, 1, 'first redo keeps scale 1');

  // Segundo Redo: reaplica o resize (gesto 2). Escala volta para finalScale, X continua 10!
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].scale, finalScale, 'second redo reapplies resize scale');
  assert.equal(+h.field('Escala').value, finalScale, 'field Escala reflects finalScale');
  assert.equal(h.allLayers()[0].x, 10, 'second redo preserves x 10');

  // Gesto 3 síncrono: scrub numérico em X da Layer A (10 -> 25) finalizado por lostpointercapture com idempotência
  const xBox = h.xField();
  xBox.fire('pointerdown', { currentTarget: xBox, clientX: 0, pointerId: 3, preventDefault() {} });
  xBox.fire('pointermove', { clientX: 15 });
  assert.equal(+xBox.querySelector('input').value, 25);
  xBox.fire('lostpointercapture');
  const writesAfterCapture = h.patches.length;
  xBox.fire('pointerup');
  assert.equal(h.patches.length, writesAfterCapture, 'idempotent lostpointercapture: redundant pointerup produces no extra write');
  h.flush();
  assert.equal(h.allLayers()[0].x, 25, 'layer A x scrubbed to 25');

  // Gesto 4 síncrono (<300ms) na Layer B: arrasto de canvas finalizado por pointercancel com idempotência
  const targetB = { closest: () => ({ id: 'layer-layer-B' }) };
  stage.fire('pointerdown', { button: 0, target: targetB, clientX: 200, clientY: 200, pointerId: 4 });
  h.documentEvent('pointermove', { clientX: 2200, clientY: 200 });
  const layerB = h.allLayers().find(l => l.id === 'layer-B');
  assert.equal(layerB.x, 60, 'layer B dragged to 60');
  h.documentEvent('pointercancel');
  const writesAfterCancel = h.patches.length;
  h.documentEvent('pointerup');
  h.documentEvent('pointercancel');
  assert.equal(h.patches.length, writesAfterCancel, 'idempotent pointercancel: redundant events produce no extra write');
  h.flush();
  assert.equal(h.allLayers().find(l => l.id === 'layer-B').x, 60, 'layer B holds 60 after flush');
  assert.equal(h.allLayers()[0].x, 25, 'layer A retains 25');

  // Undo do gesto 4 (drag cancelado da Layer B)
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers().find(l => l.id === 'layer-B').x, 20, 'undo restores layer B pre-drag x');
  assert.equal(h.allLayers()[0].x, 25, 'layer A still has 25');

  // Undo do gesto 3 (scrub da Layer A)
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].x, 10, 'undo restores layer A pre-scrub x');
  h.get('layers').children.find(c => c.dataset.id === 'layer-A').fire('click'); h.flush();
  assert.equal(+h.xField().querySelector('input').value, 10, 'field X reflects Layer A 10');
  assert.equal(h.allLayers().find(l => l.id === 'layer-B').x, 20, 'layer B still has 20');
});

await check('move and resize commit emits exactly one cq.set on release; empty gestures after Undo retain functional Redo', h => {
  const target = { closest: () => ({ id: 'layer-layer-A' }) };
  const stage = h.get('stage');

  // Move: pointerdown + pointermove, conta apenas cq.set emitido no término (release)
  stage.fire('pointerdown', { button: 0, target, clientX: 200, clientY: 200, pointerId: 1 });
  h.documentEvent('pointermove', { clientX: 700, clientY: 200 });
  const finalX = h.lastLayer().x;
  assert.notEqual(finalX, 0);
  h.flush();
  const writesBeforeMoveRelease = h.patches.length;
  h.documentEvent('pointerup');
  assert.equal(h.patches.length - writesBeforeMoveRelease, 1, 'move release must emit exactly one cq.set');
  assert.equal(h.lastLayer().x, finalX, 'move commit keeps final x');
  h.flush();

  // Resize: pointerdown no handle + pointermove, conta apenas cq.set no release
  const handle = element(); handle.classList.add('h'); handle.classList.add('se');
  h.get('selBox').fire('pointerdown', { target: handle, clientX: 0, clientY: 0, pointerId: 2, preventDefault() {}, stopPropagation() {} });
  h.documentEvent('pointermove', { clientX: 24, clientY: 0 });
  const finalScale = h.lastLayer().scale;
  assert.ok(finalScale > 1);
  h.flush();
  const writesBeforeResizeRelease = h.patches.length;
  h.documentEvent('pointerup');
  assert.equal(h.patches.length - writesBeforeResizeRelease, 1, 'resize release must emit exactly one cq.set');
  assert.equal(h.lastLayer().scale, finalScale, 'resize commit keeps final scale');
  h.flush();

  // Undo do resize: Redo torna-se disponível
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.lastLayer().scale, 1, 'undo restores scale');
  assert.equal(h.canRedo(), true, 'redo is available');
  assert.equal(h.get('redoBtn').disabled, false, 'redo button enabled');

  // Gesto vazio 1: clique no stage sem movimento
  stage.fire('pointerdown', { button: 0, target, clientX: 200, clientY: 200, pointerId: 3 });
  h.documentEvent('pointerup');
  assert.equal(h.canRedo(), true, 'redo remains available after empty stage click');
  assert.equal(h.get('redoBtn').disabled, false, 'redo button stays enabled after empty stage click');

  // Gesto vazio 2: clique em scrub sem movimento (sem h.endEdit ou sleep)
  const xBox = h.xField();
  xBox.fire('pointerdown', { clientX: 0, pointerId: 4, preventDefault() {} });
  xBox.fire('pointerup');
  assert.equal(h.canRedo(), true, 'redo remains available after empty scrub click');
  assert.equal(h.get('redoBtn').disabled, false, 'redo button stays enabled after empty scrub click');

  // Redo permanece funcional e reaplica o resize
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.lastLayer().scale, finalScale, 'redo successfully re-applies resize scale');
  assert.equal(+h.field('Escala').value, finalScale, 'field Escala reflects final scale after redo');
});

await check('distinct-field updates inside the 300ms window merge into one Undo that reverts BOTH', h => {
  const l = h.allLayers()[0];
  l.armLength = 10;
  l.armThickness = 2;
  h.setLayers([l]);
  // Update 1: armLength 10 -> 24 (janela de debounce abre)
  const inputLen = findByAria(h.get('bodyLinhas'), 'Comprimento');
  inputLen.value = '24'; inputLen.fire('change'); h.flush();
  assert.equal(h.allLayers()[0].armLength, 24);
  // Update 2 síncrono (<300ms, SEM endEdit): armThickness 2 -> 8
  const inputThick = findByAria(h.get('bodyLinhas'), 'Espessura');
  inputThick.value = '8'; inputThick.fire('change'); h.flush();
  assert.equal(h.allLayers()[0].armThickness, 8);
  // Undo único reverte AMBOS os campos ao estado original
  h.get('undoBtn').fire('click'); h.flush();
  const afterUndo = h.allLayers()[0];
  assert.equal(afterUndo.armLength, 10, 'undo reverts first field to original');
  assert.equal(afterUndo.armThickness, 2, 'undo reverts second field merged in the same window');
  // Redo reaplica ambos
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].armLength, 24, 'redo reapplies first field');
  assert.equal(h.allLayers()[0].armThickness, 8, 'redo reapplies second field');
});

await check('same-path edits inside the 300ms window still coalesce to the ORIGINAL value', h => {
  const l = h.allLayers()[0];
  l.armLength = 10;
  h.setLayers([l]);
  const inputLen = findByAria(h.get('bodyLinhas'), 'Comprimento');
  inputLen.value = '20'; inputLen.fire('change'); h.flush();
  inputLen.value = '35'; inputLen.fire('change'); h.flush();
  assert.equal(h.allLayers()[0].armLength, 35);
  h.get('undoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].armLength, 10, 'undo reverts past intermediates to the original value');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].armLength, 35, 'redo restores final value');
});

await check('nested-path updates inside the 300ms window merge and both revert on Undo', h => {
  const l = h.allLayers()[0];
  l.dot = { size: 4, blur: 0, color: '#FFFFFF', enabled: true };
  l.outline = { width: 1, blur: 0, color: '#000000', enabled: true };
  h.setLayers([l]);
  const inputDot = findByAria(h.get('bodyDot'), 'Diâmetro');
  inputDot.value = '10'; inputDot.fire('change'); h.flush();
  assert.equal(h.allLayers()[0].dot.size, 10);
  const inputOut = findByAria(h.get('bodyOutline'), 'Espessura');
  inputOut.value = '4'; inputOut.fire('change'); h.flush();
  assert.equal(h.allLayers()[0].outline.width, 4);
  h.get('undoBtn').fire('click'); h.flush();
  const afterUndo = h.allLayers()[0];
  assert.equal(afterUndo.dot.size, 4, 'undo reverts dot.size');
  assert.equal(afterUndo.outline.width, 1, 'undo reverts outline.width merged in the same window');
  h.get('redoBtn').fire('click'); h.flush();
  assert.equal(h.allLayers()[0].dot.size, 10);
  assert.equal(h.allLayers()[0].outline.width, 4);
});

await check('duplicate undo+redo preserves insertion index (z-order)', h => {
  const lA = h.allLayers()[0]; lA.id = 'L0'; lA.name = 'Camada 0';
  const lB = h.newLayer(); lB.id = 'L1'; lB.name = 'Camada 1';
  const lC = h.newLayer(); lC.id = 'L2'; lC.name = 'Camada 2';
  h.setLayers([lA, lB, lC]);
  assert.deepEqual(h.allLayers().map(l => l.id), ['L0', 'L1', 'L2']);
  // Duplicar L1 (índice 1): a cópia entra no índice 2
  const rowL1 = h.get('layers').children.find(r => r.dataset.id === 'L1');
  const dupBtn = rowL1.children.find(c => c.textContent === 'dup');
  dupBtn.fire('click', { stopPropagation() {} });
  h.flush();
  const afterDup = h.allLayers();
  assert.equal(afterDup.length, 4, 'copy inserted');
  const copyId = afterDup[2].id;
  assert.deepEqual(afterDup.map(l => l.id), ['L0', 'L1', copyId, 'L2'], 'copy at index 2');
  // Undo remove a cópia
  h.get('undoBtn').fire('click'); h.flush();
  assert.deepEqual(h.allLayers().map(l => l.id), ['L0', 'L1', 'L2'], 'undo removes the copy');
  // Redo reinsere a cópia NO ÍNDICE 2, não no 0
  h.get('redoBtn').fire('click'); h.flush();
  assert.deepEqual(h.allLayers().map(l => l.id), ['L0', 'L1', copyId, 'L2'], 'redo reinserts at original index 2');
});
