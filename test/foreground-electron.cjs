// Deterministic native boundary substitute; never changes OS focus or user profiles.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const data = fs.mkdtempSync(path.join(tempRoot, 'cq-foreground-test-'));
app.setPath('userData', data);
fs.mkdirSync(path.join(data, 'profiles'));
const safeKeybinds = { globalShortcut: { enabled: false, action: 'toggleHide', pressType: 'press', pc: { modifiers: ['Ctrl', 'Alt', 'Shift'], key: 'F23', platform: 'PC' } } };
fs.writeFileSync(path.join(data, 'profiles', 'default.json'), JSON.stringify({
  id: 'default', name: 'Default', createdAt: 0, process: null, settings: { scale: 2, keybinds: safeKeybinds },
}));
const executablePath = 'C:\\OwnGame\\game.exe';
fs.writeFileSync(path.join(data, 'profiles', 'game.json'), JSON.stringify({
  id: 'game', name: 'Own game', createdAt: 1,
  process: { path: executablePath, name: 'game.exe' }, hideCrosshairWhenUnfocused: true,
  settings: { scale: 1.4, keybinds: safeKeybinds },
}));
let foreground = null;
const addon = require.resolve('../native/build/crosshairq.node');
require.cache[addon] = { id: addon, filename: addon, loaded: true, exports: { getForegroundProcess: () => foreground } };
const loaded = [];
app.on('browser-window-created', (_event, win) => loaded.push(once(win.webContents, 'did-finish-load').then(() => win)));
require('../src/main/main.js');
const timeout = setTimeout(() => { console.error('FAIL: foreground integration timeout'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  try {
    const windows = await Promise.all(loaded);
    const ui = windows.find(win => new URL(win.webContents.getURL()).pathname.endsWith('/ui/index.html'));
    const overlay = windows.find(win => win.webContents.getURL().endsWith('/overlay/overlay.html'));
    const run = script => ui.webContents.executeJavaScript(script);
    async function expect(id, focused, shown) {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const state = await run('window.cq.getState()');
        const display = await overlay.webContents.executeJavaScript("document.getElementById('primary').style.display");
        if (state.profiles.currentProfileId === id && state.profileInFocus === focused && display === (shown ? 'block' : 'none')) return state;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`foreground mismatch: ${id}, ${focused}, ${shown}`);
    }
    assert.equal((await expect('default', true, true)).scale, 2, 'startup hydrates default profile before persisting');
    foreground = { pid: 1, errorCode: 0, executablePath, executableName: 'game.exe' };
    assert.equal((await expect('game', true, true)).scale, 1.4);
    foreground = { pid: 2, errorCode: 0, executablePath: 'C:\\Other.exe' };
    await expect('game', false, false);
    foreground = { pid: 3, errorCode: 0, executablePath: 'C:\\Windows\\explorer.exe' };
    await new Promise(resolve => setTimeout(resolve, 400));
    await expect('game', false, false);
    foreground = { pid: 4, errorCode: 5, executablePath: null };
    await new Promise(resolve => setTimeout(resolve, 400));
    await expect('game', false, false);
    foreground = { pid: 1, errorCode: 0, executablePath };
    await expect('game', true, true);
    await run("(async () => { window.cq.set({ profileDetectionEnabled: false }); window.cq.setProfile('default'); return window.cq.getState(); })()");
    foreground = { pid: 5, errorCode: 0, executablePath };
    await new Promise(resolve => setTimeout(resolve, 400));
    await expect('default', true, true);
    const defaults = JSON.parse(fs.readFileSync(path.join(data, 'profiles', 'default.json'), 'utf8'));
    assert.ok(defaults.settings.model, 'default was initialized and persisted before leaving');
    console.log('PASS: native boundary, auto profile, unknown, Explorer, protected process, visibility, auto-switch off');
    clearTimeout(timeout);
    app.quit();
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
