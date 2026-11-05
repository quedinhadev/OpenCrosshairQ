import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdater, CHECK_INTERVAL_MS, INITIAL_DELAY_MS } = require('../src/main/updater.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const engine = new EventEmitter();
  let checks = 0, installs = 0;
  const timeouts = [], intervals = [], cleared = [];
  engine.checkForUpdates = async () => { checks++; engine.emit('update-not-available'); return {}; };
  engine.quitAndInstall = (...args) => { installs++; assert.deepEqual(args, [false, true]); };
  const states = [];
  const updater = createUpdater({ currentVersion: '0.2.0', supported: true, autoUpdater: engine,
    logger: { error() {} }, onState: s => states.push(s),
    timers: { setTimeout(fn, ms) { timeouts.push({ fn, ms }); return 1; }, clearTimeout(id) { cleared.push(id); },
      setInterval(fn, ms) { intervals.push({ fn, ms }); return 2; }, clearInterval(id) { cleared.push(id); } }, ...options });
  return { engine, updater, states, timeouts, intervals, cleared, checks: () => checks, installs: () => installs };
}
test('unsupported builds never check, download or schedule network work', async () => {
  const h = harness({ supported: false, reason: 'portable' });
  h.updater.start();
  await h.updater.check(); await h.updater.install();
  assert.equal(h.updater.getState().phase, 'unsupported');
  assert.equal(h.checks(), 0); assert.equal(h.installs(), 0); assert.equal(h.timeouts.length, 0);
});
test('checks deduplicate and consume download rejection without unhandled promises', async () => {
  const h = harness();
  let release;
  h.engine.checkForUpdates = async () => ({ downloadPromise: new Promise((_, reject) => { release = reject; }) });
  const a = h.updater.check(), b = h.updater.check();
  assert.equal(a, b);
  await tick(); release(new Error('offline'));
  await a;
  assert.equal(h.updater.getState().phase, 'error');
  assert.match(h.updater.getState().error, /conexão/);
});
test('download progress, explicit install, persistence before quit and duplicate protection', async () => {
  const order = [];
  const h = harness({ prepareInstall: async () => { order.push('flush'); await tick(); } });
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  assert.equal(h.engine.autoDownload, true);
  assert.equal(h.engine.allowPrerelease, false);
  assert.equal(h.engine.allowDowngrade, false);
  await h.updater.install(); assert.equal(h.installs(), 0);
  h.engine.emit('update-available', { version: '0.2.1' });
  h.engine.emit('download-progress', { percent: 34.7 });
  assert.equal(h.updater.getState().progress, 35);
  h.engine.emit('update-downloaded', { version: '0.2.1' });
  const copy = h.updater.getState(); copy.phase = 'oops';
  assert.equal(h.updater.getState().phase, 'downloaded');
  await h.updater.check(); assert.equal(h.checks(), 0);
  const install = h.updater.install(); await h.updater.install();
  assert.equal(h.installs(), 0); await install;
  assert.deepEqual(order, ['flush']); assert.equal(h.installs(), 1);
  assert.equal(h.updater.getState().phase, 'installing');
});
test('failed persistence blocks installation and preserves downloaded update for retry', async () => {
  let failed = true;
  const h = harness({ prepareInstall() { if (failed) throw new Error('disk full'); } });
  h.engine.emit('update-downloaded', { version: '0.2.1' });
  await h.updater.install();
  assert.equal(h.installs(), 0); assert.equal(h.updater.getState().phase, 'downloaded');
  failed = false; await h.updater.install(); assert.equal(h.installs(), 1);
});
test('installer error event restores tray lifecycle and permits retry', async () => {
  let restored = 0;
  const h = harness({ cancelInstall: () => { restored++; } });
  h.engine.emit('update-downloaded', { version: '0.2.1' });
  h.engine.quitAndInstall = () => h.engine.emit('error', new Error('installer unavailable'));
  await h.updater.install();
  assert.equal(restored, 1);
  assert.equal(h.updater.getState().phase, 'downloaded');
  assert.match(h.updater.getState().error, /conexão/);
  h.engine.quitAndInstall = () => { restored += 10; };
  await h.updater.install(); assert.equal(restored, 11);
});
test('start schedules boot and six-hour checks once; dispose removes timers/listeners', async () => {
  const h = harness(); h.updater.start(); h.updater.start();
  assert.equal(h.timeouts.length, 1); assert.equal(h.timeouts[0].ms, INITIAL_DELAY_MS);
  assert.equal(h.intervals.length, 1); assert.equal(h.intervals[0].ms, CHECK_INTERVAL_MS);
  h.timeouts[0].fn(); await tick(); assert.equal(h.checks(), 1);
  h.updater.dispose(); assert.deepEqual(h.cleared, [null, 2]);
  assert.equal(h.engine.listenerCount('download-progress'), 0);
  await h.updater.check(); assert.equal(h.checks(), 1);
});
test('dispose cleans up pending initial timer before it fires', () => {
  const h = harness();
  h.updater.start();
  assert.equal(h.timeouts.length, 1);
  h.updater.dispose();
  assert.deepEqual(h.cleared, [1, 2]);
});
