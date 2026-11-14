import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInputMonitor } = require('../src/main/input.js');
const { createKeybindDispatcher } = require('../src/main/keybind-dispatch.js');
const { DEFAULTS } = require('../src/main/state.js');
let mouse = { running: true, errorCode: 0, left: { pressed: false, downCount: 0 }, right: { pressed: false, downCount: 0 } };
let pads = { available: true, controllers: [{ connected: false }] };
let starts = 0, stops = 0;
const changes = [];
const native = { startMouseInput() { starts++; }, stopMouseInput() { stops++; }, getMouseSnapshot: () => mouse, getXInputSnapshot: () => pads };
const monitor = createInputMonitor(native, input => changes.push(input));
monitor.start(); monitor.start();
assert.equal(starts, 1);
mouse = { ...mouse, left: { pressed: false, downCount: 1 } };
monitor.poll();
assert.equal(changes.at(-1).left.downCount, 1, 'short clicks survive polling');
assert.equal(changes.at(-1).left.pressed, false);
pads = { available: true, controllers: [{ connected: true, rightTrigger: 20, leftTrigger: 0 }] };
monitor.poll();
assert.equal(changes.at(-1).left.pressed, true);
assert.equal(changes.at(-1).left.downCount, 2);
pads = { available: true, controllers: [{ connected: false, rightTrigger: 0, leftTrigger: 0 }] };
monitor.poll();
assert.equal(changes.at(-1).left.pressed, false, 'disconnect releases hold');
const count = changes.length;
monitor.poll(); assert.equal(changes.length, count);
mouse = { ...mouse, running: false, errorCode: 6 };
monitor.poll();
assert.equal(changes.at(-1).available, true, 'XInput provider can remain available');
monitor.stop(); monitor.stop();
assert.equal(stops, 1);
assert.equal(changes.at(-1).left.pressed, false);
const missing = createInputMonitor(null, () => {});
missing.start(); assert.equal(missing.getStatus().available, false); missing.stop();
const stopFailure = createInputMonitor({ ...native, stopMouseInput() { throw new Error('stop failed'); } }, () => {});
stopFailure.start(); assert.doesNotThrow(() => stopFailure.stop());
assert.equal(stopFailure.getStatus().available, false);
assert.deepEqual(stopFailure.getStatus().mouse, {});
assert.deepEqual(stopFailure.getStatus().controllers, []);
assert.equal(stopFailure.getStatus().error, 'stop failed');
assert.equal(monitor.getStatus().actionsDispatched, true);
// Exercise the real monitor + dispatcher together: one failed provider must not
// discard press/release events from the other, including a loss while held.
for (const failed of ['mouse', 'controllers']) {
  let mouseFailure = null, padFailure = null;
  let mouseState = { running: true, errorCode: 0, left: { pressed: false, downCount: 0 }, right: { pressed: false, downCount: 0 } };
  let padState = { available: true, controllers: [{ connected: true, buttons: 0, rightTrigger: 0 }] };
  const events = [];
  const bindings = structuredClone(DEFAULTS.keybinds);
  const dispatcher = createKeybindDispatcher(() => bindings, event => events.push(event));
  dispatcher.keyboard({ running: true, keys: {} });
  const input = createInputMonitor({
    startMouseInput() {}, stopMouseInput() {},
    getMouseSnapshot() { if (mouseFailure) throw mouseFailure; return mouseState; },
    getXInputSnapshot() { if (padFailure) throw padFailure; return padState; },
  }, status => dispatcher.input(status));
  const press = () => {
    if (failed === 'mouse') padState.controllers[0].rightTrigger = 1;
    else mouseState.left = { pressed: true, downCount: mouseState.left.downCount + 1 };
    input.poll();
  };
  const release = () => {
    if (failed === 'mouse') padState.controllers[0].rightTrigger = 0;
    else mouseState.left.pressed = false;
    input.poll();
  };
  try {
    input.start(); events.length = 0;
    press();
    if (failed === 'mouse') mouseFailure = new Error('mouse failed');
    else padFailure = new Error('XInput failed');
    input.poll();
    assert.deepEqual(events, [{ action: 'fire', pressed: true }], `${failed} failure must not reset a healthy hold`);
    release(); press(); release();
    assert.deepEqual(events, [true, false, true, false].map(pressed => ({ action: 'fire', pressed })), `${failed} failure preserves healthy press/release`);
    const status = input.getStatus();
    assert.equal(status.available, true);
    assert.equal(status.mouseAvailable, failed !== 'mouse');
    assert.equal(status.controllersAvailable, failed !== 'controllers');
    assert.equal(status.error, failed === 'mouse' ? 'mouse failed' : 'XInput failed');
    if (failed === 'mouse') {
      mouseFailure = null; mouseState.running = false; mouseState.errorCode = 6;
      input.poll(); press(); release();
      assert.deepEqual(events.slice(-2), [true, false].map(pressed => ({ action: 'fire', pressed })), 'mouse errorCode does not discard controller events');
      const beforeRecovery = events.length;
      mouseState.running = true; mouseState.errorCode = 0; mouseState.left.downCount = 8;
      input.poll();
      assert.equal(events.length, beforeRecovery, 'mouse recovery does not replay old clicks while XInput remained available');
    } else {
      padFailure = null; padState.available = false; padState.controllers[0].rightTrigger = 1;
      input.poll();
      assert.equal(input.getStatus().left.pressed, false, 'unavailable XInput must not leak stale trigger state');
      bindings.fire.pressType = 'toggle';
      padState.available = true; events.length = 0; input.poll();
      assert.deepEqual(events, [], 'controller recovery while held must not toggle');
      padState.controllers[0].rightTrigger = 0; input.poll();
      padState.controllers[0].rightTrigger = 1; input.poll();
      assert.deepEqual(events, [{ action: 'fire', pressed: true }], 'controller recovery accepts a fresh release/press');
    }
  } finally { input.stop(); }
}
console.log('PASS: mouse counters + controller merge + lifecycle + independent provider failures through dispatcher');
