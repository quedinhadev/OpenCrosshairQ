// Run: .\node_modules\electron\dist\electron.exe test/shortcut-physical.cjs
// Physical-key test: injects real keystrokes system-wide via keybd_event
// (user32; internally SendInput) and asserts the global shortcut toggles.
// SendKeys was NOT used because its special-key table only covers F1-F16;
// keybd_event(VK 0x86) emits F23 and RegisterHotKey (used by Electron
// globalShortcut) responds to injected input.
// Isolated userData; never touches the user's profiles.
const { app, globalShortcut } = require('electron');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const data = fs.mkdtempSync(path.join(tempRoot, 'cq-shortcut-test-'));
app.setPath('userData', data);

const KEY = process.env.CQ_TEST_KEY || 'F23';
const VK = { F23: 0x86, K: 0x4B }[KEY];
assert.ok(VK, `no VK code for test key ${KEY}`);

// keybd_event sequence. Press Ctrl, Alt, Shift, then tap the key.
// Release order: key already up, then Shift, Alt, Ctrl — Ctrl stays down last
// so Alt+Shift-without-Ctrl never occurs (plain Alt+Shift is the Windows
// layout-switch hotkey on many systems).
const ps1 = path.join(data, 'send-key.ps1');
fs.writeFileSync(ps1, `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
}
"@
[K]::keybd_event(0x11, 0, 0, [System.UIntPtr]::Zero)
[K]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
[K]::keybd_event(0x10, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(${VK}, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(${VK}, 0, 2, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0x10, 0, 2, [System.UIntPtr]::Zero)
[K]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
[K]::keybd_event(0x11, 0, 2, [System.UIntPtr]::Zero)
`);

function sendPhysicalCombo() {
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { timeout: 15000 });
  const detail = `status=${res.status} stderr=${res.stderr}`;
  assert.ok(res.status === 0, `key injection failed: ${detail}`);
}

const loaded = [];
app.on('browser-window-created', (_event, win) => {
  loaded.push(once(win.webContents, 'did-finish-load').then(() => win));
});
require('../src/main/main.js');

const timeout = setTimeout(() => { console.error('FAIL: physical shortcut test timeout'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  try {
    const windows = await Promise.all(loaded);
    const ui = windows.find(win => win.webContents.getURL().includes('/ui/index.html'));
    assert.ok(ui, 'UI window loaded');
    // Global shortcut does not need focus; keep the desktop free for others.
    ui.minimize();
    const run = script => ui.webContents.executeJavaScript(script);
    await run('window.cq.set({ visible: false })'); // no crosshair painted on the shared desktop

    const base = (await run('window.cq.getState()')).keybinds;
    const combo = `Control+Alt+Shift+${KEY}`;
    assert.equal(globalShortcut.isRegistered(combo), false, 'combo must be free before the test');
    const binding = { ...base.globalShortcut, enabled: true, pc: { modifiers: ['Ctrl', 'Alt', 'Shift'], key: KEY, platform: 'PC' } };
    await run(`(async () => { window.cq.set({ keybinds: ${JSON.stringify({ ...base, globalShortcut: binding })} }); return window.cq.getState(); })()`);
    assert.ok(globalShortcut.isRegistered(combo), `${combo} registered by the OS`);

    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 2000;
      let state;
      while (Date.now() < deadline) {
        state = await run('window.cq.getState()');
        if (predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`timeout: ${label} (last hidden=${state && state.hidden})`);
    };

    const hiddenBefore = (await run('window.cq.getState()')).hidden;
    sendPhysicalCombo();
    await waitFor(state => state.hidden === !hiddenBefore, `physical ${combo} toggles hidden`);
    sendPhysicalCombo();
    await waitFor(state => state.hidden === hiddenBefore, `physical ${combo} toggles hidden back`);

    // Disabled binding: unregisters, physical key becomes inert.
    await run(`(async () => { window.cq.set({ keybinds: ${JSON.stringify({ ...base, globalShortcut: { ...binding, enabled: false } })} }); return window.cq.getState(); })()`);
    assert.equal(globalShortcut.isRegistered(combo), false, 'disabled combo unregistered');
    const hiddenAtDisable = (await run('window.cq.getState()')).hidden;
    sendPhysicalCombo();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await run('window.cq.getState()')).hidden, hiddenAtDisable, 'disabled combo must not toggle');

    console.log(`PASS: physical Ctrl+Alt+Shift+${KEY} toggles global shortcut on/off; enabled=false unregisters and key is inert`);
    clearTimeout(timeout);
    globalShortcut.unregisterAll();
    await new Promise(resolve => setTimeout(resolve, 300)); // let stdout flush before app.exit
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    globalShortcut.unregisterAll();
    await new Promise(resolve => setTimeout(resolve, 300));
    app.exit(1);
  }
});
