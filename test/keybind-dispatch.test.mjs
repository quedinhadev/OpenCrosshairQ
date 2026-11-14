// Regressão dos atalhos de ação: o hook passivo de teclado alimenta o main,
// que despacha cq:action ao overlay apenas em transições (hold real, reload
// one-shot, binding desativado e troca de keybinds resetando o estado).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const localRequire = createRequire(new URL('../src/main/main.js', import.meta.url));
const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });

const dir = fs.mkdtempSync(path.join(tempRoot, 'cq-keybind-dispatch-'));
try {
  const handlers = new Map();
  const events = new Map();
  const sends = [];
  let onKeyboard = null, onInput = null, globalToggle = null;
  let captureTimeout = null;
  const windows = [];
  const quitHandlers = [];
  // Structured clone through JSON: payloads are created inside the VM realm, so
  // their prototypes differ from the test realm.
  const actions = () => JSON.parse(JSON.stringify(sends.filter((entry) => entry.channel === 'cq:action').map((entry) => entry.state)));
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  class Window {
    constructor() {
      windows.push(this); this.events = new Map(); this.rendererEvents = new Map();
      this.webContents = { mainFrame: {}, on: (name, fn) => this.rendererEvents.set(name, fn), send: (channel, state) => sends.push({ channel, state }), setZoomFactor() {} };
    }
    on(name, fn) { this.events.set(name, fn); }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} setContentProtection() {} loadFile() {} once() {} setBounds() {} isDestroyed() { return false; }
  }
  const app = { isPackaged: false, getVersion: () => '0.1.0', whenReady: () => Promise.resolve(), getPath: () => dir, once: (name, fn) => { if (name === 'before-quit') quitHandlers.push(fn); }, on() {} };
  const electron = {
    app, BrowserWindow: Window, Tray: null, Menu: null, dialog: {},
    ipcMain: { on: (c, f) => events.set(c, f), handle: (c, f) => handlers.set(c, f) },
    globalShortcut: { register: (_combo, fn) => { globalToggle = fn; return true; }, unregister() {}, unregisterAll() {} },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, on() {} },
  };
  const foreground = () => ({ getStatus: () => ({ available: false, foreground: null }), start() {}, stop() {} });
  const mouse = (_native, callback) => { onInput = callback; return { getStatus: () => ({}), start() {}, stop() { throw new Error('mouse stop failed'); } }; };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './foreground') return { createForegroundMonitor: foreground };
      if (name === './input') {
        return {
          createInputMonitor: mouse,
          createKeyboardMonitor: (_native, onChange) => {
            onKeyboard = onChange;
            return { getStatus: () => ({ running: false, error: null, keys: {} }), start() {}, stop() {} };
          },
        };
      }
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'), process: { platform: 'win32', env: {} }, console,
    setTimeout: (fn, delay) => { if (delay === 30000) captureTimeout = fn; return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof onKeyboard, 'function', 'main assina o monitor de teclado');

  const send = (channel, payload) => events.get(channel)({}, payload);
  const VK = { K: 0x4b, F: 0x46, R: 0x52 };
  const status = (keys) => ({ running: true, error: null, keys });
  const down = (name) => ({ [VK[name]]: { pressed: true, downCount: 1, upCount: 0 } });
  const up = (name) => ({ [VK[name]]: { pressed: false, downCount: 1, upCount: 1 } });

  // Atalhos de ação remapeados para teclas simples.
  send('cq:set', {
    keybinds: {
      aim: { enabled: true, pressType: 'hold', pc: { modifiers: [], key: 'K' } },
      fire: { enabled: true, pc: { modifiers: [], key: 'F' } },
      reload: { enabled: true, pc: { modifiers: [], key: 'R' } },
    },
  });
  sends.length = 0;

  onKeyboard(status(down('K')));
  assert.deepEqual(actions(), [{ action: 'aim', pressed: true }], 'segurar aim publica press');
  onKeyboard(status(down('K')));
  assert.equal(actions().length, 1, 'snapshot repetido não republica');
  onKeyboard(status(up('K')));
  assert.deepEqual(actions().at(-1), { action: 'aim', pressed: false }, 'soltar aim publica release');

  onKeyboard(status(down('F')));
  assert.deepEqual(actions().at(-1), { action: 'fire', pressed: true });
  onKeyboard(status(up('F')));
  assert.deepEqual(actions().at(-1), { action: 'fire', pressed: false });

  onKeyboard(status(down('R')));
  assert.deepEqual(actions().at(-1), { action: 'reload', pressed: true });
  const afterReload = actions().length;
  onKeyboard(status(up('R')));
  assert.equal(actions().length, afterReload, 'reload é one-shot: release não publica');

  // Binding desativado não dispara.
  send('cq:set', {
    keybinds: {
      aim: { enabled: true, pressType: 'hold', pc: { modifiers: [], key: 'K' } },
      fire: { enabled: false, pc: { modifiers: [], key: 'F' } },
      reload: { enabled: true, pc: { modifiers: [], key: 'R' } },
    },
  });
  sends.length = 0;
  onKeyboard(status(down('F')));
  assert.equal(actions().length, 0, 'atalho desativado fica inerte');

  // Troca de keybinds solta o estado: nada fica preso entre perfis.
  onKeyboard(status(down('K')));
  assert.deepEqual(actions().at(-1), { action: 'aim', pressed: true });
  send('cq:set', {
    keybinds: {
      aim: { enabled: true, pressType: 'toggle', pc: { modifiers: [], key: 'K' } },
      fire: { enabled: true, pc: { modifiers: [], key: 'F' } },
      reload: { enabled: true, pc: { modifiers: [], key: 'R' } },
    },
  });
  assert.deepEqual(actions().at(-1), { action: 'reset', pressed: false }, 'troca de keybinds reseta todos os latches');
  sends.length = 0;
  onKeyboard(status(down('K')));
  assert.deepEqual(actions(), [], 'reset bloqueia tecla já segurada');
  onKeyboard(status(up('K')));
  onKeyboard(status({ [VK.K]: { pressed: true, downCount: 2 } }));
  assert.deepEqual(actions(), [{ action: 'aim', pressed: true }], 'nova borda após soltar republica');
  onKeyboard(status(down('K')));
  assert.equal(actions().length, 1, 'repetição não duplica após reset');

  // Modificador ausente não dispara mesmo com a tecla pressionada.
  onKeyboard(status(up('K')));
  send('cq:set', {
    keybinds: {
      aim: { enabled: true, pressType: 'hold', pc: { modifiers: ['Shift'], key: 'K' } },
      fire: { enabled: true, pc: { modifiers: [], key: 'F' } },
      reload: { enabled: true, pc: { modifiers: [], key: 'R' } },
    },
  });
  sends.length = 0;
  onKeyboard(status(down('K')));
  assert.equal(actions().length, 0, 'modificador exigido precisa estar pressionado');
  onKeyboard(status({ ...down('K'), 0x10: { pressed: true, downCount: 1, upCount: 0 } }));
  assert.deepEqual(actions().at(-1), { action: 'aim', pressed: true }, 'com Shift pressionado dispara');

  // Falha do hook não derruba o despacho (status inválido = nada pressionado).
  onKeyboard({ running: false, error: 'hook lost', keys: down('K') });
  assert.deepEqual(actions().at(-1), { action: 'reset', pressed: false }, 'monitor caído limpa todos os latches');

  const ui = windows[0];
  const captureEvent = { sender: ui.webContents, senderFrame: ui.webContents.mainFrame };
  const capture = value => events.get('cq:keybind-capture')(captureEvent, value);
  sends.length = 0;
  events.get('cq:keybind-capture')({ sender: windows[1].webContents, senderFrame: windows[1].webContents.mainFrame }, true);
  events.get('cq:keybind-capture')({ sender: ui.webContents, senderFrame: {} }, true);
  capture('true'); assert.equal(actions().length, 0, 'IPC rejeita overlay, subframe e boolean não estrito');
  capture(true); assert.deepEqual(actions().at(-1), { action: 'reset', pressed: false });
  const hiddenBefore = handlers.get('cq:get-state')().hidden;
  globalToggle(); assert.equal(handlers.get('cq:get-state')().hidden, hiddenBefore, 'atalho global suspenso durante captura');
  onKeyboard(status({ ...down('K'), 0x10: { pressed: true } }));
  capture(false); sends.length = 0;
  onKeyboard(status({ ...down('K'), 0x10: { pressed: true } }));
  assert.equal(actions().length, 0, 'held capturado não executa no fim');
  for (const cleanup of [() => ui.events.get('blur')(), () => ui.rendererEvents.get('render-process-gone')(), () => captureTimeout()]) {
    capture(true); cleanup();
    const before = handlers.get('cq:get-state')().hidden; globalToggle();
    assert.equal(handlers.get('cq:get-state')().hidden, !before, 'blur/crash/timeout liberam atalho global');
  }
  onInput({ available: true, mouse: {}, controllers: [] });
  assert.doesNotThrow(() => quitHandlers.forEach(fn => fn()), 'mouse stop throw não impede restante cleanup e persistência');
  console.log('PASS: dispatch main + captura autorizada + global guard + blur/crash/timeout + cleanup');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
