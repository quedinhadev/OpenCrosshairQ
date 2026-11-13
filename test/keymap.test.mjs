// Regressão dos atalhos remapeáveis: mapeamento nome→VK usado pelo hook passivo
// de teclado e ciclo de vida do monitor de teclado.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { keyCode, isBindingDown } = require('../src/main/keymap.js');
const { createKeyboardMonitor } = require('../src/main/input.js');

// ---------------------------------------------------------------------------
// 1. keyCode: nomes aceitos pela captura da UI
// ---------------------------------------------------------------------------
assert.equal(keyCode('A'), 0x41);
assert.equal(keyCode('a'), 0x41, 'minúsculas mapeiam igual');
assert.equal(keyCode('5'), 0x35);
assert.equal(keyCode('Space'), 0x20);
assert.equal(keyCode('ArrowLeft'), 0x25);
assert.equal(keyCode('Control'), 0x11);
assert.equal(keyCode('F1'), 0x70);
assert.equal(keyCode('F23'), 0x86);
assert.equal(keyCode('F24'), 0x87);
assert.equal(keyCode('F25'), 0, 'fora do alcance do hook');
assert.equal(keyCode('RightClick'), 0, 'mouse não é observado pelo hook de teclado');
assert.equal(keyCode(''), 0);
assert.equal(keyCode(undefined), 0);
assert.equal(keyCode(42), 0);

// ---------------------------------------------------------------------------
// 2. isBindingDown: tecla + modificadores exigidos
// ---------------------------------------------------------------------------
const keys = { 0x41: { pressed: true }, 0x10: { pressed: true } };
assert.equal(isBindingDown({ pc: { key: 'A', modifiers: [] } }, keys), true);
assert.equal(isBindingDown({ pc: { key: 'A', modifiers: ['Shift'] } }, keys), true);
assert.equal(isBindingDown({ pc: { key: 'A', modifiers: ['Ctrl'] } }, keys), false, 'modificador ausente não dispara');
assert.equal(isBindingDown({ pc: { key: 'B' } }, keys), false);
assert.equal(isBindingDown({ pc: { key: 'A' } }, { 0x41: { pressed: false } }), false);
assert.equal(isBindingDown({ pc: { key: 'RightClick' } }, keys), false, 'mouse nunca vem do hook de teclado');
assert.equal(isBindingDown(null, keys), false);
assert.equal(isBindingDown({ pc: { key: 'A' } }, null), false);

// ---------------------------------------------------------------------------
// 3. createKeyboardMonitor: start idempotente, emissão só em mudança, erro
// ---------------------------------------------------------------------------
let snapshot = { running: true, errorCode: 0, keys: { 65: { pressed: true, downCount: 1, upCount: 0 } } };
let started = 0, stopped = 0;
const changes = [];
const native = {
  startKeyboardInput() { started++; },
  stopKeyboardInput() { stopped++; },
  getKeyboardSnapshot: () => snapshot,
};
const monitor = createKeyboardMonitor(native, (status) => changes.push(status));
monitor.start();
monitor.start();
assert.equal(started, 1, 'start é idempotente');
assert.equal(monitor.getStatus().running, true);
assert.equal(changes.at(-1).keys[65].pressed, true);

const emitted = changes.length;
monitor.poll();
assert.equal(changes.length, emitted, 'snapshot idêntico não reemite');

snapshot = { running: false, errorCode: 5, keys: {} };
monitor.poll();
assert.equal(changes.at(-1).running, false);
assert.match(changes.at(-1).error, /Keyboard input unavailable \(5\)/);

monitor.stop();
monitor.stop();
assert.equal(stopped, 1, 'stop é idempotente');
assert.deepEqual(monitor.getStatus(), { running: false, error: null, keys: {} });

const broken = createKeyboardMonitor({ startKeyboardInput() { throw new Error('hook failed'); } }, () => {});
broken.start();
assert.match(broken.getStatus().error, /hook failed/, 'falha ao instalar o hook fica visível');
broken.stop();

console.log('PASS: keymap VK + modificadores + lifecycle do monitor de teclado passivo');
