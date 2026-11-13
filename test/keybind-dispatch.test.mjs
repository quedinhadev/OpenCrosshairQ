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
  let onKeyboard = null;
  // Structured clone through JSON: payloads are created inside the VM realm, so
  // their prototypes differ from the test realm.
  const actions = () => JSON.parse(JSON.stringify(sends.filter((entry) => entry.channel === 'cq:action').map((entry) => entry.state)));
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  class Window {
    constructor() { this.webContents = { mainFrame: {}, send: (channel, state) => sends.push({ channel, state }), setZoomFactor() {} }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} setContentProtection() {} loadFile() {} once() {} on() {} setBounds() {} isDestroyed() { return false; }
  }
  const app = { isPackaged: false, getVersion: () => '0.1.0', whenReady: () => Promise.resolve(), getPath: () => dir, once() {}, on() {} };
  const electron = {
    app, BrowserWindow: Window, Tray: null, Menu: null, dialog: {},
    ipcMain: { on: (c, f) => events.set(c, f), handle: (c, f) => handlers.set(c, f) },
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, on() {} },
  };
  const foreground = () => ({ getStatus: () => ({ available: false, foreground: null }), start() {}, stop() {} });
  const mouse = () => ({ getStatus: () => ({}), start() {}, stop() {} });
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
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
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
  assert.deepEqual(actions().at(-1), { action: 'aim', pressed: false }, 'troca de keybinds reseta o hold');
  sends.length = 0;
  onKeyboard(status(down('K')));
  assert.deepEqual(actions(), [{ action: 'aim', pressed: true }], 'nova borda após reset republica');
  onKeyboard(status(down('K')));
  assert.equal(actions().length, 1, 'repetição não duplica após reset');

  // Modificador ausente não dispara mesmo com a tecla pressionada.
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
  assert.deepEqual(actions().at(-1), { action: 'aim', pressed: false }, 'monitor caído libera o hold');

  console.log('PASS: dispatch de atalhos (hold/toggle, reload one-shot, disabled, reset, modificadores)');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
