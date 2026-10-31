// Build: powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1
// Run: .\node_modules\electron\dist\electron.exe test/native-smoke.cjs
// Message-only Raw Input window; no visible windows, focus changes, or synthetic OS input.
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');
const addon = require('../native/build/crosshairq.node');

function integer(value, min, max) {
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `Out of range: ${value}`);
}

function mouseSnapshot(running) {
  const state = addon.getMouseSnapshot();
  assert.equal(state.running, running);
  assert.equal(state.errorCode, 0);
  for (const name of ['left', 'right', 'middle']) {
    const button = state[name];
    assert.equal(typeof button.pressed, 'boolean');
    integer(button.downCount, 0, Number.MAX_SAFE_INTEGER);
    integer(button.upCount, 0, Number.MAX_SAFE_INTEGER);
    if (!running) assert.equal(button.pressed, false);
  }
  return state;
}

function mouseWorker() {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const addon = require(${JSON.stringify(require.resolve('../native/build/crosshairq.node'))});
    addon.startMouseInput();
    parentPort.postMessage(addon.getMouseSnapshot());
    setInterval(() => {}, 1000);
  `, { eval: true });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', state => resolve({ worker, state }));
  });
}

app.whenReady().then(async () => {
  try {
    let foreground;
    let snapshot;
    for (let attempt = 0; attempt < 20; attempt++) {
      foreground = addon.getForegroundProcess();
      if (foreground !== null) {
        integer(foreground.pid, 1, 0xffffffff);
        integer(foreground.errorCode, 0, 0xffffffff);
        if (foreground.errorCode === 0) {
          assert.equal(typeof foreground.executablePath, 'string');
          assert.ok(foreground.executablePath.length > 0);
          assert.equal(foreground.executableName, foreground.executablePath.split('\\').pop());
        } else {
          assert.equal(foreground.executablePath, null);
          assert.equal(foreground.executableName, null);
        }
      }
      snapshot = addon.getXInputSnapshot();
      assert.equal(typeof snapshot.available, 'boolean');
      integer(snapshot.errorCode, 0, 0xffffffff);
      if (snapshot.available) {
        assert.match(snapshot.dll, /^xinput(?:1_4|9_1_0|1_3)\.dll$/);
        assert.equal(snapshot.errorCode, 0);
      } else {
        assert.equal(snapshot.dll, null);
        assert.notEqual(snapshot.errorCode, 0);
      }
      assert.equal(snapshot.controllers.length, 4);
      snapshot.controllers.forEach((controller, index) => {
        assert.equal(controller.index, index);
        assert.equal(controller.connected, controller.errorCode === 0);
        integer(controller.errorCode, 0, 0xffffffff);
        integer(controller.packetNumber, 0, 0xffffffff);
        integer(controller.buttons, 0, 0xffff);
        for (const key of ['leftTrigger', 'rightTrigger']) integer(controller[key], 0, 255);
        for (const key of ['leftThumbX', 'leftThumbY', 'rightThumbX', 'rightThumbY']) integer(controller[key], -32768, 32767);
        if (!controller.connected) {
          for (const key of ['packetNumber', 'buttons', 'leftTrigger', 'rightTrigger', 'leftThumbX', 'leftThumbY', 'rightThumbX', 'rightThumbY']) assert.equal(controller[key], 0);
        }
      });
    }
    mouseSnapshot(false);
    assert.equal(addon.stopMouseInput(), undefined);
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.equal(addon.startMouseInput(), undefined);
      mouseSnapshot(true);
      const before = addon.getMouseSnapshot();
      assert.equal(addon.startMouseInput(), undefined);
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = mouseSnapshot(true);
      for (const name of ['left', 'right', 'middle']) {
        assert.ok(after[name].downCount >= before[name].downCount);
        assert.ok(after[name].upCount >= before[name].upCount);
      }
      assert.equal(addon.stopMouseInput(), undefined);
      mouseSnapshot(false);
      assert.equal(addon.stopMouseInput(), undefined);
      mouseSnapshot(false);
    }
    const { worker, state } = await mouseWorker();
    try {
      assert.equal(state.running, true);
      assert.throws(() => addon.startMouseInput(), error => error.code === 'ERR_MOUSE_INPUT' && error.win32Code === 170);
      assert.equal(addon.getMouseSnapshot().running, false);
      assert.equal(addon.stopMouseInput(), undefined);
    } finally {
      // Termination runs the environment cleanup hook with registration still active.
      await worker.terminate();
    }
    addon.startMouseInput();
    mouseSnapshot(true);
    addon.stopMouseInput();
    mouseSnapshot(false);
    console.log(JSON.stringify({ foreground, snapshot, mouse: addon.getMouseSnapshot(), electron: process.versions.electron, napi: process.versions.napi }, null, 2));
    console.log('PASS: 20 foreground + XInput snapshots; 3 mouse cycles; registration conflict; worker-unload cleanup + restart. Physical input not validated.');
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}, error => { console.error(error); app.exit(1); });
