// Run from app: node test/ui-startup-tray.test.mjs
// Verifies startup and minimize-to-tray UI logic in renderer without browser/Electron runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const uiSource = fs.readFileSync('src/ui/ui.js', 'utf8');
const testUiSource = uiSource.replace(
  'let startupStatus = null;',
  'let startupStatus = null; if (typeof window !== "undefined") window.__getStartupStatus = () => startupStatus;'
);
const htmlSource = fs.readFileSync('src/ui/index.html', 'utf8');
const preloadSource = fs.readFileSync('src/ui/preload.js', 'utf8');

function createElement(id = '') {
  return {
    id,
    textContent: '',
    value: '',
    checked: false,
    indeterminate: false,
    disabled: false,
    hidden: false,
    attributes: {},
    listeners: {},
    style: {
      setProperty(k, v) { this[k] = v; },
      display: '',
    },
    classList: {
      tokens: new Set(),
      add(cls) { this.tokens.add(cls); },
      remove(cls) { this.tokens.delete(cls); },
      contains(cls) { return this.tokens.has(cls); },
    },
    children: [],
    get lastChild() { return this.children.at(-1); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    },
    dispatchEvent(type, eventObj = {}) {
      const handlers = this.listeners[type] || [];
      for (const fn of handlers) fn({ target: this, ...eventObj });
    },
    focus() { this.focused = true; },
  };
}

function createUiEnv(cqOverrides = {}) {
  const elements = Object.fromEntries(
    [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, createElement(id)])
  );
  let stateListener = null;
  const patches = [];
  const cq = {
    getState: () => Promise.resolve({}),
    onState: (fn) => { stateListener = fn; },
    set: (patch) => { patches.push(patch); },
    getDisplays: () => Promise.resolve([]),
    getProfiles: () => Promise.resolve([]),
    getNativeStatus: () => Promise.resolve({ available: false }),
    getStreaming: () => Promise.resolve({ running: false }),
    getStartupStatus: () => Promise.resolve({
      supported: true,
      available: true,
      configured: false,
      approved: null,
      enabled: false,
      error: null,
    }),
    setStartup: () => Promise.resolve({
      ok: true,
      configured: true,
      approved: true,
      enabled: true,
      error: null,
    }),
    ...cqOverrides,
  };

  const windowListeners = {};
  const mockWindow = {
    cq,
    addEventListener(type, fn) { windowListeners[type] = fn; },
    location: { hash: '#crosshairs' },
  };

  const mockDocument = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    body: createElement('body'),
  };

  vm.runInNewContext(testUiSource, {
    window: mockWindow,
    document: mockDocument,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
  });

  return {
    elements,
    cq,
    windowListeners,
    getStateListener: () => stateListener,
    patches,
    getInternalStartupStatus: () => mockWindow.__getStartupStatus?.(),
  };
}

test('preload contracts expose getStartupStatus and setStartup', () => {
  let exposed;
  const invocations = [];
  vm.runInNewContext(preloadSource, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, api) { exposed = api; } },
        ipcRenderer: {
          invoke(...args) { invocations.push(args); return Promise.resolve(); },
          send() {},
          on() {},
        },
      };
    },
  });

  assert.ok(exposed, 'window.cq must be exposed');
  assert.equal(typeof exposed.getStartupStatus, 'function', 'getStartupStatus exposed');
  assert.equal(typeof exposed.setStartup, 'function', 'setStartup exposed');

  exposed.getStartupStatus();
  assert.equal(invocations[0][0], 'cq:get-startup-status');

  exposed.setStartup(true);
  assert.equal(invocations[1][0], 'cq:set-startup');
  assert.equal(invocations[1][1], true);

  exposed.setStartup(false);
  assert.equal(invocations[2][0], 'cq:set-startup');
  assert.equal(invocations[2][1], false);
});

test('index.html structure for startup and tray', () => {
  const ids = [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate IDs in index.html');

  assert.match(htmlSource, /id="optionStartWithWindows"[^>]*aria-label="Iniciar com o Windows"[^>]*disabled/);
  assert.match(htmlSource, /id="optionStartMinimized"[^>]*aria-label="Iniciar minimizado"[^>]*disabled/);
  assert.match(htmlSource, /id="optionMinimizeToTray"[^>]*aria-label="Minimizar para bandeja"/);
  assert.match(htmlSource, /id="startupStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(htmlSource, /id="trayStatus"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('startup and tray renderer behavior', async () => {
  const elements = Object.fromEntries(
    [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, createElement(id)])
  );

  let startupStatusResult = {
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  };
  let setStartupResult = null;
  let getStartupCalls = 0;
  let setStartupCalls = [];
  let stateListener = null;
  let patches = [];

  const cq = {
    getState: () => Promise.resolve({}),
    onState: (fn) => { stateListener = fn; },
    set: (patch) => { patches.push(patch); },
    getDisplays: () => Promise.resolve([]),
    getProfiles: () => Promise.resolve([]),
    getNativeStatus: () => Promise.resolve({ available: false }),
    getStreaming: () => Promise.resolve({ running: false }),
    getStartupStatus: async () => {
      getStartupCalls++;
      return startupStatusResult;
    },
    setStartup: async (enabled) => {
      setStartupCalls.push(enabled);
      return setStartupResult;
    },
  };

  const windowListeners = {};
  const mockWindow = {
    cq,
    addEventListener(type, fn) { windowListeners[type] = fn; },
    location: { hash: '#crosshairs' },
  };

  const mockDocument = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: (sel) => {
      if (sel === '.page') return [];
      if (sel === '[data-route]') return [];
      return [];
    },
    createElement: (tag) => createElement(tag),
    body: createElement('body'),
  };

  vm.runInNewContext(testUiSource, {
    window: mockWindow,
    document: mockDocument,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
  });

  const optStart = elements.optionStartWithWindows;
  const statusStart = elements.startupStatus;
  const optTray = elements.optionMinimizeToTray;
  const statusTray = elements.trayStatus;

  assert.ok(optStart, 'optionStartWithWindows element exists');
  assert.ok(statusStart, 'startupStatus element exists');
  assert.ok(optTray, 'optionMinimizeToTray element exists');
  assert.ok(statusTray, 'trayStatus element exists');

  // Let initial microtasks complete
  await new Promise((r) => setImmediate(r));

  // 1. Initial boot sync
  assert.ok(getStartupCalls >= 1, 'initial boot fetches startup status');
  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Desativado/);

  // 2. Status with enabled: true
  startupStatusResult = {
    supported: true,
    available: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  };
  // Simulate page change or focus to trigger sync
  windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, true);
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Ativado/);

  // 3. Status with configured: true, approved: false (disabled in Task Manager)
  startupStatusResult = {
    supported: true,
    available: true,
    configured: true,
    approved: false,
    enabled: false,
    error: null,
  };
  windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, false);
  assert.match(statusStart.textContent, /Gerenciador de Tarefas/);

  // 4. Status unknown: enabled: null, indeterminate: true
  startupStatusResult = {
    supported: true,
    available: true,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Consulta pendente',
  };
  windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.indeterminate, true);
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Consulta pendente/);

  // 5. Status unsupported or unavailable: disabled
  startupStatusResult = {
    supported: false,
    available: false,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Não suportado no Linux',
  };
  windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.disabled, true);
  assert.match(statusStart.textContent, /Não suportado no Linux/);

  // 6. User sets startup: successful enable
  startupStatusResult = {
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  };
  windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));

  setStartupResult = {
    ok: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));
  assert.equal(setStartupCalls.at(-1), true);
  assert.equal(optStart.checked, true);
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Ativado/);

  // 7. Rollback best effort when ok: false
  // User attempts to disable, backend returns ok: false with enabled remaining true
  setStartupResult = {
    ok: false,
    configured: true,
    approved: true,
    enabled: true,
    error: 'Acesso negado ao registro',
  };
  optStart.checked = false; // User tried to uncheck
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));
  assert.equal(setStartupCalls.at(-1), false);
  // UI MUST rollback to effective state (true), NOT keep requested (false)!
  assert.equal(optStart.checked, true, 'UI must rollback to effective state on ok: false');
  assert.match(statusStart.textContent, /Acesso negado ao registro/);

  // 8. Error injection security: textContent used, no HTML tag injection
  setStartupResult = {
    ok: false,
    configured: false,
    approved: null,
    enabled: false,
    error: '<img src=x onerror=alert(1)>',
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));
  assert.equal(statusStart.textContent.includes('<img src=x onerror=alert(1)>'), true);
  assert.equal(statusStart.markup, undefined, 'no innerHTML assignment');

  // 9. Minimize to tray from state snapshot
  assert.ok(stateListener, 'state listener registered');

  // Snapshot with minimizeToTray: false (respect false, DO NOT convert to true via ||)
  stateListener({
    minimizeToTray: false,
    trayStatus: { available: true, error: null },
  });
  assert.equal(optTray.checked, false, 'minimizeToTray: false must be respected');
  assert.equal(optTray.disabled, false);

  // Snapshot with minimizeToTray: true
  stateListener({
    minimizeToTray: true,
    trayStatus: { available: true, error: null },
  });
  assert.equal(optTray.checked, true, 'minimizeToTray: true checked');
  assert.equal(optTray.disabled, false);

  // Snapshot with trayStatus: available: false -> disable control and show error
  stateListener({
    minimizeToTray: true,
    trayStatus: { available: false, error: 'Ícone não pôde ser criado' },
  });
  assert.equal(optTray.disabled, true, 'unavailable tray disables toggle');
  assert.match(statusTray.textContent, /Ícone não pôde ser criado/);

  // User toggles minimizeToTray
  stateListener({
    minimizeToTray: true,
    trayStatus: { available: true, error: null },
  });
  optTray.checked = false;
  optTray.dispatchEvent('change');
  assert.equal(patches.at(-1).minimizeToTray, false, 'dispatches cq:set with minimizeToTray');

  // 10. Race condition prevention between initial get and subsequent set
  let resolveSlowGet;
  cq.getStartupStatus = () => new Promise((resolve) => {
    resolveSlowGet = resolve;
  });
  // Trigger get (e.g. on focus)
  windowListeners.focus?.();

  // User triggers setStartup(true) before slow get resolves
  cq.setStartup = async () => ({
    ok: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  });
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, true, 'setStartup applied');

  // Slow get resolves now with stale enabled: false
  resolveSlowGet({
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, true, 'stale get response must NOT overwrite newer set result');
});

test('startup status query rejection on boot and after known status', async () => {
  let rejectGet = true;
  let getError = new Error('Falha IPC boot');
  let statusResult = null;

  const env = createUiEnv({
    getStartupStatus: async () => {
      if (rejectGet) throw getError;
      return statusResult;
    },
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;

  // Let initial microtasks complete (boot)
  await new Promise((r) => setImmediate(r));

  // 1. Initial boot rejection:
  // Must NOT assume Windows supported: true or supported: false
  assert.equal(optStart.checked, false, 'not checked');
  assert.equal(optStart.indeterminate, true, 'indeterminate (does NOT affirm off)');
  assert.equal(optStart.disabled, false, 'busy released for retry');
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Falha IPC boot/);
  assert.doesNotMatch(statusStart.textContent, /^Desativado\./);

  // 2. Status becomes known and active
  rejectGet = false;
  statusResult = {
    supported: true,
    available: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  };
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, true);
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Ativado/);

  // 3. Subsequent query rejects:
  // Known supported: true is preserved, status becomes unknown/indeterminate, busy released
  rejectGet = true;
  getError = new Error('Falha IPC subsequente');
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, true);
  assert.equal(optStart.disabled, false, 'busy released');
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Falha IPC subsequente/);

  // 4. Known unavailable status:
  // Backend returns confirmed available: false
  rejectGet = false;
  statusResult = {
    supported: true,
    available: false,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Indisponível em desenvolvimento.',
  };
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.disabled, true);
  assert.equal(optStart.indeterminate, false);
  assert.match(statusStart.textContent, /Indisponível em desenvolvimento/);

  // Subsequent query rejects: confirmed unavailable MUST REMAIN disabled!
  rejectGet = true;
  getError = new Error('Falha IPC pós-indisponível');
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.disabled, true, 'confirmed unavailable backend remains disabled on query error');
  assert.equal(optStart.indeterminate, false);
});

test('setStartup rejection recovery (success, error, dedup, both reject)', async () => {
  let getResult = {
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  };
  let getError = null;
  let setError = null;

  const env = createUiEnv({
    getStartupStatus: async () => {
      if (getError) throw getError;
      return getResult;
    },
    setStartup: async () => {
      if (setError) throw setError;
      return { ok: true, configured: true, approved: true, enabled: true, error: null };
    },
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;
  await new Promise((r) => setImmediate(r));

  // Case A: set rejects, recovery get succeeds with enabled: false, error: null
  setError = new Error('Acesso negado');
  getError = null;
  getResult = {
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.checked, false, 'checkbox reflects effective state from get');
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false, 'busy released');
  assert.match(statusStart.textContent, /Falha ao alterar início automático: Acesso negado/);

  // Case B: set rejects, recovery get succeeds but returns fresh.error
  setError = new Error('Erro de escrita no registro');
  getError = null;
  getResult = {
    supported: true,
    available: true,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Aviso de leitura do SO',
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.disabled, false, 'busy released');
  assert.match(statusStart.textContent, /Falha ao alterar início automático: Erro de escrita no registro/);
  assert.match(statusStart.textContent, /Consulta: Aviso de leitura do SO/, 'preserves query error without hiding write error');

  // Case C: Dedup when fresh.error matches write error
  setError = new Error('Mesmo erro');
  getError = null;
  getResult = {
    supported: true,
    available: true,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Mesmo erro',
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Falha ao alterar início automático: Mesmo erro/);
  assert.doesNotMatch(statusStart.textContent, /Consulta: Mesmo erro/, 'dedups identical error');

  // Case D: Both set and recovery get reject
  setError = new Error('Falha catastrófica de escrita');
  getError = new Error('Falha catastrófica de leitura');
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.disabled, false, 'busy released for retry');
  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, true, 'indeterminate on total failure');
  assert.match(statusStart.textContent, /Falha ao alterar início automático: Falha catastrófica de escrita/);
});

test('older rejected recovery get does not overwrite newer state', async () => {
  let slowRejectFn = null;
  let isSlowGet = false;
  let statusResult = {
    supported: true,
    available: true,
    configured: false,
    approved: null,
    enabled: false,
    error: null,
  };

  const env = createUiEnv({
    getStartupStatus: async () => {
      if (isSlowGet) {
        return new Promise((_, reject) => {
          slowRejectFn = () => reject(new Error('Slow recovery get failed'));
        });
      }
      return statusResult;
    },
    setStartup: async () => {
      throw new Error('Initial set failed');
    },
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;
  await new Promise((r) => setImmediate(r));

  // Trigger set that fails, initiating a slow recovery get
  isSlowGet = true;
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  // Recovery get is now pending.
  // Meanwhile, a new query arrives (e.g. from focus) and succeeds with enabled: true
  isSlowGet = false;
  statusResult = {
    supported: true,
    available: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  };
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.checked, true);
  assert.match(statusStart.textContent, /Ativado/);

  // Now the older slow recovery get finally rejects!
  assert.ok(slowRejectFn, 'slow recovery reject callback must exist');
  slowRejectFn();
  await new Promise((r) => setImmediate(r));

  // Seq guard must ensure the newer state is NOT overwritten by the old rejection fallback
  assert.equal(optStart.checked, true, 'checked remains true');
  assert.equal(optStart.indeterminate, false);
  assert.match(statusStart.textContent, /Ativado/, 'must retain latest status');
});

test('focus and navigation during in-flight setStartup does not invalidate write', async () => {
  let resolveSet;
  let getCalls = 0;

  const env = createUiEnv({
    getStartupStatus: async () => {
      getCalls++;
      return {
        supported: true,
        available: true,
        configured: false,
        approved: null,
        enabled: false,
        error: null,
      };
    },
    setStartup: () => new Promise((resolve) => {
      resolveSet = resolve;
    }),
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;
  await new Promise((r) => setImmediate(r));
  const initialGetCalls = getCalls;

  // User initiates setStartup (in flight)
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.disabled, true, 'busy during mutation');

  // Focus event occurs during in-flight setStartup
  env.windowListeners.focus?.();
  await new Promise((r) => setImmediate(r));

  // Ensure syncStartupStatus did not run concurrent get
  assert.equal(getCalls, initialGetCalls, 'focus during set mutation must not trigger concurrent get');

  // Now setStartup resolves with enabled: true
  resolveSet({
    ok: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.checked, true, 'write result preserved');
  assert.equal(optStart.indeterminate, false);
  assert.equal(optStart.disabled, false, 'busy released');
  assert.match(statusStart.textContent, /Ativado/);
});

test('regression: boot get rejection followed by setStartup ok: false keeps supported and available unknown', async () => {
  let rejectGet = true;
  let getError = new Error('Falha IPC boot');
  let setStartupResult = {
    ok: false,
    configured: null,
    approved: null,
    enabled: null,
    error: 'Acesso negado no registro',
  };

  const env = createUiEnv({
    getStartupStatus: async () => {
      if (rejectGet) throw getError;
      return {
        supported: true,
        available: true,
        configured: false,
        approved: null,
        enabled: false,
        error: null,
      };
    },
    setStartup: async () => setStartupResult,
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;

  // Let initial microtasks complete (boot get rejects)
  await new Promise((r) => setImmediate(r));

  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, true);
  assert.equal(optStart.disabled, false);
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Falha IPC boot/);

  // Check internal state: supported and available must be unknown (null)
  let internal = env.getInternalStartupStatus();
  assert.equal(internal.supported, null, 'boot failure leaves supported as null');
  assert.equal(internal.available, null, 'boot failure leaves available as null');
  assert.equal(internal.enabled, null, 'boot failure leaves enabled as null');

  // User attempts to toggle, setStartup returns ok: false
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  // Must NOT convert unknown supported/available into true on ok: false!
  internal = env.getInternalStartupStatus();
  assert.equal(internal.supported, null, 'failed set does not convert unknown supported to true');
  assert.equal(internal.available, null, 'failed set does not convert unknown available to true');
  assert.equal(internal.enabled, null);
  assert.equal(internal.error, 'Acesso negado no registro');

  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, true, 'indeterminate preserved');
  assert.equal(optStart.disabled, false, 'busy released for retry');
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Acesso negado no registro/);

  // If setStartup succeeds (ok: true), supported and available DO become true
  setStartupResult = {
    ok: true,
    configured: true,
    approved: true,
    enabled: true,
    error: null,
  };
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  internal = env.getInternalStartupStatus();
  assert.equal(internal.supported, true, 'successful set confirms supported is true');
  assert.equal(internal.available, true, 'successful set confirms available is true');
  assert.equal(internal.enabled, true);
  assert.equal(optStart.checked, true);
  assert.equal(optStart.indeterminate, false);
  assert.match(statusStart.textContent, /Ativado/);

  // Subsequent failed set now preserves confirmed supported: true
  setStartupResult = {
    ok: false,
    configured: true,
    approved: true,
    enabled: true,
    error: 'Falha secundária',
  };
  optStart.checked = false;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  internal = env.getInternalStartupStatus();
  assert.equal(internal.supported, true, 'confirmed supported: true preserved across failed set');
  assert.equal(internal.available, true, 'confirmed available: true preserved across failed set');
});

test('regression: setStartup rejection recovery when getStartupStatus resolves null does not throw and preserves error + indeterminate', async () => {
  let isRecoveryGet = false;
  const env = createUiEnv({
    getStartupStatus: async () => {
      if (isRecoveryGet) {
        return null; // resolves null!
      }
      return {
        supported: true,
        available: true,
        configured: false,
        approved: null,
        enabled: false,
        error: null,
      };
    },
    setStartup: async () => {
      throw new Error('Falha catastrófica de escrita');
    },
  });

  const optStart = env.elements.optionStartWithWindows;
  const statusStart = env.elements.startupStatus;

  // Let initial microtasks complete (boot succeeds with known capabilities)
  await new Promise((r) => setImmediate(r));
  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, false);
  assert.equal(env.getInternalStartupStatus().supported, true);
  assert.equal(env.getInternalStartupStatus().available, true);

  // Trigger setStartup which throws; secondary getStartupStatus resolves null
  isRecoveryGet = true;
  optStart.checked = true;
  optStart.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  // Must not throw, must preserve known capabilities, explicitly set enabled: null,
  // and keep write error visible in indeterminate state
  const internal = env.getInternalStartupStatus();
  assert.equal(internal.supported, true, 'preserves known supported capability');
  assert.equal(internal.available, true, 'preserves known available capability');
  assert.equal(internal.enabled, null, 'enabled explicitly null when fresh is null');
  assert.match(internal.error, /Falha ao alterar início automático: Falha catastrófica de escrita/);

  assert.equal(optStart.checked, false);
  assert.equal(optStart.indeterminate, true, 'indeterminate preserved on recovery get returning null');
  assert.equal(optStart.disabled, false, 'busy released for retry');
  assert.match(statusStart.textContent, /Desconhecido/);
  assert.match(statusStart.textContent, /Falha ao alterar início automático: Falha catastrófica de escrita/);

  // Also verify case where capabilities were initially unknown (null) and recovery get resolves null
  let isRecoveryGetNull = false;
  const env2 = createUiEnv({
    getStartupStatus: async () => {
      if (isRecoveryGetNull) return null;
      throw new Error('Falha boot');
    },
    setStartup: async () => {
      throw new Error('Falha escrita sem capacidades prévias');
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(env2.getInternalStartupStatus().supported, null);

  isRecoveryGetNull = true;
  env2.elements.optionStartWithWindows.checked = true;
  env2.elements.optionStartWithWindows.dispatchEvent('change');
  await new Promise((r) => setImmediate(r));

  const internal2 = env2.getInternalStartupStatus();
  assert.equal(internal2.supported, null, 'supported remains null');
  assert.equal(internal2.available, null, 'available remains null');
  assert.equal(internal2.enabled, null, 'enabled explicitly null');
  assert.match(internal2.error, /Falha ao alterar início automático: Falha escrita sem capacidades prévias/);
  assert.equal(env2.elements.optionStartWithWindows.indeterminate, true);
});

test('startMinimized operates independently from startup with windows', async () => {
  const env = createUiEnv();
  await new Promise((r) => setImmediate(r));

  // 1. Dynamic enablement on boot:
  assert.equal(env.elements.optionStartMinimized.disabled, false, 'optionStartMinimized enabled on boot');

  // 2. Dispatch change event to toggle startMinimized:
  env.elements.optionStartMinimized.checked = true;
  env.elements.optionStartMinimized.dispatchEvent('change');
  assert.equal(env.patches.at(-1)?.startMinimized, true, 'patches startMinimized: true');

  // 3. State reception:
  env.getStateListener()({ startMinimized: true });
  assert.equal(env.elements.optionStartMinimized.checked, true, 'DOM reflects state startMinimized: true');

  env.getStateListener()({ startMinimized: false });
  assert.equal(env.elements.optionStartMinimized.checked, false, 'DOM reflects state startMinimized: false');
});
