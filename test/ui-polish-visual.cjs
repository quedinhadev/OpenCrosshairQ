// Run: node test/ui-polish-visual.cjs. Renderer integration, no production main.
// Real UI/preload/designer/CSS; fixture IPC, instrumented AudioContext/focus only.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!process.env.CQ_POLISH_CHILD) {
  if (process.versions.electron) {
    console.error('FAIL: run with node; parent must clean isolated profile after child close');
    require('electron').app.exit(1);
  } else parent().catch(error => { console.error(error); process.exitCode = 1; });
} else child().catch(error => { console.error(error); require('electron').app.exit(1); });

async function parent() {
  const temp = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(temp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(temp, 'cq-polish-'));
  const out = path.resolve(__dirname, '../../analysis', `ui-polish-${Date.now()}-${process.pid}`);
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, CQ_POLISH_CHILD: '1', CQ_POLISH_PROFILE: profile, CQ_POLISH_OUT: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require('electron');
  const proc = spawn(electron, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const meta = { command: 'node test/ui-polish-visual.cjs', electron, pid: proc.pid, parentPid: process.pid, profile, out };
  const log = fs.createWriteStream(path.join(out, 'electron.log'));
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`FAIL: 75000ms timeout; ending only test PID ${proc.pid} tree`);
    spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  }, 75000);
  let code;
  try { [code] = await once(proc, 'close'); }
  finally { clearTimeout(timer); log.end(); }
  meta.exitCode = code; meta.timedOut = timedOut;
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); meta.cleanup = 'removed after child close'; }
  catch (error) { meta.cleanup = `preserved: ${error.code}`; }
  fs.writeFileSync(path.join(out, 'launch.json'), JSON.stringify(meta, null, 2));
  console.log('Artifacts:', out);
  process.exitCode = timedOut || code !== 0 ? 1 : 0;
}

async function child() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const profile = process.env.CQ_POLISH_PROFILE;
  const out = process.env.CQ_POLISH_OUT;
  const session = path.join(profile, 'session');
  fs.mkdirSync(session, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', session);
  const loginCalls = [];
  for (const name of ['getLoginItemSettings', 'setLoginItemSettings']) app[name] = () => { loginCalls.push(name); throw new Error(`Test blocks ${name}`); };
  const report = { scope: 'real renderers, CSS and preload; fixture IPC; instrumented audio and document focus; no production main/native hooks', electron: process.versions.electron, profile, session, cases: [], rendererErrors: [], loginCalls };
  let ui, ended = false;
  const finish = error => {
    if (ended) return;
    ended = true; clearTimeout(timer);
    if (error) report.fatal = error.stack;
    report.summary = { PASS: report.cases.filter(c => c.status === 'PASS').length, FAIL: report.cases.filter(c => c.status === 'FAIL').length };
    const failed = !!error || report.summary.FAIL > 0 || report.rendererErrors.length > 0 || loginCalls.length > 0;
    report.result = failed ? 'FAIL' : 'PASS';
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`${report.result}: ${JSON.stringify(report.summary)}; renderer errors ${report.rendererErrors.length}; login calls ${loginCalls.length}`);
    app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit();
  };
  const timer = setTimeout(() => finish(new Error('Renderer QA timeout after 60000ms')), 60000);
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', error => finish(error instanceof Error ? error : new Error(String(error))));
  const run = script => ui.webContents.executeJavaScript(script);
  const check = async (name, fn) => {
    const entry = { name };
    try { entry.evidence = await fn(); entry.status = 'PASS'; }
    catch (error) { entry.status = 'FAIL'; entry.error = error.stack; console.error(error); }
    report.cases.push(entry); console.log(`${entry.status}: ${name}`);
  };
  const wait = async (fn, message) => {
    const deadline = Date.now() + 6000;
    do { const value = await fn(); if (value) return value; await pause(20); } while (Date.now() < deadline);
    throw new Error(`Timeout: ${message}`);
  };
  try {
    // State is data-only fixture. No production main, global shortcuts, native input,
    // startup, tray or updater code runs; backend may integrate independently.
    const G = require('../src/shared/geometry');
    const Layers = require('../src/shared/layers');
    const keybinds = {
      globalShortcut: { enabled: false, pressType: 'press', pc: { key: 'F22', modifiers: ['Ctrl', 'Alt', 'Shift'] } },
      aim: { enabled: false, pressType: 'hold', pc: { key: 'F23', modifiers: [] } },
      fire: { enabled: false, pc: { key: 'F24', modifiers: [] } }, reload: { enabled: false, pc: { key: 'F21', modifiers: [] } },
    };
    let state = { visible: true, hidden: false, scale: 1, offsetX: 0, offsetY: 0, crosshairSize: 1, crosshairOffset: { x: 0, y: 0 }, model: G.defaultModel(), model2: G.defaultModel(), layers: [], drawing: null, keybinds, onlyInGame: false, profileInFocus: true, profileDetectionEnabled: false, animations: true, captureVisible: true, minimizeToTray: false, startMinimized: false, shortcutStatus: { registered: false, error: null }, keyboardStatus: { running: false, error: null }, nativeStatus: { available: false, error: null }, validationError: null, profiles: { currentProfileId: 'default', profiles: { default: { id: 'default', name: 'default', process: null } } } };
    const emit = patch => { state = { ...state, ...patch }; ui.webContents.send('cq:state', state); };
    const update = { supported: false, reason: 'development', currentVersion: 'qa', state: 'idle' };
    const startup = { supported: true, available: false, configured: null, approved: null, enabled: null, error: 'Isolated renderer fixture' };
    for (const [channel, fn] of Object.entries({
      'cq:get-state': () => state, 'cq:get-displays': () => [{ id: 1, label: 'QA', bounds: { x: 0, y: 0, width: 1120, height: 760 }, scaleFactor: 1 }],
      'cq:get-profiles': () => Object.values(state.profiles.profiles), 'cq:get-native-status': () => state.nativeStatus,
      'cq:get-startup-status': () => startup, 'cq:update-state': () => update, 'cq:get-streaming': () => ({ running: false, port: null, streaming: null }),
    })) ipcMain.handle(channel, fn);
    ipcMain.on('cq:set', (event, patch) => { assert.equal(event.sender, ui.webContents); emit(patch); });
    await app.whenReady();
    ui = new BrowserWindow({ width: 1120, height: 760, show: false, webPreferences: { preload: path.resolve(__dirname, '../src/ui/preload.js'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
    ui.webContents.on('console-message', (event, level, message) => { if (event.level === 'error' || level >= 3) report.rendererErrors.push(event.message ?? message); });
    ui.webContents.on('render-process-gone', (_event, details) => report.rendererErrors.push(details));
    await ui.loadURL('about:blank');
    ui.webContents.debugger.attach('1.3');
    const cdp = (method, params = {}) => { report.stage = method; console.log('CDP:', method); return ui.webContents.debugger.sendCommand(method, params); };
    await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
      if (window === window.top) {
        window.__polish = { focus: true, audio: [], cues: [] };
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => window.__polish.focus });
        class QAContext {
          constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
          createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() { window.__polish.audio.push({ at: performance.now() }); }, stop() { this.onended?.(); } }; }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
        }
        window.AudioContext = QAContext;
        window.addEventListener('message', event => { if (event.data?.source === 'cq-designer' && event.data.type === 'cq:ui-sfx') window.__polish.cues.push({ cue: event.data.cue, at: performance.now() }); });
      }
    ` });
    ui.loadFile(path.resolve(__dirname, '../src/ui/index.html')).catch(error => { report.loadError = error.message; });
    await wait(() => !ui.webContents.isLoadingMainFrame(), 'UI main frame loaded');
    await wait(() => run(`!!window.__polish && !!document.getElementById('optionSounds') && !!document.querySelector('.page.on')`), 'real UI initialized');
    ui.showInactive();
    const screenshot = async name => { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64')); };
    for (const [width, height] of [[1120, 760], [900, 650]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const route of ['crosshairs', 'keybinds', 'startup']) await check(`layout ${route} ${width}`, async () => {
        await run(`location.hash = '#/${route}'`); await pause(240);
        const data = await run(`({ route: ${JSON.stringify(route)}, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, page: [...document.querySelectorAll('.page.on')].map(el => el.id) })`);
        assert.equal(data.width, width); assert.equal(data.overflow, false);
        if (route === 'keybinds') {
          data.offButtons = await run(`Array.from(document.querySelectorAll('.kb-toggle button:first-child.on')).map(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))`);
          assert.ok(data.offButtons.length > 0);
          for (const button of data.offButtons) { assert.equal(button.background, 'rgb(39, 47, 64)'); assert.equal(button.color, 'rgb(242, 245, 249)'); }
        }
        await screenshot(`${route}-${width}`); return data;
      });
    }
    for (const [width, height, dpr] of [[1120, 760, 1], [901, 651, 2]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
      for (const reduced of [false, true]) await check(`long toast x stable ${width} DPR ${dpr} reduced ${reduced}`, async () => {
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
        await run(`document.getElementById('toast').classList.remove('on'); void document.getElementById('toast').offsetWidth;`);
        emit({ validationError: 'Não foi possível salvar esta configuração longa: verifique os atalhos, o perfil selecionado e tente novamente sem perder os dados atuais.' });
        await wait(() => run(`document.getElementById('toast').classList.contains('on')`), 'toast from real UI state listener');
        const animation = await run(`(() => { const el = document.getElementById('toast'); const a = el.getAnimations().find(a => a.animationName === 'cqStatusEnter'); if (a) { a.pause(); a.currentTime = 0; } return { exists: !!a, name: getComputedStyle(el).animationName, duration: a?.effect.getTiming().duration, dpr: devicePixelRatio, width: el.getBoundingClientRect().width }; })()`);
        assert.equal(animation.exists, !reduced, 'real CSS follows reduced-motion'); assert.equal(animation.dpr, dpr);
        assert.ok(animation.width > 300, 'toast message is long enough to expose horizontal jump');
        const samples = [];
        for (const [label, time] of [['start', 0], ['middle', 80], ['end', 160]]) {
          const sample = await run(`(async () => { const el = document.getElementById('toast'); const a = el.getAnimations().find(a => a.animationName === 'cqStatusEnter'); if (a) { a.currentTime = ${time}; if (${time} === 160) a.finish(); } await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return { label: ${JSON.stringify(label)}, x: rect.x, y: rect.y, width: rect.width, right: rect.right, opacity: style.opacity, transform: style.transform, animation: style.animationName }; })()`);
          samples.push(sample); await screenshot(`toast-${width}-dpr${dpr}-${reduced ? 'reduce' : 'motion'}-${label}`);
        }
        const reference = samples.at(-1);
        for (const sample of samples) {
          assert.ok(Math.abs(sample.x - reference.x) <= .75, 'horizontal position within 0.75 CSS px');
          assert.ok(Math.abs(sample.x - reference.x) * dpr <= 1.5, 'horizontal delta within 1.5 physical px at declared DPR');
          assert.ok(sample.x >= -.75 && sample.right <= width + .75, 'toast stays horizontally in viewport');
          if (reduced) assert.equal(sample.animation, 'none');
        }
        if (!reduced) { assert.ok(Number(samples[0].opacity) < .05); assert.ok(Number(samples[1].opacity) > Number(samples[0].opacity)); assert.equal(Number(reference.opacity), 1); }
        return { animation, samples, toleranceCssPx: .75, tolerancePhysicalPx: 1.5 };
      });
    }
    await check('page reduced-motion remains disabled', async () => {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await run(`getComputedStyle(document.querySelector('.page.on')).animationName`), 'none');
    });
    emit({ validationError: null });
    await run(`location.hash = '#/designer'`);
    await wait(() => run(`!!document.getElementById('designerFrame')?.contentDocument?.querySelector('#addModel')`), 'designer iframe ready');
    for (const mode of ['on-focused', 'off-focused', 'on-unfocused']) {
      await run(`(() => { window.__polish.focus = true; const option = document.getElementById('optionSounds'); option.checked = ${mode !== 'off-focused'}; option.dispatchEvent(new Event('change', { bubbles: true })); window.__polish.focus = ${mode !== 'on-unfocused'}; })()`);
      for (const action of ['hide', 'show', 'duplicate', 'delete']) await check(`designer ${action} cue ${mode}`, async () => {
        const layer = Layers.newModelLayer();
        layer.visible = action !== 'show';
        emit({ layers: [layer], drawing: Layers.renderLayers([layer]) });
        const title = { hide: 'Ocultar camada', show: 'Mostrar camada', duplicate: 'Duplicar camada', delete: 'Apagar camada' }[action];
        await wait(() => run(`!!document.getElementById('designerFrame').contentDocument.querySelector(${JSON.stringify(`button[title="${title}"]`)})`), 'layer action button');
        await pause(100); // Outside production 65ms deduplication window.
        const before = state.layers.length;
        await run(`window.__polish.audio.length = 0; window.__polish.cues.length = 0; document.getElementById('designerFrame').contentDocument.querySelector(${JSON.stringify(`button[title="${title}"]`)}).click(); void 0`);
        await pause(120);
        const evidence = await run(`({ audio: window.__polish.audio.slice(), cues: window.__polish.cues.slice(), focus: document.hasFocus(), hidden: document.hidden, sound: document.getElementById('optionSounds').checked })`);
        assert.equal(evidence.hidden, false, 'document visible; only intended focus/sound gate varies');
        assert.equal(evidence.cues.length, 1, 'one designer message despite local stopPropagation');
        assert.equal(evidence.cues[0].cue, 'click');
        assert.equal(evidence.audio.length, mode === 'on-focused' ? 1 : 0, 'one played cue only when enabled and focused');
        if (action === 'duplicate') assert.equal(state.layers.length, before + 1, 'button really duplicates layer');
        else if (action === 'delete') assert.equal(state.layers.length, before - 1, 'button really deletes layer');
        else assert.equal(state.layers[0].visible, action === 'show', 'button really changes visibility');
        return evidence;
      });
    }
    await screenshot('designer-final');
    assert.equal(app.getPath('userData'), profile); assert.equal(app.getPath('sessionData'), session);
    finish();
  } catch (error) { finish(error); }
}
