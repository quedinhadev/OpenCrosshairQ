// Run from app: node test/keybind-live.cjs
// CQ_TEST_APP_ROOT may select an app.asar payload, hosted by dev Electron.
// CQ_TEST_ALLOW_BACKGROUND_KEYS=1 opts into rare global keyboard probes while
// another app owns foreground. Never sends mouse input; otherwise requires test focus.
// Win32 input here is synthetic, not evidence of physical-key behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const crypto = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const appRoot = path.resolve(process.env.CQ_TEST_APP_ROOT || path.join(__dirname, '..'));

if (!process.env.CQ_KEYBIND_CHILD) {
  if (process.versions.electron) {
    console.error('FAIL: launch with node test/keybind-live.cjs; parent owns cleanup after Electron close.');
    require('electron').app.exit(1);
  } else parent().catch(error => { console.error(error); process.exitCode = 1; });
} else child().catch(error => { console.error(error); require('electron').app.exit(1); });

async function parent() {
  assert.equal(process.platform, 'win32', 'Win32 keyboard harness requires Windows');
  const temp = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(temp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(temp, 'cq-keybind-live-'));
  const artifacts = path.resolve(__dirname, '../../analysis', `keybind-live-${Date.now()}-${process.pid}`);
  fs.mkdirSync(artifacts, { recursive: true });
  const electron = require('electron');
  const log = fs.createWriteStream(path.join(artifacts, 'electron.log'));
  const env = { ...process.env, CQ_KEYBIND_CHILD: '1', CQ_TEST_PROFILE: profile, CQ_TEST_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(electron, [__filename], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const meta = { command: 'node test/keybind-live.cjs', appRoot, electron, pid: proc.pid, parentPid: process.pid, profile, artifacts, started: new Date().toISOString() };
  fs.writeFileSync(path.join(artifacts, 'launch.json'), JSON.stringify(meta, null, 2));
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`FAIL: 90000ms timeout; stopping only test PID ${proc.pid} tree.`);
    spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  }, 90000);
  let code;
  try { [code] = await once(proc, 'close'); }
  finally { clearTimeout(timer); log.end(); }
  meta.exitCode = code; meta.timedOut = timedOut; meta.finished = new Date().toISOString();
  // Chromium may hold files until exit: cleanup belongs to parent after close.
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); meta.profileCleanup = 'removed after child close'; }
  catch (error) { meta.profileCleanup = `preserved: ${error.code}`; console.error(`Profile preserved: ${profile} (${error.code})`); }
  fs.writeFileSync(path.join(artifacts, 'launch.json'), JSON.stringify(meta, null, 2));
  console.log(`Artifacts: ${artifacts}`);
  process.exitCode = timedOut || code !== 0 ? 1 : 0;
}

async function child() {
  const { app, BrowserWindow, globalShortcut } = require('electron');
  const data = process.env.CQ_TEST_PROFILE;
  const artifacts = process.env.CQ_TEST_ARTIFACTS;
  assert.ok(data && artifacts, 'parent-owned paths required');
  const session = path.join(data, 'session');
  fs.mkdirSync(session, { recursive: true });
  app.setPath('userData', data);
  app.setPath('sessionData', session);
  const loginCalls = [];
  for (const name of ['setLoginItemSettings', 'getLoginItemSettings']) {
    app[name] = (...args) => { loginCalls.push({ name, args }); throw new Error(`Test blocks ${name}`); };
  }
  const report = { appRoot, host: process.execPath, electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, isPackaged: app.isPackaged, userData: data, sessionData: session, input: 'Win32 SendInput synthetic keyboard; not physical keys', cases: [], rendererErrors: [], inputLog: [], hashes: {} };
  let ui, overlay, driver, finished = false, captureActive = false;
  const waiting = new Map();
  let request = 0;
  const save = () => fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  const finish = async error => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) { report.fatal = error.stack; console.error('FAIL:', error); }
    report.finalWindows = BrowserWindow.getAllWindows().map(win => ({ url: win.webContents.getURL(), loading: win.webContents.isLoading() }));
    if (driver && driver.exitCode === null) {
      const closed = once(driver, 'close');
      driver.stdin.end(); // Driver finally releases only keys owned by test.
      await Promise.race([closed, pause(2500)]);
      if (driver.exitCode === null) { report.driverCleanup = 'FAIL: driver did not exit'; driver.kill(); }
    }
    if (overlay && !overlay.isDestroyed()) {
      try { report.observation = await overlay.webContents.executeJavaScript('window.__keybindLive'); } catch (e) { report.observationError = e.message; }
    }
    report.loginCalls = loginCalls;
    report.summary = Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map(status => [status, report.cases.filter(c => c.status === status).length]));
    const failed = !!error || loginCalls.length > 0 || report.rendererErrors.length > 0 || report.summary.FAIL > 0 || !!report.driverCleanup;
    report.result = failed ? 'FAIL' : report.summary.SKIP > 1 ? 'SKIP' : 'PASS';
    save();
    console.log(`${report.result}: ${JSON.stringify(report.summary)}; login calls ${loginCalls.length}; renderer errors ${report.rendererErrors.length}`);
    app.once('will-quit', () => app.exit(failed ? 1 : 0));
    app.quit(); // Real main before-quit cleanup runs; never closes user's app.
  };
  const watchdog = setTimeout(() => { void finish(new Error('Electron E2E timeout after 65000ms')); }, 65000);
  process.on('uncaughtException', error => { void finish(error); });
  process.on('unhandledRejection', error => { void finish(error instanceof Error ? error : new Error(String(error))); });
  const run = script => ui.webContents.executeJavaScript(script);
  const observe = script => overlay.webContents.executeJavaScript(script);
  const state = () => run('window.cq.getState()');
  const wait = async (predicate, label, timeout = 2500) => {
    const deadline = Date.now() + timeout;
    do { const value = await predicate(); if (value) return value; await pause(20); } while (Date.now() < deadline);
    throw new Error(`Timeout: ${label}`);
  };
  const dom = () => observe(`(() => ({ primary: getComputedStyle(document.getElementById('primary')).display, secondary: getComputedStyle(document.getElementById('secondary')).display, actions: window.__keybindLive.actions.slice() }))()`);
  const display = expected => wait(async () => (await dom()).primary === expected, `primary display ${expected}`);
  const check = async (name, fn) => {
    const entry = { name, started: new Date().toISOString() };
    try { await fn(); entry.status = 'PASS'; }
    catch (error) { entry.status = error.skip ? 'SKIP' : 'FAIL'; entry.error = error.stack; console.error(`${entry.status}: ${name}: ${error.message}`); }
    if (overlay && !overlay.isDestroyed()) entry.dom = await dom();
    const native = Object.entries(require.cache).find(([file]) => file.endsWith('crosshairq.node'))?.[1].exports;
    if (native?.getKeyboardSnapshot) entry.keyboardSnapshot = native.getKeyboardSnapshot();
    if (captureActive) await capture(false);
    if (driver?.exitCode === null) await send('release');
    entry.finished = new Date().toISOString(); report.cases.push(entry); save();
    console.log(`${entry.status}: ${name}`);
  };
  const skip = message => { const error = new Error(message); error.skip = true; throw error; };
  const send = async (op, keys = []) => {
    if (op !== 'release' && process.env.CQ_TEST_ALLOW_BACKGROUND_KEYS !== '1') { ui.show(); ui.focus(); await wait(() => ui.isFocused(), 'test UI foreground'); }
    const id = ++request;
    const reply = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    driver.stdin.write(JSON.stringify({ id, op, keys }) + '\n');
    const response = await reply;
    report.inputLog.push({ id, op, keys, response });
    if (!response.ok) { if (response.skip) skip(response.error); throw new Error(response.error); }
    return response;
  };
  const patch = async value => {
    const next = await run(`(async () => { window.cq.set(${JSON.stringify(value)}); return window.cq.getState(); })()`);
    assert.equal(next.validationError, null, 'IPC patch accepted');
    await wait(() => observe(`JSON.stringify(window.__keybindLive.state?.keybinds) === ${JSON.stringify(JSON.stringify(next.keybinds))}`), 'overlay received keybinds');
    return next;
  };
  let bindings;
  const configure = async (changes, extra = {}) => {
    await send('release');
    bindings = { ...bindings, ...changes };
    await patch({ hidden: false, visible: true, showSecondary: false, ...extra, keybinds: bindings });
    await display('block');
    await observe('window.__keybindLive.actions.length = 0; void 0');
  };
  const aim = (key = 'F23', pressType = 'hold', modifiers = [], enabled = true) => ({ enabled, action: 'aim', pressType, pc: { key, modifiers, platform: 'PC' }, controller: null });
  const capture = async active => {
    assert.equal(typeof active, 'boolean');
    if (!await run('typeof window.cq.setKeybindCapture === "function"')) skip('Payload preload lacks setKeybindCapture; capture IPC not available in baseline.');
    await run(`(async () => { window.cq.setKeybindCapture(${active}); return window.cq.getState(); })()`);
    captureActive = active;
    await pause(120); // IPC barrier plus several native polling periods; no production internals replaced.
  };
  const quietAim = async (expected = 'block', from = 0) => {
    await pause(180);
    const current = await dom();
    assert.equal(current.primary, expected, 'aim display remains stable');
    assert.equal(current.actions.slice(from).filter(e => e.action === 'aim' && e.pressed === true).length, 0, 'no active aim while suppressed');
  };
  try {
    assert.equal(app.isPackaged, false, 'dev Electron host disables updater/startup even for asar payload');
    assert.ok(fs.existsSync(path.join(appRoot, 'src/main/main.js')), 'selected main exists');
    report.payloadVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
    if (appRoot.endsWith('.asar')) report.archiveSha256 = crypto.createHash('sha256').update(require('original-fs').readFileSync(appRoot)).digest('hex');
    for (const relative of ['package.json', 'src/main/main.js', 'src/main/input.js', 'src/main/keymap.js', 'src/main/keybind-dispatch.js', 'src/main/state.js', 'src/ui/preload.js', 'src/overlay/preload.js', 'src/overlay/overlay.js']) {
      if (relative === 'src/main/keybind-dispatch.js' && !fs.existsSync(path.join(appRoot, relative))) { report.hashes[relative] = null; continue; } // Baseline v0.2.1 predates dispatcher.
      report.hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, relative))).digest('hex');
    }
    await app.whenReady();
    let globalKey = null;
    for (const key of ['F22', 'F21']) {
      const combo = `Control+Alt+Shift+${key}`;
      if (globalShortcut.register(combo, () => {})) { globalShortcut.unregister(combo); globalKey = key; break; }
    }
    // Isolated settings seeded BEFORE main: never acquire default Alt+Shift+Z.
    bindings = { globalShortcut: { enabled: !!globalKey, action: 'toggleHide', pressType: 'press', pc: { key: globalKey || 'F22', modifiers: ['Ctrl', 'Alt', 'Shift'], platform: 'PC' } }, aim: aim(), fire: { enabled: false, pc: { key: 'F24', modifiers: [] } }, reload: { enabled: false, pc: { key: 'F21', modifiers: [] } } };
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ keybinds: bindings, onlyInGame: false, profileDetectionEnabled: false }));
    app.on('browser-window-created', (_event, win) => {
      win.webContents.on('console-message', (event, level, message) => {
        const severity = event.level ?? level;
        if (severity === 'error' || severity >= 3) report.rendererErrors.push(event.message ?? message);
      });
      win.webContents.on('render-process-gone', (_event, details) => report.rendererErrors.push(details));
    });
    require(path.join(appRoot, 'src/main/main.js'));
    await wait(() => {
      const windows = BrowserWindow.getAllWindows();
      ui = windows.find(win => win.webContents.getURL().split('#')[0].endsWith('/ui/index.html'));
      overlay = windows.find(win => win.webContents.getURL().split('#')[0].endsWith('/overlay/overlay.html'));
      return ui && overlay && !ui.webContents.isLoadingMainFrame() && !overlay.webContents.isLoadingMainFrame();
    }, 'real UI and overlay loaded', 12000);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'real main creates UI and overlay');
    report.windows = { ui: ui.webContents.getURL(), overlay: overlay.webContents.getURL() };
    await observe(`window.__keybindLive = { actions: [], state: null };
      window.cq.onAction(payload => window.__keybindLive.actions.push({ ...payload, at: performance.now(), display: getComputedStyle(document.getElementById('primary')).display }));
      window.cq.onState(state => { window.__keybindLive.state = state; }); void 0;`);
    await patch({ hidden: false, onlyInGame: false, profileDetectionEnabled: false, keybinds: bindings });
    const initial = await state();
    report.initialStatus = { keyboard: initial.keyboardStatus, native: initial.nativeStatus, shortcut: initial.shortcutStatus };
    report.loadedNative = Object.keys(require.cache).filter(file => file.endsWith('.node')).map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    assert.equal(initial.keyboardStatus.running, true, 'real native keyboard monitor running');
    const ready = [];
    const handle = ui.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    report.backgroundKeys = process.env.CQ_TEST_ALLOW_BACKGROUND_KEYS === '1';
    const driverArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'keybind-live-driver.ps1'), '-TargetWindow', hwnd, '-TargetProcess', String(process.pid)];
    if (report.backgroundKeys) driverArgs.push('-AllowBackgroundKeys');
    driver = spawn('powershell.exe', driverArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    driver.stderr.on('data', chunk => { report.driverStderr = (report.driverStderr || '') + chunk; });
    createInterface({ input: driver.stdout }).on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.ready) ready.push(value);
        const pending = waiting.get(value.id);
        if (pending) { waiting.delete(value.id); pending.resolve(value); }
      } catch { report.driverOutput = (report.driverOutput || '') + line + '\n'; }
    });
    driver.on('error', error => { for (const pending of waiting.values()) pending.reject(error); waiting.clear(); });
    driver.on('exit', code => { for (const pending of waiting.values()) pending.reject(new Error(`Win32 driver exit ${code}`)); waiting.clear(); });
    await wait(() => ready.length, 'Win32 driver ready', 12000);
    await check('Win32 F23 hold hides overlay; release restores; hidden stays false', async () => {
      await configure({ aim: aim() });
      await send('down', [0x86]); await display('none');
      await pause(180); assert.equal((await dom()).primary, 'none', 'hold remains hidden');
      assert.equal((await state()).hidden, false, 'aim never persists global hidden');
      await send('up', [0x86]); await display('block');
      assert.deepEqual((await dom()).actions.filter(e => e.action === 'aim').map(e => e.pressed), [true, false], 'one edge per down/up');
    });
    await check('Win32 F23 toggle hides on first press; release keeps hidden; second restores', async () => {
      await configure({ aim: aim('F23', 'toggle') });
      await send('down', [0x86]); await display('none');
      await send('up', [0x86]); await pause(150); assert.equal((await dom()).primary, 'none');
      await send('down', [0x86]); await display('block'); await send('up', [0x86]);
    });
    await check('repeated keydown keeps one toggle edge and remains blocked after capture until release', async () => {
      await configure({ aim: aim('F23', 'toggle') });
      await send('down', [0x86]); await display('none');
      for (let i = 0; i < 3; i++) { await send('repeat', [0x86]); await pause(50); }
      assert.equal((await dom()).primary, 'none', 'repeat does not toggle');
      assert.equal((await dom()).actions.filter(e => e.action === 'aim' && e.pressed).length, 1, 'repeat has no new action edge');
      await send('up', [0x86]);
      await capture(true); await display('block');
      await observe('window.__keybindLive.actions.length = 0; void 0');
      await send('down', [0x86]);
      for (let i = 0; i < 3; i++) await send('repeat', [0x86]);
      await quietAim(); await capture(false);
      for (let i = 0; i < 3; i++) { await send('repeat', [0x86]); await pause(50); }
      await quietAim();
      await send('up', [0x86]); await quietAim();
      await send('down', [0x86]); await display('none');
      await send('up', [0x86]);
      assert.equal((await dom()).actions.filter(e => e.action === 'aim' && e.pressed).length, 1, 'fresh press works after release');
    });
    await check('disabled aim ignores F23; re-enable restores behavior', async () => {
      await configure({ aim: aim('F23', 'hold', [], false) });
      await send('tap', [0x86]); await pause(180); assert.equal((await dom()).primary, 'block');
      assert.equal((await dom()).actions.filter(e => e.action === 'aim' && e.pressed).length, 0);
      await configure({ aim: aim() }); await send('down', [0x86]); await display('none'); await send('up', [0x86]); await display('block');
    });
    for (const [side, modifiers] of [['left', [0xa2, 0xa4, 0xa0]], ['right', [0xa3, 0xa5, 0xa1]]]) {
      await check(`${side} Ctrl+Alt+Shift+F23 holds aim; modifier release restores`, async () => {
        await configure({ aim: aim('F23', 'hold', ['Ctrl', 'Alt', 'Shift']) });
        await send('down', [0x86]); await pause(150); assert.equal((await dom()).primary, 'block', 'required modifiers missing'); await send('up', [0x86]);
        await send('down', [...modifiers, 0x86]); await display('none');
        await send('up', [modifiers[0]]); await display('block'); await send('release');
      });
    }
    for (const [modifier, left, right] of [['Ctrl', 0xa2, 0xa3], ['Alt', 0xa4, 0xa5], ['Shift', 0xa0, 0xa1]]) {
      for (const [side, code] of [['left', left], ['right', right]]) {
        await check(`${side} ${modifier}+F23 alone holds aim; releasing modifier restores`, async () => {
          await configure({ aim: aim('F23', 'hold', [modifier]) });
          await send('down', [code, 0x86]); await display('none');
          await send('up', [code]); await display('block'); await send('up', [0x86]);
        });
      }
    }
    await check('remap to F22 ignores former F23 and responds to new key', async () => {
      await configure({ aim: aim('F22') });
      await send('down', [0x86]); await pause(150); assert.equal((await dom()).primary, 'block'); await send('up', [0x86]);
      await send('down', [0x85]); await display('none'); await send('up', [0x85]); await display('block');
    });
    await check('hold release preserves explicit hidden gate', async () => {
      await configure({ aim: aim() }); await send('down', [0x86]); await display('none');
      await patch({ hidden: true }); await send('up', [0x86]); await pause(150); assert.equal((await dom()).primary, 'none');
      await patch({ hidden: false }); await display('block');
    });
    await check('rare global shortcut toggles persisted hidden and overlay DOM twice', async () => {
      if (!globalKey) skip('Ctrl+Alt+Shift+F22/F21 occupied; no occupant stopped');
      await configure({ aim: aim('F23', 'hold', [], false) });
      if (!(await state()).shortcutStatus?.registered) skip('rare shortcut registration unavailable after preflight');
      const keys = [0xa2, 0xa4, 0xa0, globalKey === 'F22' ? 0x85 : 0x84];
      await send('tap', keys); await display('none'); assert.equal((await state()).hidden, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).hidden, true, 'global hide persisted');
      await send('tap', keys); await display('block'); assert.equal((await state()).hidden, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).hidden, false, 'global restore persisted');
    });
    await check('capture suppresses dynamic global shortcut; fresh presses after capture toggle and restore hidden', async () => {
      if (!globalKey) skip('Ctrl+Alt+Shift+F22/F21 occupied; no occupant stopped');
      await capture(false);
      await configure({ aim: aim('F23', 'hold', [], false) });
      const status = (await state()).shortcutStatus;
      if (!status?.registered) skip('rare shortcut registration unavailable after preflight');
      assert.equal(status.accelerator, `Control+Alt+Shift+${globalKey}`, 'dynamic global binding is active');
      const keys = [0xa2, 0xa4, 0xa0, globalKey === 'F22' ? 0x85 : 0x84];
      await capture(true);
      await send('tap', keys); await pause(180);
      assert.equal((await state()).hidden, false, 'capture suppresses global toggle');
      assert.equal((await dom()).primary, 'block', 'capture leaves overlay visible');
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).hidden, false, 'capture does not persist global hide');
      await capture(false);
      assert.equal((await state()).hidden, false, 'capture exit does not replay suppressed shortcut');
      await send('down', keys); await display('none');
      assert.equal((await state()).hidden, true, 'fresh press toggles after capture');
      await send('up', keys); await pause(180);
      assert.equal((await state()).hidden, true, 'release does not toggle global shortcut');
      assert.equal((await dom()).primary, 'none');
      await send('down', keys); await display('block');
      assert.equal((await state()).hidden, false, 'second fresh press restores hidden');
      await send('up', keys); await pause(180);
      assert.equal((await state()).hidden, false, 'restoration survives release');
      assert.equal((await dom()).primary, 'block');
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).hidden, false, 'restored state persisted');
    });
    await check('capture true suppresses toggle; capture false blocks held F23 until release and new press', async () => {
      await capture(false); // Missing channel is a declared baseline SKIP, never a silent pass.
      await configure({ aim: aim('F23', 'toggle') });
      await capture(true);
      await observe('window.__keybindLive.actions.length = 0; void 0');
      await send('tap', [0x86]); await quietAim();
      await send('down', [0x86]); await quietAim();
      await capture(false); await quietAim();
      await send('up', [0x86]); await quietAim();
      await send('down', [0x86]); await display('none');
      await send('up', [0x86]); await pause(150); assert.equal((await dom()).primary, 'none', 'new press toggles normally after capture');
      await send('down', [0x86]); await display('block'); await send('up', [0x86]);
    });
    await check('capture entry resets active toggle and suppressed taps cannot relatch it', async () => {
      await capture(false);
      await configure({ aim: aim('F23', 'toggle') });
      await send('down', [0x86]); await display('none'); await send('up', [0x86]);
      await capture(true); await display('block');
      await observe('window.__keybindLive.actions.length = 0; void 0');
      await send('tap', [0x86]); await quietAim();
      await capture(false); await quietAim();
      await send('down', [0x86]); await display('none'); await send('up', [0x86]);
      await send('down', [0x86]); await display('block'); await send('up', [0x86]);
    });
    await check('F23 zero-delay down/up batch preserves each toggle edge and final display', async () => {
      await configure({ aim: aim('F23', 'toggle') });
      for (let i = 0; i < 4; i++) {
        const reply = await send('tap-fast', [0x86]);
        assert.ok(Number.isFinite(reply.elapsedMs) && reply.elapsedMs >= 0, 'driver records SendInput batch duration');
        await display(i % 2 === 0 ? 'none' : 'block');
        await wait(async () => (await dom()).actions.filter(e => e.action === 'aim' && e.pressed === true).length >= i + 1, 'short tap produces aim press');
      }
      assert.equal((await dom()).actions.filter(e => e.action === 'aim' && e.pressed === true).length, 4, 'exactly one toggle activation per short tap');
      assert.equal((await state()).hidden, false);
    });
    await check('disable resets latched aim toggle; re-enable stays clear until next press', async () => {
      await configure({ aim: aim('F23', 'toggle') });
      await send('down', [0x86]); await display('none'); await send('up', [0x86]);
      bindings = { ...bindings, aim: aim('F23', 'toggle', [], false) };
      await patch({ keybinds: bindings }); await display('block');
      bindings = { ...bindings, aim: aim('F23', 'toggle') };
      await patch({ keybinds: bindings }); await display('block');
      await observe('window.__keybindLive.actions.length = 0; void 0'); await quietAim();
      await send('down', [0x86]); await display('none'); await send('up', [0x86]);
      await send('down', [0x86]); await display('block'); await send('up', [0x86]);
    });
    await check('switching profile resets latched aim toggle even with identical binding', async () => {
      await configure({ aim: aim('F23', 'toggle') });
      const original = (await state()).profiles.currentProfileId;
      let target;
      try {
        const created = await run(`(async () => { window.cq.createProfile('keybind-live reset'); return window.cq.getState(); })()`);
        target = created.profiles.currentProfileId;
        assert.notEqual(target, original, 'isolated profile created and selected');
        await run(`(async () => { window.cq.setProfile(${JSON.stringify(original)}); return window.cq.getState(); })()`);
        await wait(async () => (await state()).profiles.currentProfileId === original, 'original profile selected');
        await display('block');
        await send('down', [0x86]); await display('none'); await send('up', [0x86]);
        await run(`(async () => { window.cq.setProfile(${JSON.stringify(target)}); return window.cq.getState(); })()`);
        await wait(() => observe(`window.__keybindLive.state?.profiles?.currentProfileId === ${JSON.stringify(target)}`), 'new profile reaches overlay');
        await display('block');
        await observe('window.__keybindLive.actions.length = 0; void 0'); await quietAim();
        await send('down', [0x86]); await display('none'); await send('up', [0x86]);
      } finally {
        await send('release');
        await run(`(async () => { window.cq.setProfile(${JSON.stringify(original)}); ${target && target !== original ? `window.cq.deleteProfile(${JSON.stringify(target)});` : ''} return window.cq.getState(); })()`);
      }
    });
    await check('repeated keydown never restarts fire hold or repeats reload', async () => {
      const savedFire = bindings.fire, savedReload = bindings.reload;
      try {
        await configure({ aim: aim('F23', 'hold', [], false),
          fire: { enabled: true, pressType: 'hold', pc: { key: 'F24', modifiers: [] } },
          reload: { enabled: true, pressType: 'press', pc: { key: 'F23', modifiers: [] } } });
        for (const [action, key] of [['fire', 0x87], ['reload', 0x86]]) {
          await send('down', [key]);
          await wait(async () => (await dom()).actions.some(e => e.action === action && e.pressed), `${action} initial press`);
          for (let i = 0; i < 3; i++) { await send('repeat', [key]); await pause(50); }
          await send('up', [key]); await pause(100);
          assert.deepEqual((await dom()).actions.filter(e => e.action === action).map(e => e.pressed), action === 'fire' ? [true, false] : [true], `${action} ignores repeated keydown`);
        }
      } finally { await configure({ aim: aim(), fire: savedFire, reload: savedReload }); }
    });
    await check('mouse remap persists through IPC; former keyboard binding stops hiding', async () => {
      await configure({ aim: aim('RightClick', 'hold', ['Ctrl']) }); assert.equal((await state()).keybinds.aim.pc.key, 'RightClick');
      await send('down', [0x86]); await pause(150); assert.equal((await dom()).primary, 'block'); await send('up', [0x86]);
    });
    await check('positive mouse remap from native hook', async () => skip('No global mouse clicks/movement injected; positive path requires controlled physical input or separate desktop.'));
    await check('startup/login hooks untouched; userData and sessionData isolated', async () => {
      assert.deepEqual(loginCalls, []); assert.equal(app.getPath('userData'), data); assert.equal(app.getPath('sessionData'), session);
      assert.equal((await run('window.cq.getUpdateState()')).reason, 'development');
    });
    await finish();
  } catch (error) { await finish(error); }
}
