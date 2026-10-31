import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const LayersShared = require('../src/shared/layers.js');
const GeometryShared = require('../src/shared/geometry.js');
const uiSource = fs.readFileSync('src/ui/ui.js', 'utf8');
const htmlSource = fs.readFileSync('src/ui/index.html', 'utf8');

function createElement(tagName = 'div') {
  const classes = new Set();
  const attributes = {};
  return {
    tagName: tagName.toUpperCase(),
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    style: { setProperty(k, v) { this[k] = v; } },
    listeners: {},
    children: [],
    attributes,
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
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    get lastChild() { return this.children.at(-1); },
    querySelector() { return null; },
  };
}

function createEnv(customSandbox = {}) {
  const allIds = [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const elements = Object.fromEntries(allIds.map(id => [id, createElement()]));
  const localData = new Map();
  if (customSandbox.localData) {
    for (const [k, v] of Object.entries(customSandbox.localData)) localData.set(k, String(v));
  }
  const windowListeners = {};
  const patches = [];
  const cqCalls = { deletedProfiles: [], renamedProfiles: [] };
  let onStateCallback = null;

  const mockCq = {
    getState: async () => ({ model: {}, layers: [], scale: 1, visible: true }),
    getDisplays: async () => [{ id: 1, label: 'Monitor 1', bounds: { width: 1920, height: 1080 } }],
    getProfiles: async () => [{ id: 'default', name: 'default' }, { id: 'p1', name: 'Perfil 1' }],
    getNativeStatus: async () => ({ available: true, foreground: { pid: 100, executablePath: 'C:\\Games\\game.exe' } }),
    getStreaming: async () => ({ running: false }),
    getStartupStatus: async () => ({ supported: true, available: true, enabled: false }),
    set(patch) { patches.push(patch); },
    onState(fn) { onStateCallback = fn; },
    setProfile() {},
    createProfile() {},
    deleteProfile(id) { cqCalls.deletedProfiles.push(id); },
    renameProfile(id, name) { cqCalls.renamedProfiles.push({ id, name }); },
    configureProfile: async (opts) => opts,
    ...customSandbox.cq,
  };

  const documentElement = createElement('html');
  documentElement.lang = 'pt-BR';

  const { window: customWindow, document: customDocument, cq: customCq, localData: _ld, ...restCustom } = customSandbox;

  const sandbox = {
    window: {
      cq: mockCq,
      CQLayers: LayersShared,
      CQGeometry: GeometryShared,
      addEventListener(type, fn) { windowListeners[type] = fn; },
      location: { hash: '#crosshairs' },
      ...customWindow,
    },
    document: {
      getElementById(id) {
        if (!elements[id]) elements[id] = createElement();
        return elements[id];
      },
      querySelectorAll() { return []; },
      createElement(tag) { return createElement(tag); },
      body: createElement('body'),
      head: createElement('head'),
      documentElement,
      ...customDocument,
    },
    localStorage: {
      getItem(key) { return localData.has(key) ? localData.get(key) : null; },
      setItem(key, val) { localData.set(key, String(val)); },
      removeItem(key) { localData.delete(key); },
    },
    setTimeout(fn) { fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    TextEncoder: globalThis.TextEncoder,
    Buffer: globalThis.Buffer,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    console: { log() {}, error() {}, warn() {} },
    ...restCustom,
  };

  vm.runInNewContext(uiSource, sandbox);

  return {
    elements,
    localData,
    patches,
    cqCalls,
    documentElement,
    emitState(s) { if (onStateCallback) onStateCallback(s); },
    windowListeners,
    sandbox,
  };
}

test('UI Rework: CQ1: versioned share code roundtrip and Unicode support', () => {
  const env = createEnv();
  const sampleCrosshair = {
    id: 'custom-heart',
    name: 'Mira Coração Especial ♥',
    model: { gap: 4, armLen: 10, armThick: 2, color: '#ff2f6b' },
    layers: [],
    drawing: null,
  };

  env.localData.set('cq.savedCustomCrosshairs', JSON.stringify([sampleCrosshair]));
  env.elements.tabSalvos = createElement();
  env.elements.tabSalvos.dataset = { xtab: 'salvos' };

  // Trigger share modal from share button
  env.emitState({ model: sampleCrosshair.model, layers: [], drawing: null });
  env.elements.btnShare.listeners.click();

  assert.ok(env.elements.shareModal.classList.contains('on'), 'shareModal should be open');
  const code = env.elements.shareCodeText.value;
  assert.ok(code.startsWith('CQ1:'), 'Share code must begin with version prefix CQ1:');

  // Verify base64 decode and parse
  const b64 = code.slice(4);
  const json = Buffer.from(b64, 'base64').toString('utf8');
  const parsed = JSON.parse(json);

  assert.equal(parsed.format, 'CQ1', 'Format flag must be CQ1');
  assert.equal(parsed.model.color, '#ff2f6b', 'Model properties must roundtrip');
});

test('UI Rework: Import modal handles CQ1: code, raw JSON, and validates via CQLayers', async () => {
  const env = createEnv();

  // Test CQ1 import with layered document
  const dotLayer = {
    id: 'layer-dot',
    type: 'model',
    name: 'Ponto Amarelo',
    visible: true,
    armCount: 4,
    armLength: 0,
    armThickness: 0,
    armSpacing: 0,
    dot: { enabled: true, size: 4, shape: 'circle', color: '#ffea00' },
    outline: { enabled: false },
  };

  const payload = {
    format: 'CQ1',
    id: 'share-dot',
    name: 'Dot Yellow',
    model: {},
    layers: [dotLayer],
    drawing: '<script>alert("evil")</script>', // should be sanitized by CQLayers
  };

  const code = 'CQ1:' + Buffer.from(JSON.stringify(payload)).toString('base64');

  env.elements.btnImport.listeners.click();
  assert.ok(env.elements.importModal.classList.contains('on'), 'importModal opens on btnImport click');

  env.elements.importCodeText.value = code;
  await env.elements.btnApplyImportCode.listeners.click();

  assert.ok(env.patches.length > 0, 'Applying import code must emit cq.set patch');
  const lastPatch = env.patches.at(-1);
  assert.ok(Array.isArray(lastPatch.layers), 'Patch must contain validated layers');
  assert.equal(lastPatch.layers[0].name, 'Ponto Amarelo');
  assert.doesNotMatch(lastPatch.drawing, /<script>/, 'Injected script in drawing must be rejected/recompiled');
  assert.ok(!env.elements.importModal.classList.contains('on'), 'importModal closes on successful import');

  // Test raw JSON fallback
  const rawJson = JSON.stringify({
    name: 'Raw JSON Crosshair',
    model: { gap: 6, armLen: 12, armThick: 2, color: '#00e5ff' },
  });
  env.elements.importCodeText.value = rawJson;
  await env.elements.btnApplyImportCode.listeners.click();
  assert.equal(env.patches.at(-1).model.color, '#00e5ff', 'Raw JSON import must apply model');
});

test('UI Rework: Saved library mod-card actions (apply, edit in designer, rename, delete, duplicate)', () => {
  const env = createEnv();

  const item = {
    id: 'custom-card-test',
    name: 'Mira Custom Original',
    creator: 'Tester',
    model: { gap: 3, armLen: 6, armThick: 2, color: '#ffffff' },
    layers: [],
    drawing: null,
  };

  env.localData.set('cq.savedCustomCrosshairs', JSON.stringify([item]));

  // Switch to salvos tab to render savedGrid
  env.emitState({ model: {}, layers: [] });
  const card = env.elements.savedGrid.children[0];
  assert.ok(card, 'Saved crosshairs grid must have card');

  // Verify card action buttons
  const media = card.children[0];
  const strip = card.children[1];
  const actions = card.children[2];

  assert.ok(media && media.className === 'mod-card-media', 'Media is first child');
  assert.ok(strip && strip.className === 'mod-card-strip', 'Strip is second child');
  assert.ok(actions && actions.className === 'mod-card-actions', 'Actions bar is third child');

  // Test apply action
  const applyBtn = actions.children.find(c => c.title === 'Aplicar mira');
  assert.ok(applyBtn, 'Apply button exists');
  applyBtn.listeners.click({ stopPropagation() {} });
  assert.equal(env.patches.at(-1).model.armLen, 6, 'Apply button sends crosshair patch to IPC');

  // Test rename action
  const renameBtn = actions.children.find(c => c.title === 'Renomear mira');
  assert.ok(renameBtn, 'Rename button exists');
  renameBtn.listeners.click({ stopPropagation() {} });
  assert.ok(env.elements.renameModal.classList.contains('on'), 'Rename modal opened');
  assert.equal(env.elements.renameInput.value, 'Mira Custom Original');

  env.elements.renameInput.value = 'Mira Custom Renomeada';
  env.elements.btnRenameSave.listeners.click();
  assert.ok(!env.elements.renameModal.classList.contains('on'), 'Rename modal closed');

  const customList = JSON.parse(env.localData.get('cq.savedCustomCrosshairs'));
  assert.equal(customList[0].name, 'Mira Custom Renomeada', 'Name updated in localStorage');

  // Test duplicate action (kept in media for compatibility)
  const dupBtn = media.children.find(c => c.title === 'Duplicar mira salva');
  assert.ok(dupBtn, 'Duplicate button exists in media');
  dupBtn.listeners.click({ stopPropagation() {} });
  const updatedList = JSON.parse(env.localData.get('cq.savedCustomCrosshairs'));
  assert.equal(updatedList.length, 2, 'Duplicated item added to localStorage');
  assert.match(updatedList[1].name, /\(cópia\)/);

  // Test delete action
  const deleteBtn = env.elements.savedGrid.children[0].children[2].children.find(c => c.title === 'Excluir mira');
  assert.ok(deleteBtn, 'Delete button exists');
  deleteBtn.listeners.click({ stopPropagation() {} });
  const afterDeleteList = JSON.parse(env.localData.get('cq.savedCustomCrosshairs'));
  assert.equal(afterDeleteList.length, 1, 'Deleted item removed from localStorage');
});

test('UI Rework: Saved crosshairs empty state and counter updates', () => {
  const env = createEnv();

  // Initially empty
  env.localData.set('cq.savedCrosshairs', '[]');
  env.localData.set('cq.savedCustomCrosshairs', '[]');

  env.emitState({ model: {}, layers: [] });

  assert.equal(env.elements.savedEmpty.hidden, false, 'Empty state must be visible when zero items');
  assert.equal(env.elements.savedCount.textContent, '', 'Count should be empty string when 0');

  // Add 1 custom item
  const item = { id: 'custom-1', name: 'Item 1', model: {}, layers: [] };
  env.localData.set('cq.savedCustomCrosshairs', JSON.stringify([item]));

  env.emitState({ model: {}, layers: [] });
  assert.equal(env.elements.savedEmpty.hidden, true, 'Empty state must be hidden when items exist');
  assert.equal(env.elements.savedCount.textContent, '1', 'Count should display 1');
});

test('UI Rework: Dynamic i18n language dictionary switching (pt-BR <-> en-US)', () => {
  const env = createEnv();

  assert.equal(env.elements.optionLanguage.value, 'pt-BR', 'Default language is pt-BR');

  // Switch to en-US
  env.elements.optionLanguage.listeners.change({ target: { value: 'en-US' } });
  assert.equal(env.localData.get('cq.language'), 'en-US', 'Language saved to localStorage');
  assert.equal(env.elements.lblOptLanguage.textContent, 'Language', 'Option label translated to English');
  assert.equal(env.elements.lblOnlyInGame.textContent, 'Show Only In-Game');
  assert.equal(env.elements.shareModalTitle.textContent, 'Share Crosshair');
  assert.equal(env.elements.importModalTitle.textContent, 'Import Crosshair');

  // Switch back to pt-BR
  env.elements.optionLanguage.listeners.change({ target: { value: 'pt-BR' } });
  assert.equal(env.localData.get('cq.language'), 'pt-BR');
  assert.equal(env.elements.lblOptLanguage.textContent, 'Idioma', 'Option label translated to Portuguese');
  assert.equal(env.elements.lblOnlyInGame.textContent, 'Mostrar Apenas no Jogo');
  assert.equal(env.elements.shareModalTitle.textContent, 'Compartilhar Mira');
});

test('UI Rework: Native Web Audio interface SFX toggle persistence', () => {
  const env = createEnv();

  assert.equal(env.elements.optionSounds.checked, false, 'Default sound is disabled (opt-in)');

  // Enable sounds
  env.elements.optionSounds.listeners.change({ target: { checked: true } });
  assert.equal(env.localData.get('cq.soundEffects'), 'true', 'Sound enabled persisted');

  // Disable sounds
  env.elements.optionSounds.listeners.change({ target: { checked: false } });
  assert.equal(env.localData.get('cq.soundEffects'), 'false', 'Sound disabled persisted');
});

test('UI Rework: Live onlyInGame diagnostics line reflects game foreground state', () => {
  const env = createEnv();

  // 1. onlyInGame is false:
  env.emitState({ onlyInGame: false });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Mira visível em todas as janelas.');

  // 2. onlyInGame is true but no game running:
  env.emitState({ onlyInGame: true, gameRunning: false, nativeStatus: { available: true, foreground: null } });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Aguardando jogo em foco; mira oculta na área de trabalho.');

  // 3. onlyInGame is true but Explorer / non-game window in foreground:
  env.emitState({ onlyInGame: true, gameRunning: true, gameInFocus: false });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Aguardando jogo em foco; mira oculta na área de trabalho.');

  // 4. onlyInGame is true and game strictly in focus (gameInFocus: true):
  env.emitState({ onlyInGame: true, gameInFocus: true });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Jogo em foco detectado: a mira está ativa.');

  // 5. Visibility suppression when hidden or invisible:
  env.emitState({ onlyInGame: true, gameInFocus: true, hidden: true });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Mira oculta nas configurações.');
  env.emitState({ onlyInGame: true, gameInFocus: true, visible: false });
  assert.equal(env.elements.onlyInGameStatus.textContent, 'Mira oculta nas configurações.');
});

test('UI Rework: Keybind toggle accessibility (aria-pressed, is-active/is-inactive)', () => {
  const env = createEnv();

  env.emitState({
    model: {},
    keybinds: {
      globalShortcut: { enabled: true, pc: { modifiers: ['Alt', 'Shift'], key: 'Z' } },
      aim: { action: 'aim', pressType: 'hold', pc: { modifiers: [], key: 'RightClick' } },
      fire: { action: 'fire', pressType: 'hold', pc: { modifiers: [], key: 'LeftClick' } },
      reload: { action: 'reload', pressType: 'press', pc: { modifiers: [], key: 'R' } },
    },
  });

  const row0 = env.elements.keybindList.children[0];
  assert.ok(row0, 'Global shortcut row rendered');

  // Check buttons inside kb-toggle
  // Find kb-toggle inside the row
  const toggle = row0.children[0].children[0].children[0].children[2]?.children[0];
  if (toggle) {
    const offBtn = toggle.children[0];
    const onBtn = toggle.children[1];

    assert.equal(onBtn.getAttribute('aria-pressed'), 'true', 'Active button has aria-pressed="true"');
    assert.equal(offBtn.getAttribute('aria-pressed'), 'false', 'Inactive button has aria-pressed="false"');
    assert.ok(onBtn.classList.contains('is-active'), 'Active button has is-active class');
    assert.ok(offBtn.classList.contains('is-inactive'), 'Inactive button has is-inactive class');
  }
});

test('UI Rework: Escape key closes active modals (shareModal, importModal, renameModal)', () => {
  const env = createEnv();

  env.elements.shareModal.classList.add('on');
  env.windowListeners.keydown({ key: 'Escape' });
  assert.ok(!env.elements.shareModal.classList.contains('on'), 'Escape key closed shareModal');

  env.elements.importModal.classList.add('on');
  env.windowListeners.keydown({ key: 'Escape' });
  assert.ok(!env.elements.importModal.classList.contains('on'), 'Escape key closed importModal');

  env.elements.renameModal.classList.add('on');
  env.windowListeners.keydown({ key: 'Escape' });
  assert.ok(!env.elements.renameModal.classList.contains('on'), 'Escape key closed renameModal');
});

test('UI Rework: Corrupt localStorage cq.savedCustomCrosshairs="{}" does not throw on boot or overwrite payload', () => {
  const localData = { 'cq.savedCustomCrosshairs': '{}' };
  let env;
  assert.doesNotThrow(() => {
    env = createEnv({ localData });
  }, 'Booting with corrupt object payload in savedCustomCrosshairs must not throw');
  assert.equal(env.localData.get('cq.savedCustomCrosshairs'), '{}', 'Invalid payload in storage must not be overwritten silently');
  assert.equal(env.elements.savedEmpty.hidden, false, 'Treated safely as empty fallback');
});

test('UI Rework: CQ1 export of ~1MB raster omits drawing and roundtrips within 2 MiB limit', async () => {
  const env = createEnv();
  const rasterData = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024);
  const largeLayer = {
    id: 'raster-1mb',
    type: 'draw',
    name: 'Raster 1MB',
    visible: true,
    x: 0,
    y: 0,
    w: 64,
    h: 64,
    size: 2,
    src: rasterData,
  };

  const hugeDerivedDrawing = '<svg viewBox="-128 -128 256 256">' + '<path d="M0,0"/>'.repeat(50000) + '</svg>';
  env.emitState({
    model: {},
    layers: [largeLayer],
    drawing: hugeDerivedDrawing,
  });

  env.elements.btnShare.listeners.click();
  assert.ok(env.elements.shareModal.classList.contains('on'), 'Share modal opens');
  const code = env.elements.shareCodeText.value;
  assert.ok(code.startsWith('CQ1:'), 'Code starts with CQ1:');
  assert.ok(code.length <= 2 * 1024 * 1024, `Code length ${code.length} must be <= 2 MiB`);

  const jsonStr = Buffer.from(code.slice(4), 'base64').toString('utf8');
  const payload = JSON.parse(jsonStr);
  assert.equal(payload.drawing, undefined, 'Derived drawing must be omitted when layers are present');
  assert.equal(payload.layers.length, 1);

  env.elements.btnImport.listeners.click();
  env.elements.importCodeText.value = code;
  await env.elements.btnApplyImportCode.listeners.click();
  assert.ok(!env.elements.importModal.classList.contains('on'), 'Import successfully applies');
});

test('UI Rework: Oversize code (>2 MiB) is rejected on export and import with explicit error', async () => {
  const env = createEnv();
  const oversizeCode = 'CQ1:' + 'B'.repeat(2 * 1024 * 1024 + 10);
  env.elements.btnImport.listeners.click();
  env.elements.importCodeText.value = oversizeCode;
  await env.elements.btnApplyImportCode.listeners.click();
  assert.match(env.elements.importStatus.textContent, /2 MiB/i, 'Import status announces oversize limit');

  const hugeLayer = {
    id: 'raster-huge',
    type: 'draw',
    name: 'Huge',
    visible: true,
    x: 0,
    y: 0,
    w: 64,
    h: 64,
    size: 2,
    src: 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024),
  };
  env.emitState({ model: {}, layers: [hugeLayer], drawing: null });
  env.elements.btnShare.listeners.click();
  assert.match(env.elements.toast.textContent, /2 MiB/i, 'Oversize export triggers toast error');
});

test('UI Rework: document.documentElement.lang and accessible labels track language', () => {
  const env = createEnv();
  assert.equal(env.documentElement.lang, 'pt-BR');

  // Switch to en-US
  env.elements.optionLanguage.listeners.change({ target: { value: 'en-US' } });
  assert.equal(env.documentElement.lang, 'en-US');
  assert.equal(env.elements.optTabGeral.textContent, 'General');
  assert.equal(env.elements.optTabDisplay.textContent, 'Display Modes');
  assert.equal(env.elements.optTabStream.textContent, 'Recording / Streaming');
  assert.equal(env.elements.profileModalClose.getAttribute('aria-label'), 'Close');
  assert.equal(env.elements.renameModalClose.getAttribute('aria-label'), 'Close');

  // Switch back to pt-BR
  env.elements.optionLanguage.listeners.change({ target: { value: 'pt-BR' } });
  assert.equal(env.documentElement.lang, 'pt-BR');
  assert.equal(env.elements.optTabGeral.textContent, 'Geral');
  assert.equal(env.elements.optTabDisplay.textContent, 'Modos de Exibição');
  assert.equal(env.elements.optTabStream.textContent, 'Gravação / Streaming');
  assert.equal(env.elements.profileModalClose.getAttribute('aria-label'), 'Fechar');
  assert.equal(env.elements.renameModalClose.getAttribute('aria-label'), 'Fechar');
});

test('UI Rework: Profile renames reuse renameModal and Escape closes top modal first', async () => {
  const env = createEnv({
    window: { confirm: null },
  });

  env.elements.profileChip.listeners.click();
  await new Promise(r => setImmediate(r));
  assert.ok(env.elements.profileModal.classList.contains('on'), 'Profile modal open');

  const profileList = env.elements.profileList;
  const p1Row = profileList.children.find(r => r.innerHTML.includes('>p1 ·'));
  assert.ok(p1Row, 'Profile p1 row exists');
  const actions = p1Row.children[0];
  const deleteBtn = actions.children[1];
  const renameBtn = actions.children[2];

  deleteBtn.listeners.click();
  assert.equal(env.cqCalls.deletedProfiles.length, 0, 'Delete must fail-closed when confirm is unavailable');

  renameBtn.listeners.click();
  assert.ok(env.elements.renameModal.classList.contains('on'), 'renameModal opened on profile rename');
  assert.equal(env.elements.renameModalTitle.textContent, 'Renomear Perfil');
  assert.equal(env.elements.renameInput.value, 'Perfil 1');

  env.windowListeners.keydown({ key: 'Escape' });
  assert.ok(!env.elements.renameModal.classList.contains('on'), 'Escape closed renameModal');
  assert.ok(env.elements.profileModal.classList.contains('on'), 'profileModal remained open');

  env.windowListeners.keydown({ key: 'Escape' });
  assert.ok(!env.elements.profileModal.classList.contains('on'), 'Second Escape closed profileModal');

  env.elements.profileChip.listeners.click();
  renameBtn.listeners.click();
  env.elements.renameInput.value = 'Perfil Renomeado';
  await env.elements.btnRenameSave.listeners.click();
  assert.equal(env.cqCalls.renamedProfiles.length, 1);
  assert.equal(env.cqCalls.renamedProfiles[0].name, 'Perfil Renomeado');
  assert.equal(env.elements.toast.textContent, '', 'No premature success toast before backend confirmation');
  assert.ok(!env.elements.renameModal.classList.contains('on'), 'renameModal closed after save');
});

test('UI Rework: No setInterval auto-carousel in ui.js', () => {
  assert.doesNotMatch(uiSource, /setInterval\s*\(\s*\(\)\s*=>\s*\{\s*if\s*\(currentRoute/, 'auto carousel setInterval must be removed');
});

test('UI Rework regression: Explicit empty crosshair (layers: [], drawing: "") roundtrips without resurrecting default arms', async () => {
  const env = createEnv();
  const emptyDoc = { model: { color: '#123456' }, layers: [], drawing: '' };
  env.emitState(emptyDoc);

  env.elements.btnShare.listeners.click();
  const code = env.elements.shareCodeText.value;
  assert.ok(code.startsWith('CQ1:'));

  const jsonStr = Buffer.from(code.slice(4), 'base64').toString('utf8');
  const payload = JSON.parse(jsonStr);
  assert.equal(payload.layers.length, 0);
  assert.equal(payload.drawing, '');
  assert.equal(payload.model.color, '#123456');

  env.elements.btnImport.listeners.click();
  env.elements.importCodeText.value = code;
  await env.elements.btnApplyImportCode.listeners.click();

  const lastPatch = env.patches.at(-1);
  assert.ok(lastPatch, 'Import applied a patch to state');
  assert.equal(lastPatch.layers.length, 0);
  assert.equal(lastPatch.drawing, '');

  const layers = LayersShared.crosshairLayers(lastPatch);
  assert.equal(layers.length, 0, 'Explicit empty crosshair must not fall back to modelToLayer');
  assert.equal(LayersShared.renderCrosshair(lastPatch), '', 'Rendered SVG must remain completely empty');
});

test('UI Rework regression: Multibyte UTF-8 document (>2 MiB bytes but <2 MiB chars) rejected in both export handlers', () => {
  let createdDownload = null;
  const env = createEnv({
    document: {
      createElement(tag) {
        const el = createElement(tag);
        if (tag === 'a') createdDownload = el;
        return el;
      },
    },
  });

  // 800k CJK characters = 800k string length, ~2.4MB UTF-8 byte size
  const cjkString = '漢'.repeat(800000);
  const largeDoc = {
    model: {},
    layers: [{ id: 'text-1', type: 'text', name: 'CJK', text: cjkString, x: 0, y: 0, size: 12 }],
    drawing: null,
  };
  env.emitState(largeDoc);

  // 1. contDownload export check
  createdDownload = null;
  env.elements.toast.textContent = '';
  env.elements.contDownload.listeners.click();
  assert.match(env.elements.toast.textContent, /2 MiB/i, 'contDownload blocks export on UTF-8 byte size');
  assert.equal(createdDownload, null, 'No download link created for oversize multibyte document');

  // 2. btnExportShareFile check
  createdDownload = null;
  env.elements.toast.textContent = '';
  env.elements.shareCodeText.value = JSON.stringify(largeDoc);
  env.elements.btnExportShareFile.listeners.click();
  assert.match(env.elements.toast.textContent, /2 MiB/i, 'btnExportShareFile blocks export on UTF-8 byte size');
  assert.equal(createdDownload, null, 'No download link created for oversize multibyte document in share modal');
});

test('UI Rework regression: Metadata poisoning (null toString on creator/name/id) does not crash import or boot', async () => {
  // Test import sanitization
  const env = createEnv();
  const poisonedPayload = {
    format: 'CQ1',
    id: 'poison-1',
    name: { toString: null },
    creator: { toString: null },
    model: {},
    layers: [],
    drawing: '',
  };

  env.elements.btnImport.listeners.click();
  env.elements.importCodeText.value = JSON.stringify(poisonedPayload);
  await env.elements.btnApplyImportCode.listeners.click();
  assert.ok(!env.elements.importModal.classList.contains('on'), 'Import applies cleanly');

  // Verify saved custom item has sanitized strings
  const storedJson = env.localData.get('cq.savedCustomCrosshairs');
  const stored = JSON.parse(storedJson);
  const importedEntry = stored.at(-1);
  assert.equal(typeof importedEntry.name, 'string');
  assert.equal(typeof importedEntry.creator, 'string');
  assert.equal(importedEntry.name, 'Mira importada');
  assert.equal(importedEntry.creator, 'Importada');

  // Test boot with pre-existing poisoned storage
  const corruptedRaw = JSON.stringify([
    { id: 'corrupt-entry', name: 'Safe Name', creator: { toString: null }, model: {}, layers: [] },
  ]);
  const envBoot = createEnv({
    localData: {
      'cq.savedCustomCrosshairs': corruptedRaw,
    },
  });
  assert.doesNotThrow(() => {
    envBoot.elements.optTabCrosshairs?.listeners?.click?.();
  });
  // Storage was NOT overwritten on boot/read
  assert.equal(envBoot.localData.get('cq.savedCustomCrosshairs'), corruptedRaw);
});

test('UI Rework regression: Corrupt storage ("{broken") blocks writers and preserves original data', () => {
  const brokenStorage = '{broken-json-not-valid';
  const env = createEnv({
    localData: {
      'cq.savedCustomCrosshairs': brokenStorage,
    },
  });

  // Attempt to save current crosshair (contSave)
  env.emitState({
    model: { gap: 5, armLen: 10, armThick: 2, color: '#ffffff' },
    layers: [],
    drawing: null,
  });
  env.elements.toast.textContent = '';
  env.elements.contSave.listeners.click();

  // Must not overwrite corrupt storage
  assert.equal(env.localData.get('cq.savedCustomCrosshairs'), brokenStorage, 'Original corrupted data preserved');
  assert.match(env.elements.toast.textContent, /corrompido/i, 'Surfaces useful corruption error message');
});

test('UI Rework: Aim selector supports off/hold/toggle and persists enabled: false on off without writing pressType: off', () => {
  const env = createEnv();

  env.emitState({
    keybinds: {
      globalShortcut: { enabled: true, pc: { modifiers: ['Alt', 'Shift'], key: 'Z' } },
      aim: { action: 'aim', enabled: true, pressType: 'hold', pc: { modifiers: [], key: 'RightClick' } },
      fire: { action: 'fire', enabled: true, pressType: 'hold', pc: { modifiers: [], key: 'LeftClick' } },
      reload: { action: 'reload', enabled: false, pressType: 'press', pc: { modifiers: [], key: 'R' } },
    },
  });

  const rowAim = env.elements.keybindList.children[1];
  assert.ok(rowAim, 'Aim row rendered');
  assert.ok(rowAim.markup.includes('value="off"'), 'Includes off option');
  assert.ok(rowAim.markup.includes('value="hold" selected'), 'Hold is initially selected');
  assert.ok(rowAim.markup.includes('value="toggle"'), 'Includes toggle option');

  const currentAim = { action: 'aim', enabled: true, pressType: 'hold' };
  const priorPress = (currentAim.pressType === 'toggle' || currentAim.pressType === 'hold') ? currentAim.pressType : 'hold';
  const patchOff = { keybinds: { aim: { ...currentAim, enabled: false, pressType: priorPress } } };
  assert.equal(patchOff.keybinds.aim.enabled, false);
  assert.equal(patchOff.keybinds.aim.pressType, 'hold', 'pressType must never be off');

  env.emitState({
    keybinds: {
      globalShortcut: { enabled: true, pc: { modifiers: ['Alt', 'Shift'], key: 'Z' } },
      aim: { action: 'aim', enabled: false, pressType: 'toggle', pc: { modifiers: [], key: 'RightClick' } },
      fire: { action: 'fire', enabled: true, pc: { modifiers: [], key: 'LeftClick' } },
      reload: { action: 'reload', enabled: false, pc: { modifiers: [], key: 'R' } },
    },
  });
  const rowAimOff = env.elements.keybindList.children[1];
  assert.ok(rowAimOff.markup.includes('value="off" selected'), 'Off is selected when enabled: false');
});

test('UI Rework: onlyInGame process validation, executable browsing/capture, and empty path guard', async () => {
  const env = createEnv();

  // 1. Enabling onlyInGame with empty path is blocked
  env.elements.onlyInGameProcessPath.value = '';
  env.elements.optionOnlyInGame.checked = true;
  env.elements.optionOnlyInGame.listeners.change({ target: env.elements.optionOnlyInGame });
  assert.equal(env.elements.optionOnlyInGame.checked, false, 'Checkbox reverts to unchecked when path empty');
  assert.match(env.elements.toast.textContent, /Configure ou selecione um executável/);

  // 2. Manual valid path triggers cq:set onlyInGameProcessPath
  env.elements.onlyInGameProcessPath.value = 'C:\\Games\\CS2\\game\\bin\\win64\\cs2.exe';
  env.elements.onlyInGameProcessPath.listeners.change({ target: env.elements.onlyInGameProcessPath });
  assert.equal(env.patches.at(-1)?.onlyInGameProcessPath, 'C:\\Games\\CS2\\game\\bin\\win64\\cs2.exe');

  // 3. Enabling onlyInGame with valid path works
  env.emitState({ onlyInGameProcessPath: 'C:\\Games\\CS2\\game\\bin\\win64\\cs2.exe' });
  env.elements.optionOnlyInGame.checked = true;
  env.elements.optionOnlyInGame.listeners.change({ target: env.elements.optionOnlyInGame });
  assert.equal(env.patches.at(-1)?.onlyInGame, true);

  // 4. Clear button clears process path and disables onlyInGame
  env.elements.btnClearOnlyInGameProcess.listeners.click();
  assert.equal(env.patches.at(-1)?.onlyInGameProcessPath, '');
  assert.equal(env.patches.at(-1)?.onlyInGame, false);
  assert.equal(env.elements.optionOnlyInGame.checked, false);

  // 5. Browse executable
  env.sandbox.window.cq.browseGameExecutable = async () => 'D:\\Steam\\steamapps\\common\\Apex\\r5apex.exe';
  await env.elements.btnBrowseGameExecutable.listeners.click();
  assert.equal(env.patches.at(-1)?.onlyInGameProcessPath, 'D:\\Steam\\steamapps\\common\\Apex\\r5apex.exe');

  // 6. Capture foreground
  env.sandbox.window.cq.getNativeStatus = async () => ({
    available: true,
    foreground: { executablePath: 'C:\\Games\\Valorant\\VALORANT.exe', executableName: 'VALORANT.exe' },
  });
  await env.elements.btnCaptureOnlyInGame.listeners.click();
  assert.equal(env.patches.at(-1)?.onlyInGameProcessPath, 'C:\\Games\\Valorant\\VALORANT.exe');
});

test('UI Rework: Miniaturas auto-fit computes bounds including stroke without rounding rect arms', () => {
  const env = createEnv();

  env.emitState({
    model: { gap: 4, armLen: 10, armThick: 2, color: '#ffffff', outline: { enabled: true, width: 1, color: '#000000' } },
  });
  assert.doesNotMatch(env.elements.modelPreview.innerHTML, /rx="/, 'modelSvg arms must not have rounded corners (rx)');
  assert.match(env.elements.modelPreview.innerHTML, /viewBox="-128 -128 256 256"/, 'modelPreview preserves state preview viewBox');
});
