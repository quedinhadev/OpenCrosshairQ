import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateForeground, isCrosshairVisible } = require('../src/shared/game-state.js');
const game = 'C:\\Games\\OwnGame\\game.exe';
const profiles = {
  default: { id: 'default', createdAt: 0, process: null },
  newer: { id: 'newer', createdAt: 20, process: { path: game }, hideCrosshairWhenUnfocused: true },
  older: { id: 'older', createdAt: 10, process: { path: game }, hideCrosshairWhenUnfocused: true },
};
const initial = { profileId: 'default', profileInFocus: true };
assert.deepEqual(evaluateForeground(initial, game, profiles), { profileId: 'older', profileInFocus: true });
const selected = { profileId: 'older', profileInFocus: true };
assert.deepEqual(evaluateForeground(selected, 'C:\\Other.exe', profiles), { profileId: 'older', profileInFocus: false });
assert.deepEqual(evaluateForeground(selected, 'C:\\Windows\\explorer.exe', profiles), selected);
assert.deepEqual(evaluateForeground(selected, 'C:\\Windows\\EXPLORER.EXE', profiles), selected);
assert.equal(evaluateForeground(selected, 'C:\\Games\\myexplorer.exe', profiles).profileInFocus, false);
assert.equal(evaluateForeground(selected, 'C:\\Games\\explorer.exe.backup', profiles).profileInFocus, false);
assert.deepEqual(evaluateForeground(initial, game, profiles, { autoSwitch: false }), initial);
assert.equal(evaluateForeground(selected, 'C:\\Other.exe', profiles, { autoSwitch: false }).profileInFocus, false);
assert.deepEqual(evaluateForeground(selected, 'C:\\Other.exe', profiles, { suspended: true }), selected);
assert.equal(evaluateForeground(initial, game.toLowerCase(), profiles).profileId, 'default', 'path match is exact');
assert.deepEqual(evaluateForeground(selected, null, profiles), selected, 'unavailable native path must not imply unfocused');
const shown = { visible: true, hidden: false, profileInFocus: true, onlyInGame: false, gameInFocus: false };
assert.equal(isCrosshairVisible(shown), true);
assert.equal(isCrosshairVisible({ ...shown, profileInFocus: false }), false);
assert.equal(isCrosshairVisible({ ...shown, onlyInGame: true }), false);
assert.equal(isCrosshairVisible({ ...shown, onlyInGame: true, gameInFocus: true }), true);
assert.equal(isCrosshairVisible({ ...shown, designerPreview: true, profileInFocus: false, onlyInGame: true }), true);
assert.equal(isCrosshairVisible({ ...shown, designerPreview: true, hidden: true }), false);
assert.equal(isCrosshairVisible({ ...shown, designerPreview: true, visible: false }), false);
console.log('PASS: exact process profiles + visibility gates');
