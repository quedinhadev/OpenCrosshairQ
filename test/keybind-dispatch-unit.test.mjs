import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createKeybindDispatcher, controllerDown } = require('../src/main/keybind-dispatch');
const { DEFAULTS } = require('../src/main/state');
let bindings, events, dispatcher;
function setup() {
  bindings = structuredClone(DEFAULTS.keybinds); events = [];
  dispatcher = createKeybindDispatcher(() => bindings, event => events.push(event));
  dispatcher.keyboard({ running: true, keys: {} });
  dispatcher.input(raw(false)); events.length = 0;
}
function raw(pressed, downCount = 0, controllers = []) {
  return { available: true, mouse: { left: { pressed, downCount } }, controllers };
}
const pad = (buttons = 0, rightTrigger = 0) => [{ connected: true, buttons, rightTrigger }];
const edge = (action, pressed) => ({ action, pressed });
setup();
dispatcher.input(raw(true, 1)); dispatcher.input(raw(true, 1, pad(0, 1)));
dispatcher.input(raw(false, 1, pad(0, 1))); dispatcher.input(raw(false, 1));
assert.deepEqual(events, [edge('fire', true), edge('fire', false)], 'hold agregado: segunda fonte não duplica nem solta antes da última');
setup(); dispatcher.input(raw(false, 3));
assert.deepEqual(events, Array.from({ length: 3 }, () => [edge('fire', true), edge('fire', false)]).flat(), 'taps completos entre polls preservados');
setup(); dispatcher.input(raw(true, 1)); dispatcher.input(raw(true, 2));
assert.deepEqual(events, [edge('fire', true), edge('fire', false), edge('fire', true)], 'tap coalescido com hold final mantém bordas válidas');
setup(); bindings.fire.pc.modifiers = ['Shift'];
dispatcher.input(raw(true, 1)); assert.equal(events.length, 0);
dispatcher.keyboard({ running: true, keys: { 0xa1: { pressed: true } } });
assert.deepEqual(events, [edge('fire', true)], 'mouse remapeado respeita Shift direito');
dispatcher.keyboard({ running: true, keys: {} });
assert.deepEqual(events.at(-1), edge('fire', false));
dispatcher.input(raw(false, 1, pad(0, 1)));
assert.deepEqual(events.at(-1), edge('fire', true), 'controle independente de modificador PC');
setup(); bindings.fire.controller.key = 'faceNorth';
dispatcher.input(raw(false, 0, pad(0, 1))); assert.equal(events.length, 0);
dispatcher.input(raw(false, 0, pad(0x8000)));
assert.deepEqual(events, [edge('fire', true)], 'controle usa nome configurado, não trigger fixo');
assert.equal(controllerDown('toString', pad(1)), false);
setup(); dispatcher.capture(true); dispatcher.input(raw(true, 1)); dispatcher.capture(false);
events.length = 0; dispatcher.input(raw(true, 1)); assert.equal(events.length, 0);
dispatcher.input(raw(false, 1)); dispatcher.input(raw(true, 2));
assert.deepEqual(events, [edge('fire', true)], 'fim captura bloqueia held até release');
setup(); bindings.fire.pc.modifiers = ['Shift']; dispatcher.input(raw(true, 1)); dispatcher.reset(); events.length = 0;
dispatcher.keyboard({ running: true, keys: { 0xa0: { pressed: true } } });
assert.equal(events.length, 0, 'reset bloqueia tecla física mesmo antes do modificador');
setup(); dispatcher.input(raw(true, 1)); dispatcher.input({ available: false, mouse: {}, controllers: [] });
events.length = 0; dispatcher.input(raw(true, 7));
assert.deepEqual(events, [edge('fire', true)], 'recuperação hold retoma sem replay histórico');
setup(); bindings.fire.pressType = 'toggle'; dispatcher.input(raw(true, 1));
dispatcher.input({ available: false }); events.length = 0;
dispatcher.input(raw(true, 9)); assert.equal(events.length, 0, 'recuperação toggle só baseline');
dispatcher.input(raw(false, 9)); dispatcher.input(raw(true, 10));
assert.deepEqual(events, [edge('fire', true)]);
setup(); bindings.aim.pc = { key: 'F23', modifiers: ['Ctrl'] };
const chord = count => ({ running: true, keys: { 134: { pressed: true, downCount: count }, 163: { pressed: true, downCount: count } } });
dispatcher.keyboard(chord(1)); dispatcher.reset(); events.length = 0;
// Native release + next press fit between two polls. Counter proves a new physical edge.
dispatcher.keyboard(chord(2));
assert.deepEqual(events, [edge('aim', true)], 'novo downCount desbloqueia reset com snapshot antigo held sem exigir release separado');
dispatcher.reset(); events.length = 0; dispatcher.keyboard(chord(2));
assert.equal(events.length, 0, 'mesmo downCount held continua bloqueado');
// Native counters count physical transitions, not repeated DOWN notifications.
for (const action of ['aim', 'reload']) {
  setup(); bindings[action].pc = { key: 'K', modifiers: [] };
  bindings[action].pressType = action === 'aim' ? 'toggle' : 'press';
  const key = (pressed, downCount) => ({ running: true, keys: { 75: { pressed, downCount } } });
  dispatcher.keyboard(key(true, 1)); dispatcher.keyboard(key(true, 1)); dispatcher.keyboard(key(false, 1));
  assert.equal(events.filter(event => event.action === action && event.pressed).length, 1, `${action}: DOWN/DOWN/UP activates once`);
  setup(); bindings[action].pc = { key: 'K', modifiers: [] };
  bindings[action].pressType = action === 'aim' ? 'toggle' : 'press';
  dispatcher.capture(true); dispatcher.keyboard(key(true, 1)); dispatcher.capture(false);
  events.length = 0;
  dispatcher.keyboard(key(true, 1)); dispatcher.keyboard(key(true, 1));
  assert.deepEqual(events, [], `${action}: repeated DOWN after capture stays blocked`);
  dispatcher.keyboard(key(false, 1)); dispatcher.keyboard(key(true, 2));
  assert.deepEqual(events, [edge(action, true)], `${action}: release + DOWN activates again`);
  dispatcher.reset(); events.length = 0;
  dispatcher.keyboard(key(true, 3));
  assert.deepEqual(events, [edge(action, true)], `${action}: complete release/press between polls unlocks reset`);
}
console.log('PASS: dispatcher taps, multi-fontes, captura, modificadores, remap controle, recuperação e transições sem autorepeat');
