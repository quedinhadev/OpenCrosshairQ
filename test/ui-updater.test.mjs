// Run from app: node test/ui-updater.test.mjs
// Verifies Auto-Update UI and sharing validation/concurrency in ui.js without browser runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LayersShared = require('../src/shared/layers.js');
const GeometryShared = require('../src/shared/geometry.js');
const ShareShared = require('../src/shared/share.js');

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
    style: { setProperty(k, v) { this[k] = v; }, display: '' },
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
    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    },
    dispatchEvent(type, eventObj = {}) {
      const handlers = this.listeners[type] || [];
      for (const fn of handlers) fn({ target: this, preventDefault() {}, ...eventObj });
    },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    click() { this.dispatchEvent('click'); },
    get lastChild() { return this.children.at(-1); },
    querySelector() { return null; },
  };
}

function createEnv(customOverrides = {}) {
  const allIds = [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const hiddenMatches = new Set([...htmlSource.matchAll(/\bid="([^"]+)"[^>]*\bhidden\b/g)].map(m => m[1]));
  const elements = Object.fromEntries(allIds.map(id => {
    const el = createElement(id);
    if (hiddenMatches.has(id)) el.hidden = true;
    return [id, el];
  }));
  const localData = new Map();
  if (customOverrides.localData) {
    for (const [k, v] of Object.entries(customOverrides.localData)) localData.set(k, String(v));
  }
  const windowListeners = {};
  const patches = [];
  let onStateCallback = null;
  let onUpdateCallback = null;

  const mockCq = {
    getState: async () => ({ model: {}, layers: [], scale: 1, visible: true }),
    getDisplays: async () => [{ id: 1, label: 'Monitor 1', bounds: { width: 1920, height: 1080 } }],
    getProfiles: async () => [{ id: 'default', name: 'default' }],
    getNativeStatus: async () => ({ available: true }),
    getStreaming: async () => ({ running: false }),
    getStartupStatus: async () => ({ supported: true, available: true, enabled: false }),
    set(patch) { patches.push(patch); },
    onState(fn) { onStateCallback = fn; },
    onUpdateState(fn) { onUpdateCallback = fn; return () => { onUpdateCallback = null; }; },
    getUpdateState: async () => ({
      supported: true,
      currentVersion: '0.9.5',
      phase: 'idle',
      version: null,
      progress: null,
      error: null,
      reason: null,
    }),
    checkForUpdates: async () => ({
      supported: true,
      currentVersion: '0.9.5',
      phase: 'checking',
      version: null,
      progress: null,
      error: null,
      reason: null,
    }),
    installUpdate: async () => ({
      supported: true,
      currentVersion: '0.9.5',
      phase: 'installing',
      version: '1.0.0',
      progress: 100,
      error: null,
      reason: null,
    }),
    ...customOverrides.cq,
  };

  const documentElement = createElement('html');
  documentElement.lang = 'pt-BR';

  let confirmResult = true;
  const confirmCalls = [];

  const sandbox = {
    window: {
      cq: mockCq,
      CQLayers: customOverrides.CQLayers !== undefined ? customOverrides.CQLayers : LayersShared,
      CQGeometry: GeometryShared,
      CQShare: ShareShared,
      confirm(prompt) { confirmCalls.push(prompt); return confirmResult; },
      addEventListener(type, fn) { windowListeners[type] = fn; },
      location: { hash: '#crosshairs' },
      ...customOverrides.window,
    },
    document: {
      getElementById(id) {
        if (!elements[id]) elements[id] = createElement(id);
        return elements[id];
      },
      querySelectorAll() { return []; },
      querySelector(sel) { return null; },
      createElement(tag) { return createElement(tag); },
      body: createElement('body'),
      head: {
        children: [],
        appendChild(child) {
          this.children.push(child);
          if (child.tagName === 'SCRIPT' && typeof child.onerror === 'function' && !customOverrides.CQLayers) {
            child.onerror(new Error('validador indisponível'));
          }
        },
      },
      documentElement,
      ...customOverrides.document,
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
    URL: {
      createObjectURL() { return 'blob:mock'; },
      revokeObjectURL() {},
    },
    ...customOverrides.sandbox,
  };

  vm.createContext(sandbox);
  vm.runInContext(uiSource, sandbox);

  return {
    elements,
    sandbox,
    mockCq,
    get onUpdateCallback() { return onUpdateCallback; },
    get confirmCalls() { return confirmCalls; },
    setConfirmResult(r) { confirmResult = r; },
  };
}

const tick = () => new Promise(r => setImmediate(r));

test('Auto-Update: tolerant boot when window.cq.getUpdateState is missing (legacy mocks)', async () => {
  const env = createEnv({
    cq: {
      getUpdateState: undefined,
      onUpdateState: undefined,
      checkForUpdates: undefined,
      installUpdate: undefined,
    },
  });
  await tick();
  assert.equal(env.elements.btnCheckUpdates.disabled, true, 'btnCheckUpdates must be disabled when getUpdateState is missing');
  assert.equal(env.elements.btnInstallUpdate.hidden, true, 'btnInstallUpdate must remain hidden');
});

test('Auto-Update: tolerant boot when getUpdateState rejects', async () => {
  const env = createEnv({
    cq: {
      getUpdateState: async () => { throw new Error('IPC timeout'); },
    },
  });
  await tick();
  assert.equal(env.elements.btnCheckUpdates.disabled, true, 'btnCheckUpdates disabled on IPC failure');
  assert.match(env.elements.updateStatus.textContent, /IPC timeout|Falha/, 'updateStatus communicates error');
});

test('Auto-Update: normal boot updates statVersion and does not overwrite with 0.1.0', async () => {
  const env = createEnv({
    cq: {
      getUpdateState: async () => ({
        supported: true,
        currentVersion: '1.4.2',
        phase: 'idle',
        version: null,
        progress: null,
        error: null,
        reason: null,
      }),
    },
  });
  await tick();
  assert.equal(env.elements.statVersion.textContent, '1.4.2', 'statVersion displays currentVersion from updater');
  assert.equal(env.elements.btnCheckUpdates.disabled, false, 'btnCheckUpdates is enabled when idle and supported');
  assert.equal(env.elements.btnInstallUpdate.hidden, true, 'btnInstallUpdate is hidden when not downloaded');
});

test('Auto-Update: onUpdateState events update UI phases correctly', async () => {
  const env = createEnv();
  await tick();

  // 1. checking phase
  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'checking',
    version: null,
    progress: null,
    error: null,
  });
  assert.equal(env.elements.btnCheckUpdates.disabled, true, 'Check button disabled during checking phase');
  assert.match(env.elements.updateStatus.textContent, /Verificando atualizações/i);
  assert.equal(env.elements.btnInstallUpdate.hidden, true);

  // 2. downloading phase
  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'downloading',
    version: '1.0.0',
    progress: 45,
    error: null,
  });
  assert.equal(env.elements.btnCheckUpdates.disabled, true, 'Check button disabled during downloading');
  assert.match(env.elements.updateStatus.textContent, /45%/);
  assert.equal(env.elements.btnInstallUpdate.hidden, true);

  // 3. downloaded phase -> btnInstallUpdate visible
  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'downloaded',
    version: '1.0.0',
    progress: 100,
    error: null,
  });
  assert.equal(env.elements.btnInstallUpdate.hidden, false, 'btnInstallUpdate must be visible on downloaded');
  assert.equal(env.elements.btnInstallUpdate.style.display, '', 'display must not be none');
  assert.equal(env.elements.btnInstallUpdate.disabled, false);
  assert.match(env.elements.updateStatus.textContent, /1\.0\.0/);

  // 4. transient error during downloaded phase retains downloaded version and install button
  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'downloaded',
    version: '1.0.0',
    progress: 100,
    error: 'Falha temporária de rede.',
  });
  assert.equal(env.elements.btnInstallUpdate.hidden, false, 'btnInstallUpdate stays visible despite error');
  assert.match(env.elements.updateStatus.textContent, /Falha temporária de rede/);
  assert.match(env.elements.updateStatus.textContent, /1\.0\.0/);

  // 5. unsupported phase
  env.onUpdateCallback({
    supported: false,
    currentVersion: '0.9.5',
    phase: 'unsupported',
    version: null,
    progress: null,
    error: null,
  });
  assert.equal(env.elements.btnCheckUpdates.disabled, true, 'btnCheckUpdates disabled on unsupported');
  assert.equal(env.elements.btnInstallUpdate.hidden, true);
  assert.match(env.elements.updateStatus.textContent, /indisponíveis neste ambiente/i);
});

test('Auto-Update: btnInstallUpdate requires window.confirm and prevents concurrent execution', async () => {
  let installCalls = 0;
  const env = createEnv({
    cq: {
      installUpdate: async () => {
        installCalls++;
        return { supported: true, currentVersion: '0.9.5', phase: 'installing' };
      },
    },
  });
  await tick();

  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'downloaded',
    version: '1.0.0',
    progress: 100,
    error: null,
  });

  // User cancels confirmation
  env.setConfirmResult(false);
  env.elements.btnInstallUpdate.click();
  await tick();
  assert.equal(env.confirmCalls.length, 1, 'window.confirm was called');
  assert.equal(installCalls, 0, 'installUpdate was aborted when cancelled');

  // User accepts confirmation
  env.setConfirmResult(true);
  env.elements.btnInstallUpdate.click();
  // Double-click while in-flight
  env.elements.btnInstallUpdate.click();
  await tick();
  assert.equal(env.confirmCalls.length, 2, 'second click did not trigger second confirmation while in flight');
  assert.equal(installCalls, 1, 'installUpdate invoked exactly once');
});

test('Auto-Update: btnCheckUpdates deduplicates concurrent clicks', async () => {
  let checkCalls = 0;
  let resolveCheck;
  const env = createEnv({
    cq: {
      checkForUpdates: () => {
        checkCalls++;
        return new Promise((resolve) => { resolveCheck = resolve; });
      },
    },
  });
  await tick();

  // First click starts pending check
  env.elements.btnCheckUpdates.click();
  // Second click while in-flight
  env.elements.btnCheckUpdates.click();
  assert.equal(checkCalls, 1, 'Only one IPC check invocation allowed concurrently');

  resolveCheck({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'not-available',
  });
  await tick();
  assert.equal(checkCalls, 1);
  assert.equal(env.elements.btnCheckUpdates.disabled, false);
});

test('Auto-Update: missing confirmation never authorizes installation', async () => {
  let installs = 0;
  const env = createEnv({ window: { confirm: undefined }, cq: { installUpdate: async () => { installs++; } } });
  await tick();
  env.onUpdateCallback({ supported: true, currentVersion: '0.2.0', phase: 'downloaded', version: '0.2.1' });
  env.elements.btnInstallUpdate.click();
  await tick();
  assert.equal(installs, 0);
});

test('Auto-Update: rejected IPC errors remain visible and downloaded update stays retryable', async () => {
  const env = createEnv({ cq: {
    checkForUpdates: async () => { throw new Error('check IPC failed'); },
    installUpdate: async () => { throw new Error('install IPC failed'); },
  } });
  await tick();
  env.elements.btnCheckUpdates.click();
  await tick();
  assert.match(env.elements.updateStatus.textContent, /check IPC failed/);
  assert.equal(env.elements.btnCheckUpdates.disabled, false);
  env.onUpdateCallback({ supported: true, currentVersion: '0.2.0', phase: 'downloaded', version: '0.2.1' });
  env.elements.btnInstallUpdate.click();
  await tick();
  assert.match(env.elements.updateStatus.textContent, /install IPC failed/);
  assert.match(env.elements.updateStatus.textContent, /0\.2\.1/);
  assert.equal(env.elements.btnInstallUpdate.hidden, false);
  assert.equal(env.elements.btnInstallUpdate.disabled, false);
});

test('Auto-Update: Language switching pt-BR <-> en-US updates labels and status', async () => {
  const env = createEnv();
  await tick();

  env.onUpdateCallback({
    supported: true,
    currentVersion: '0.9.5',
    phase: 'checking',
    version: null,
    progress: null,
    error: null,
  });
  assert.match(env.elements.updateStatus.textContent, /Verificando atualizações/);

  // Switch to en-US
  env.elements.optionLanguage.value = 'en-US';
  env.elements.optionLanguage.dispatchEvent('change');
  await tick();

  assert.equal(env.elements.lblCheckUpdates.textContent, 'Check for updates');
  assert.equal(env.elements.btnCheckUpdates.textContent, 'CHECK');
  assert.equal(env.elements.btnInstallUpdate.textContent, 'INSTALL');
  assert.match(env.elements.updateStatus.textContent, /Checking for updates/);
});

test('Sharing regression: applyImportPayload throws if CQLayers validator is unavailable', async () => {
  const env = createEnv({
    CQLayers: null, // Validator unavailable
  });
  await tick();

  env.elements.importCodeText.value = JSON.stringify({
    format: 'CQ1',
    name: 'Test',
    model: {},
    layers: [],
  });
  env.elements.btnApplyImportCode.click();
  await tick();

  assert.match(env.elements.importStatus.textContent, /Validador da mira indisponível/i);
});

test('Sharing regression: parseShareCode strictly rejects format !== CQ1', async () => {
  const env = createEnv();
  await tick();

  env.elements.importCodeText.value = JSON.stringify({
    format: 'CQ2',
    name: 'Invalid Envelope Inside',
    model: {},
    layers: [],
  });
  env.elements.btnApplyImportCode.click();
  await tick();

  assert.match(env.elements.importStatus.textContent, /Versão de documento não suportada/i);

  // Explicit falsy versions are still declared versions, never treated as absent.
  for (const format of [false, 0, '', null]) {
    env.elements.importCodeText.value = JSON.stringify({ format, name: 'Falsy version', model: {}, layers: [] });
    env.elements.btnApplyImportCode.click();
    await tick();
    assert.match(env.elements.importStatus.textContent, /Versão de documento não suportada/i,
      `format ${JSON.stringify(format)} must be rejected`);
  }
});

test('Sharing regression: importPending lock prevents concurrent duplicate imports', async () => {
  let saveCount = 0;
  const env = createEnv({
    localData: { 'cq.savedCustomCrosshairs': '[]' },
  });
  await tick();

  const validDoc = JSON.stringify({
    format: 'CQ1',
    name: 'Unique Mira',
    model: {},
    layers: [],
  });
  env.elements.importCodeText.value = validDoc;

  // Simulate two rapid clicks
  env.elements.btnApplyImportCode.click();
  env.elements.btnApplyImportCode.click();
  await tick();

  const saved = JSON.parse(env.sandbox.localStorage.getItem('cq.savedCustomCrosshairs') || '[]');
  assert.equal(saved.length, 1, 'Only one item saved; concurrent duplicate import prevented');
});

test('Sharing regression: btnExportShareFile rejects empty or invalid code without silent fallback', async () => {
  const env = createEnv();
  await tick();

  // 1. Empty code
  env.elements.shareCodeText.value = '';
  env.elements.btnExportShareFile.click();
  await tick();
  assert.match(env.elements.toast.textContent, /vazio/i, 'Empty share code rejected without export');

  // 2. Corrupt code
  env.elements.toast.textContent = '';
  env.elements.shareCodeText.value = 'invalid-code-123';
  env.elements.btnExportShareFile.click();
  await tick();
  assert.match(env.elements.toast.textContent, /Não foi possível exportar a mira/i, 'Corrupt code rejected without silent crosshairPayload fallback');
});

test('Display modes copy: optPanelDisplay accurately explains overlay nature without promising anti-cheat immunity', () => {
  assert.doesNotMatch(htmlSource, /não é detectada como cheat nem interfere com softwares anti-cheat/i);
  assert.match(htmlSource, /sem injeção de memória nem modificação de arquivos/i);
  assert.match(htmlSource, /não garante ausência de restrições ou punições/i);
});
