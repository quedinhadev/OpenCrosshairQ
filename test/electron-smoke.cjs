// Run: .\node_modules\electron\dist\electron.exe test/electron-smoke.cjs
// Isolated userData: never changes the user's profiles.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const data = fs.mkdtempSync(path.join(tempRoot, 'cq-electron-test-'));
app.setPath('userData', data);
const loaded = [];
const errors = [];
app.on('browser-window-created', (_event, win) => {
  loaded.push(once(win.webContents, 'did-finish-load').then(() => win));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, details) => errors.push(details.reason));
});
require('../src/main/main.js');
const timeout = setTimeout(() => { console.error('FAIL: Electron smoke timeout'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  try {
    const windows = await Promise.all(loaded);
    assert.equal(windows.length, 2, 'only the main window and overlay exist');
    const ui = windows.find(win => new URL(win.webContents.getURL()).pathname.endsWith('/ui/index.html'));
    assert.ok(ui, 'UI loaded');
    const run = script => ui.webContents.executeJavaScript(script);
    const initialBindings = (await run('window.cq.getState()')).keybinds;
    const { globalShortcut } = require('electron');
    const combo = ['F23', 'F22', 'F21'].map(key => `Control+Alt+Shift+${key}`).find(key => !globalShortcut.isRegistered(key));
    assert.ok(combo, 'test shortcut available in this process');
    const binding = { ...initialBindings.globalShortcut, enabled: true, pc: { modifiers: ['Ctrl', 'Alt', 'Shift'], key: combo.split('+').at(-1), platform: 'PC' } };
    await run(`(async () => { window.cq.set({ keybinds: ${JSON.stringify({ ...initialBindings, globalShortcut: binding })} }); return window.cq.getState(); })()`);
    assert.ok(globalShortcut.isRegistered(combo), 'custom global shortcut registered by Windows');
    await run(`(async () => { window.cq.set({ keybinds: ${JSON.stringify({ ...initialBindings, globalShortcut: { ...binding, enabled: false } })} }); return window.cq.getState(); })()`);
    assert.equal(globalShortcut.isRegistered(combo), false, 'disabled shortcut unregistered');
    await run(`(async () => { window.cq.set({ keybinds: ${JSON.stringify(initialBindings)} }); return window.cq.getState(); })()`);
    const routes = await run(`(() => {
      const results = [];
      for (const button of document.querySelectorAll('.nav-item[data-route]')) {
        button.click();
        results.push([button.dataset.route, document.querySelector('.page.on')?.id]);
      }
      return { results, unavailableDisabled: document.getElementById('btnNewKeybind')?.disabled };
    })()`);
    assert.deepEqual(routes.results, [
      ['crosshairs', 'page-crosshairs'],
      ['designer', 'page-designer'],
      ['keybinds', 'page-keybinds'],
      ['positions', 'page-positions'],
      ['startup', 'page-startup'],
    ]);
    assert.ok(routes.unavailableDisabled, 'unavailable controls must not pretend to work');
    const startupDom = await run(`(() => {
      const startOpt = document.getElementById('optionStartWithWindows');
      const startStatus = document.getElementById('startupStatus');
      const trayOpt = document.getElementById('optionMinimizeToTray');
      const trayStatus = document.getElementById('trayStatus');
      return {
        startOpt: startOpt ? {
          tagName: startOpt.tagName,
          type: startOpt.type,
          ariaLabel: startOpt.getAttribute('aria-label'),
          disabled: startOpt.disabled,
        } : null,
        startStatus: startStatus ? {
          tagName: startStatus.tagName,
          role: startStatus.getAttribute('role'),
          ariaLive: startStatus.getAttribute('aria-live'),
          text: startStatus.textContent,
        } : null,
        trayOpt: trayOpt ? {
          tagName: trayOpt.tagName,
          type: trayOpt.type,
          ariaLabel: trayOpt.getAttribute('aria-label'),
          disabled: trayOpt.disabled,
        } : null,
        trayStatus: trayStatus ? {
          tagName: trayStatus.tagName,
          role: trayStatus.getAttribute('role'),
          ariaLive: trayStatus.getAttribute('aria-live'),
          text: trayStatus.textContent,
        } : null,
      };
    })()`);
    assert.ok(startupDom.startOpt, 'optionStartWithWindows exists');
    assert.equal(startupDom.startOpt.tagName, 'INPUT');
    assert.equal(startupDom.startOpt.type, 'checkbox');
    assert.equal(startupDom.startOpt.ariaLabel, 'Iniciar com o Windows');
    assert.equal(startupDom.startOpt.disabled, true, 'dev statusdisabled esperado');
    assert.ok(startupDom.startStatus, 'startupStatus exists');
    assert.equal(startupDom.startStatus.tagName, 'P');
    assert.equal(startupDom.startStatus.role, 'status');
    assert.equal(startupDom.startStatus.ariaLive, 'polite');
    assert.ok(startupDom.trayOpt, 'optionMinimizeToTray exists');
    assert.equal(startupDom.trayOpt.tagName, 'INPUT');
    assert.equal(startupDom.trayOpt.type, 'checkbox');
    assert.equal(startupDom.trayOpt.ariaLabel, 'Minimizar para bandeja');
    assert.ok(startupDom.trayStatus, 'trayStatus exists');
    assert.equal(startupDom.trayStatus.tagName, 'P');
    assert.equal(startupDom.trayStatus.role, 'status');
    assert.equal(startupDom.trayStatus.ariaLive, 'polite');
    const removed = await run(`(() => ({
      pages: ['cursor', 'randomizer', 'support', 'news', 'shop', 'discord'].filter(id => document.getElementById('page-' + id)),
      randomize: typeof window.cq.randomize,
      openDesigner: typeof window.cq.openDesigner,
    }))()`);
    assert.deepEqual(removed, { pages: [], randomize: 'undefined', openDesigner: 'undefined' });
    const library = await run(`(() => {
      document.querySelector('[data-route="crosshairs"]').click();
      return {
        title: document.getElementById('xHeroTitle').textContent,
        outOfScope: [...document.querySelectorAll('[data-route="discord"], [data-xtab="workshop"], #btnQuickGift, #btnQuickRandom2')].filter(e => e.getClientRects().length).length,
        unavailable: document.getElementById('xPanelDescobrir').textContent.includes('Indisponível offline'),
      };
    })()`);
    assert.equal(library.title, 'Bem-vindo ao OpenCrosshairQ');
    assert.equal(library.outOfScope, 0, 'no visible out-of-scope library controls');
    assert.equal(library.unavailable, false, 'no fictitious offline promotion');
    await run(`document.querySelector('[data-route="designer"]').click()`);
    await run(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        const frame = document.getElementById('designerFrame');
        if (frame?.contentWindow?.document?.getElementById('layers')) return resolve();
        if (Date.now() > deadline) return reject(new Error('Designer iframe did not boot'));
        setTimeout(check, 25);
      }; check();
    })`);
    const propCount = await run(`(async () => {
      const doc = document.getElementById('designerFrame').contentDocument;
      const deadline = Date.now() + 3000;
      while (!doc.querySelector('#bodyLayer input[type=number]')) {
        if (Date.now() > deadline) throw new Error('Designer properties did not render');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const input = doc.querySelector('#bodyLayer input[type=number]');
      input.focus(); input.value = '7';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      return doc.getElementById('bodyLayer').children.length;
    })()`);
    assert.equal(propCount, 2, 'Posicao section renders X/Y grid and Escala only');
    const initial = await run('window.cq.getState()');
    assert.equal(initial.profiles.currentProfileId, 'default');
    assert.ok(initial.profiles.profiles.default);
    const created = await run(`(async () => {
      window.cq.createProfile('Smoke profile');
      return window.cq.getState();
    })()`);
    const id = created.profiles.currentProfileId;
    assert.notEqual(id, 'default');
    assert.ok(created.profiles.profiles.default && created.profiles.profiles[id]);
    const nativeStatus = await run('window.cq.getNativeStatus()');
    assert.equal(typeof nativeStatus.available, 'boolean');
    const configured = await run(`window.cq.configureProfile({ id: ${JSON.stringify(id)}, processPath: 'C:\\\\OwnGame\\\\game.exe', hideCrosshairWhenUnfocused: true })`);
    assert.equal(configured.process.path, 'C:\\OwnGame\\game.exe');
    assert.equal(configured.hideCrosshairWhenUnfocused, true);
    assert.equal(await run(`window.cq.configureProfile({ id: ${JSON.stringify(id)}, processPath: '../bad.exe', hideCrosshairWhenUnfocused: false }).then(() => false, () => true)`), true);
    await run(`(async () => { window.cq.set({ scale: 1.7 }); window.cq.setProfile(${JSON.stringify(id)}); return window.cq.getState(); })()`);
    assert.equal((await run('window.cq.getState()')).scale, 1.7, 'reselecting current profile preserves pending edits');
    const switched = await run(`(async () => {
      window.cq.setProfile('default');
      return window.cq.getState();
    })()`);
    assert.equal(switched.profiles.currentProfileId, 'default');
    assert.ok(switched.profiles.profiles[id]);
    const restored = await run(`(async () => { window.cq.setProfile(${JSON.stringify(id)}); return window.cq.getState(); })()`);
    assert.equal(restored.scale, 1.7, 'edited profile settings survive switching');
    const favoriteDocument = { layers: [{ id: 'favorite-text', type: 'text', text: 'Own text', x: 0, y: 0, visible: true, opacity: 1, fontSize: 14, color: '#ffffff' }], drawing: '<text>Own text</text>' };
    await run(`(async () => { window.cq.set(${JSON.stringify(favoriteDocument)}); return window.cq.getState(); })()`);
    await run(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        document.getElementById('contSave').click();
        const saved = JSON.parse(localStorage.getItem('cq.savedCustomCrosshairs') || '[]');
        if (saved.some(item => item.layers?.[0]?.id === 'favorite-text')) return resolve();
        if (Date.now() > deadline) return reject(new Error('Favorite state timeout'));
        setTimeout(check, 10);
      }; check();
    })`);
    await run(`(async () => { window.cq.set({ layers: [], drawing: null }); return window.cq.getState(); })()`);
    await run(`(() => {
      const cards = [...document.querySelectorAll('#savedGrid .mod-card-media')];
      cards[cards.length - 1].click();
    })()`);
    const quotaMessage = await run(`(() => {
      const original = Storage.prototype.setItem;
      try {
        Storage.prototype.setItem = () => { throw new Error('quota'); };
        document.getElementById('contSave').click();
        return document.getElementById('toast').textContent;
      } finally { Storage.prototype.setItem = original; }
    })()`);
    assert.match(quotaMessage, /Não foi possível salvar/, 'quota failures must not report success');
    const favoriteRestored = await run('window.cq.getState()');
    assert.equal(favoriteRestored.layers.length, favoriteDocument.layers.length, 'favorites preserve layer count');
    for (const [key, value] of Object.entries(favoriteDocument.layers[0])) {
      assert.deepEqual(favoriteRestored.layers[0][key], value, `favorites preserve layer ${key}`);
    }
    assert.equal(favoriteRestored.drawing, require('../src/shared/layers').renderLayers(favoriteRestored.layers), 'favorites recompile trusted drawing from validated layers');
    assert.notEqual(favoriteRestored.drawing, favoriteDocument.drawing, 'external compiled SVG is not trusted');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'profiles', `${id}.json`), 'utf8'));
    assert.equal(saved.settings.scale, 1.7);
    await run(`window.cq.deleteProfile(${JSON.stringify(id)})`);
    assert.equal((await run('window.cq.getProfiles()')).length, 1);
    const overlay = windows.find(win => win.webContents.getURL().endsWith('/overlay/overlay.html'));
    assert.ok(overlay, 'overlay loaded');
    const applyVisibility = async (patch, expected) => {
      await overlay.webContents.executeJavaScript(`window.smokeStateApplied = false;
        window.cq.onState(state => {
          if (Object.entries(${JSON.stringify(patch)}).every(([key, value]) => state[key] === value)) window.smokeStateApplied = true;
        }); void 0;`);
      await run(`(async () => { window.cq.set(${JSON.stringify(patch)}); return window.cq.getState(); })()`);
      const display = await overlay.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const check = () => {
          if (window.smokeStateApplied) return resolve(document.getElementById('primary').style.display);
          if (Date.now() > deadline) return reject(new Error('Overlay state timeout'));
          setTimeout(check, 10);
        };
        check();
      })`);
      assert.equal(display, expected);
    };
    await applyVisibility({ visible: false }, 'none');
    await applyVisibility({ visible: true }, 'block');
    await applyVisibility({ hidden: true }, 'none');
    await applyVisibility({ hidden: false }, 'block');
    const protectedState = await run(`(async () => { window.cq.set({ profileInFocus: false, nativeStatus: { available: false }, profiles: { currentProfileId: 'missing' } }); return window.cq.getState(); })()`);
    assert.equal(protectedState.profiles.currentProfileId, 'default', 'registry is main-owned');
    assert.equal(protectedState.profileInFocus, true, 'focus is main-owned');
    const started = await run('window.cq.startStreamer(0)');
    assert.ok(started.running && started.port > 0);
    assert.equal(started.streaming, null);
    assert.equal(await run("window.cq.startStreamer(-1).then(() => false, () => true)"), true, 'invalid port rejects across IPC');
    assert.equal((await run('window.cq.getStreaming()')).port, started.port, 'rejection preserves listener');
    const response = await fetch(`http://127.0.0.1:${started.port}/api/status`);
    assert.deepEqual(await response.json(), started);
    assert.equal((await run('window.cq.stopStreamer()')).running, false);
    assert.deepEqual(errors, [], 'renderer errors');
    console.log('PASS: Electron UI + Designer load, profile IPC, HTTP lifecycle');
    console.log('Isolated userData:', data);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
