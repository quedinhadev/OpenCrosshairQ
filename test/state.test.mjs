import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStore, DEFAULTS, validatePatch } = require('../src/main/state.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-state-'));
const profiles = { default: { id: 'default' }, second: { id: 'second' } };
try {
  const store = createStore(dir, { profiles });
  assert.equal(store.get().profiles.currentProfileId, 'default');
  profiles.default.name = 'external initial change';
  assert.equal(store.get().profiles.profiles.default.name, undefined, 'initial registry isolated');
  delete profiles.default.name;
  let changes = 0;
  store.onChange(() => { changes++; });
  store.set({ profiles: { currentProfileId: 'second' } });
  assert.deepEqual(store.get().profiles.profiles, profiles, 'selection preserves registry');
  assert.equal(changes, 1);
  store.set({ profiles: { currentProfileId: 'second' } });
  assert.equal(changes, 1, 'same selection does not notify');
  const reloaded = createStore(dir, { profiles });
  assert.equal(reloaded.get().profiles.currentProfileId, 'second', 'restore persisted selection');
  assert.deepEqual(reloaded.get().profiles.profiles, profiles);
  const removed = createStore(dir, { profiles: { default: profiles.default } });
  assert.equal(removed.get().profiles.currentProfileId, 'default', 'deleted selection falls back');
  for (const patch of [null, [], 1, { scale: 'abc' }, { scale: 0 }, { scale: Infinity }, { crosshairSize: -1 }, { offsetX: null }, { offsetY: NaN }, { offsetX: 100001 }, { hidden: 'yes' }, { visible: 0 }, { limitSize: null }, { showSecondary: 'false' }, { onlyInGame: 1 }, { profileDetectionEnabled: [] }, { displayId: '1' }, { crosshairOffset: null }, { crosshairOffset: { x: 'bad', y: 0 } }, { crosshairOffset: { x: 1 } }, { defaultCrosshair: 'bad' }, { defaultCrosshair: { model: { color: 'url(https://x)' } } }, { firingOptions: [] }, { animations: [] }, { profiles: { currentProfileId: 'missing' } }]) {
    const before = JSON.stringify(store.get());
    const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.throws(() => store.set(patch), undefined, JSON.stringify(patch));
    assert.equal(JSON.stringify(store.get()), before, 'invalid patch preserves memory');
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), disk, 'invalid patch preserves disk');
  }
  assert.throws(() => store.set({ animations: new Map([['mutable', 1]]) }), /objetos JSON/, 'mutable collection cannot bypass freeze');
  const input = { keybinds: structuredClone(DEFAULTS.keybinds), animations: { nested: { value: 1 } }, firingOptions: { duration: 10 }, profiles: { profiles: structuredClone(profiles) } };
  input.keybinds.globalShortcut.pc.key = 'J';
  let published;
  store.onChange(state => {
    published = state;
    assert.throws(() => { state.hidden = true; }, TypeError, 'listener cannot mutate committed root');
    assert.throws(() => { state.keybinds.globalShortcut.pc.key = 'X'; }, TypeError, 'listener cannot mutate committed child');
  });
  store.set(input);
  const committed = JSON.stringify(store.get());
  const committedDisk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  input.keybinds.globalShortcut.pc.key = 'K';
  input.animations.nested.value = 2;
  input.firingOptions.duration = 20;
  input.profiles.profiles.default.id = 'changed';
  profiles.default.id = 'caller changed initial registry';
  assert.equal(JSON.stringify(store.get()), committed, 'input aliases cannot mutate committed state');
  assert.equal(published, store.get(), 'get and listener preserve committed identity');
  assert.throws(() => { store.get().keybinds.globalShortcut.pc.key = 'X'; }, TypeError);
  assert.throws(() => { published.animations.nested.value = 3; }, TypeError);
  assert.throws(() => { published.profiles.profiles.default.id = 'X'; }, TypeError);
  assert.equal(JSON.stringify(store.get()), committed);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), committedDisk);
  const aliasRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('alias disk unavailable'); };
    assert.throws(() => store.set({ hidden: true }), /alias disk unavailable/);
  } finally { fs.renameSync = aliasRename; }
  assert.equal(JSON.stringify(store.get()), committed, 'failed write preserves content, not only identity');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), committedDisk);
  assert.deepEqual(validatePatch({ unknown: 1, profileInFocus: false }), {}, 'unknown and runtime-owned keys stripped');
  const beforeFailure = store.get();
  const diskBeforeFailure = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const changesBeforeFailure = changes;
  for (const method of ['writeFileSync', 'renameSync']) {
    const original = fs[method];
    const failure = new Error(`${method} failed`);
    try {
      fs[method] = () => { throw failure; };
      assert.throws(() => store.set({ hidden: true }), error => error === failure, 'write failure propagates');
      assert.throws(() => store.flush(), error => error === failure, 'flush failure propagates');
    } finally { fs[method] = original; }
    assert.equal(store.get(), beforeFailure, 'write failure preserves memory reference');
    assert.equal(changes, changesBeforeFailure, 'write failure does not notify');
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), diskBeforeFailure, 'write failure preserves file');
    assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false, 'failed write cleans temporary file');
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ scale: 'bad', offsetX: null, hidden: 'yes', visible: false, crosshairOffset: { x: 'bad' }, displayId: 'bad', arbitrary: 123, profiles: { currentProfileId: 'missing' } }));
  const recovered = createStore(dir, { profiles });
  assert.equal(recovered.get().scale, DEFAULTS.scale);
  assert.equal(recovered.get().offsetX, DEFAULTS.offsetX);
  assert.equal(recovered.get().hidden, false);
  assert.equal(recovered.get().visible, false, 'valid disk fields survive invalid neighbors');
  assert.deepEqual(recovered.get().crosshairOffset, DEFAULTS.crosshairOffset);
  assert.equal(recovered.get().displayId, null);
  assert.equal(Object.hasOwn(recovered.get(), 'arbitrary'), false);
  assert.equal(recovered.get().profiles.currentProfileId, 'default');
  console.log('PASS: typed store/disk boundaries + atomic persistence failures + profile selection');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
