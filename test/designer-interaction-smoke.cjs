// Run: npm exec -- electron test/designer-interaction-smoke.cjs
// Smoke ISOLADO do Criador: janela própria + bridge cq stubbed no preload.
// Não requer src/main de produção; userData temporário, nunca o perfil real.
// Prova em Chromium real o que o mock de DOM não prova: captura de pointer,
// blur/lostpointercapture, reconciliação de eco por igualdade e Undo/Redo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const poll = (fn, label, ms = 4000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = async () => {
    let v;
    try { v = await fn(); } catch (e) { return reject(e); }
    if (v) return resolve(v);
    if (Date.now() - started > ms) return reject(new Error('timeout: ' + label));
    setTimeout(tick, 25);
  };
  tick();
});

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

function run({
  args = [],
  executable = require('electron'),
  childArgs,
  spawnChild = spawn,
  killer = pid => spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }),
  fallback = child => child.kill('SIGKILL'),
  killGraceMs = 1500,
} = {}) {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA required');
  const timeoutMs = Number(args.find(a => a.startsWith('--timeout-ms='))?.split('=')[1] ?? 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('timeout-ms must be 100..120000');
  if (!Number.isInteger(killGraceMs) || killGraceMs < 100 || killGraceMs > 10000) throw new Error('killGraceMs must be 100..10000');
  const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(root, 'cq-designer-run-'));
  const profile = path.join(runDir, 'profile');
  fs.mkdirSync(profile);
  childArgs ??= [path.join(__dirname, 'designer-interaction-smoke.cjs'), ...args.filter(a => !a.startsWith('--timeout-ms=') && a !== '--inject-cleanup-ebusy' && a !== '--test-cleanup-fail')];
  const env = { ...process.env, CQ_SMOKE_USER_DATA: profile };
  if (args.includes('--inject-exit1')) env.CQ_SMOKE_EXIT1 = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const result = {
    executable, args: childArgs, parentPid: process.pid, run: runDir, profile,
    timeoutMs, killGraceMs, stdout: '', stderr: '', timedOut: false, closed: false,
  };
  const started = Date.now();
  let finished = false, deadline, killProcess, fallbackUsed = false, child, timeout;
  let finishHook = () => {};
  result.done = new Promise(resolve => { finishHook = resolve; });
  result.then = result.done.then.bind(result.done);

  function finish(code, signal, deadlineExpired = false) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout); clearTimeout(deadline);
    Object.assign(result, { code, signal, deadlineExpired, durationMs: Date.now() - started, childAlive: alive(child?.pid) });
    if (result.childAlive) result.remainingPid = child.pid;
    if (!result.closed || result.childAlive || result.timedOut) {
      result.cleanup = 'retained; timeout or close not confirmed';
    } else try {
      if (args.includes('--inject-cleanup-ebusy') || args.includes('--test-cleanup-fail')) {
        throw Object.assign(new Error('CQ_SMOKE_TEST_ONLY_EBUSY'), { code: 'EBUSY' });
      }
      fs.rmSync(profile, { recursive: true, force: true });
      result.cleanup = 'removed after close';
    } catch (error) {
      result.cleanup = 'retained';
      result.cleanupError = { code: error.code, message: error.message };
      console.error('Profile cleanup failed, retained:', profile, error.message);
    }
    result.verdict = code === 0 && result.closed && !result.timedOut && !result.spawnError && !result.cleanupError ? 'PASS' : 'FAIL';
    try {
      fs.writeFileSync(path.join(runDir, 'parent.json'), JSON.stringify(result, null, 2) + '\n');
    } catch (error) {
      result.verdict = 'FAIL';
      console.error('Parent report write failed:', error.message);
    }
    console.log(`RESULT ${result.verdict} pid=${child?.pid ?? 'none'} code=${code} timeout=${result.timedOut} remainingPid=${result.remainingPid ?? 'none'} cleanup=${result.cleanup} log=${path.join(runDir, 'parent.json')}`);
    process.exitCode = result.verdict === 'PASS' ? 0 : 1;
    if (deadlineExpired) {
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }
    if (killProcess) {
      if (killProcess.exitCode === null && killProcess.signalCode === null) {
        try { killProcess.kill(); } catch (e) { console.error('Killer teardown:', e.message); }
      }
      killProcess.stdout?.destroy(); killProcess.stderr?.destroy(); killProcess.unref();
    }
    finishHook(result);
  }

  function fallbackKill(reason) {
    if (finished || fallbackUsed || !alive(child?.pid)) return;
    fallbackUsed = true;
    result.fallback = { pid: child?.pid, reason, method: 'child.kill(SIGKILL); known child only, no process-name scan; descendants not guaranteed' };
    try { result.fallback.sent = fallback(child); }
    catch (e) { result.fallback.error = e.message; console.error('Fallback kill error:', e.message); }
  }

  try {
    child = spawnChild(executable, childArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    result.pid = child.pid;
    console.log(`CHILD pid=${child.pid} run=${runDir}`);
    child.stdout?.on('data', b => { result.stdout += b; process.stdout.write(b); });
    child.stderr?.on('data', b => { result.stderr += b; process.stderr.write(b); });
    child.on('error', error => {
      result.spawnError = error.message;
      if (!result.closed && !child.pid) finish(null, null);
    });
    child.on('close', (code, signal) => { result.closed = true; finish(code, signal); });
  } catch (err) {
    result.spawnError = err.message;
    finish(null, null);
    return result;
  }

  timeout = setTimeout(() => {
    result.timedOut = true;
    deadline = setTimeout(() => {
      fallbackKill('kill deadline reached');
      result.diagnostic = 'finite kill deadline reached; close not confirmed; profile retained';
      finish(child.exitCode, child.signalCode, true);
    }, killGraceMs);
    if (alive(child.pid)) {
      result.killOutput = '';
      try {
        killProcess = killer(child.pid);
        result.killerPid = killProcess.pid;
        killProcess.stdout?.on('data', b => { result.killOutput += b; });
        killProcess.stderr?.on('data', b => { result.killOutput += b; });
        killProcess.on('error', e => { result.killError = e.message; fallbackKill('taskkill spawn error'); });
        killProcess.on('close', code => { result.killCode = code; if (code !== 0) fallbackKill('taskkill nonzero'); });
      } catch (e) { result.killError = e.message; fallbackKill('taskkill spawn throw'); }
    }
  }, timeoutMs);

  return result;
}

if (!process.versions.electron) {
  module.exports = { run, alive, poll };
  if (require.main === module) {
    const args = process.argv.slice(2);
    run({ args });
  }
} else {
const { app, BrowserWindow, ipcMain } = require('electron');
const Layers = require('../src/shared/layers.js');
const U_DEBOUNCE = require('../src/shared/undoredo.js').DEBOUNCE_MS + 50;

const data = process.env.CQ_SMOKE_USER_DATA;
if (!data || !fs.existsSync(data)) throw new Error('isolated userData required; run with node test/designer-interaction-smoke.cjs');
app.setPath('userData', data); // pai remove depois de close; falha de cleanup preserva diretório.

const layer = Layers.newModelLayer();
layer.id = 'layer-A';
let current = { profiles: { currentProfileId: 'default' }, layers: [layer] };

// Main-side espelha src/main/state.js: set valida e faz broadcast do estado novo.
ipcMain.handle('smoke:getState', () => JSON.parse(JSON.stringify(current)));
ipcMain.on('smoke:subscribe', () => {});
let win = null;
let setCount = 0;
ipcMain.on('smoke:set', (_e, patch) => {
  setCount++;
  const merged = { ...current, ...JSON.parse(JSON.stringify(patch)) };
  if (Array.isArray(patch.layers)) merged.layers = Layers.validateLayers(patch.layers);
  current = merged;
  if (win) win.webContents.send('smoke:state', JSON.parse(JSON.stringify(current)));
});

const errors = [];
const timeout = setTimeout(() => { console.error('FAIL: designer interaction smoke timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    if (process.env.CQ_SMOKE_EXIT1 === '1' || process.argv.includes('--inject-exit1')) throw new Error('injected exit 1');
    if (process.argv.includes('--teardown-only')) {
      clearTimeout(timeout);
      console.log('PASS: isolated window load; teardown follows');
      app.exit(0);
      return;
    }
    const preload = path.join(data, 'stub-preload.cjs');
    fs.writeFileSync(preload, `
      const { contextBridge, ipcRenderer } = require('electron');
      contextBridge.exposeInMainWorld('cq', {
        getState: () => ipcRenderer.invoke('smoke:getState'),
        set: (patch) => ipcRenderer.send('smoke:set', patch),
        onState: (fn) => { ipcRenderer.on('smoke:state', (_e, s) => fn(s)); ipcRenderer.send('smoke:subscribe'); },
        closeDesigner: () => true,
      });
    `);
    win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.on('render-process-gone', (_e, details) => errors.push('gone:' + details.reason));
    await win.loadFile(path.join(__dirname, '..', 'src', 'designer', 'designer.html'));
    const run = (script) => win.webContents.executeJavaScript(script);
    // Reset externo entre cenários: cada gesto parte do valor conhecido.
    const reset = async (patch) => {
      const s = JSON.parse(JSON.stringify(current));
      Object.assign(s.layers[0], patch);
      current = s;
      win.webContents.send('smoke:state', s);
      await poll(() => run(`document.querySelector('#bodyLayer .grid2 .nfield input').value`).then((v) => String(patch.x) === v ? 1 : 0), 'reset x=' + patch.x);
    };

    // Boot: injeta designer.js igual ao ui.js faz no iframe de produção.
    await run(`new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '../designer/designer.js';
      s.onload = () => resolve(true); s.onerror = () => reject(new Error('designer.js failed'));
      document.body.appendChild(s);
    })`);
    await poll(() => run(`document.querySelectorAll('#layers li').length`), 'designer boot');

    // S1: scrub real com PointerEvent — valor final persiste, Undo/Redo íntegros.
    await run(`(() => {
      const f = document.querySelector('#bodyLayer .grid2 .nfield');
      const opts = { bubbles: true, pointerId: 1 };
      f.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: 100 }, opts)));
      f.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: 140 }, opts)));
      f.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: 140 }, opts)));
      return true;
    })()`);
    await poll(() => current.layers[0].x === 40 ? 1 : 0, 'scrub echo x=40');
    assert.equal(await run(`document.querySelector('#bodyLayer .grid2 .nfield input').value`), '40', 'field shows final value');
    assert.equal(await run(`document.body.classList.contains('dragging')`), false, 'dragging class released');
    await run(`document.getElementById('undoBtn').click()`);
    await poll(() => current.layers[0].x === 0 ? 1 : 0, 'undo x=0');
    await run(`document.getElementById('redoBtn').click()`);
    await poll(() => current.layers[0].x === 40 ? 1 : 0, 'redo x=40');
    console.log('PASS: real-pointer scrub persists, Undo/Redo round-trip');

    // S2: blur no meio do gesto finaliza com o valor atual, sem segunda escrita.
    await reset({ x: 0 });
    await run(`(() => {
      const f = document.querySelector('#bodyLayer .grid2 .nfield');
      const opts = { bubbles: true, pointerId: 2 };
      f.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: 0 }, opts)));
      f.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: 20 }, opts)));
      window.dispatchEvent(new Event('blur'));
      return true;
    })()`);
    await poll(() => current.layers[0].x === 20 ? 1 : 0, 'blur finalizes x=20');
    const writes = setCount;
    await run(`(() => {
      const f = document.querySelector('#bodyLayer .grid2 .nfield');
      f.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(setCount, writes, 'repeated finalization does not rewrite');
    assert.equal(current.layers[0].x, 20, 'blur finalized value stands');
    console.log('PASS: window blur finalizes the gesture idempotently');

    // S3: lostpointercapture no label finaliza o scrub da Escala.
    await run(`(() => {
      const row = [...document.querySelectorAll('#bodyLayer .frow')].find(r => r.querySelector('.fl')?.textContent === 'Escala');
      const label = row.querySelector('.fl');
      const opts = { bubbles: true, pointerId: 3 };
      label.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: 0, currentTarget: label }, opts)));
      label.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: 40 }, opts)));
      label.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3 }));
      return true;
    })()`);
    await poll(() => Math.abs(current.layers[0].scale - 2) < 1e-9 ? 1 : 0, 'label capture commits scale=2');
    console.log('PASS: lostpointercapture on the label finalizes the scrub');

    // S4: externo no meio do gesto é diferido e aplicado no fim; eco é no-op.
    await reset({ x: 0 });
    await run(`(() => {
      const f = document.querySelector('#bodyLayer .grid2 .nfield');
      const opts = { bubbles: true, pointerId: 4 };
      f.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: 0 }, opts)));
      f.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: 25 }, opts)));
      return true;
    })()`);
    await poll(() => current.layers.length && current.layers[0].x === 25 ? 1 : 0, 'scrub move persisted');
    const ext = JSON.parse(JSON.stringify(current));
    ext.layers[0].y = 77; ext.layers[0].x = 25;
    win.webContents.send('smoke:state', ext); // externo chega com o gesto ativo
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await run(`document.querySelectorAll('#bodyLayer .grid2 .nfield')[1].querySelector('input').value`), '0', 'external deferred during gesture');
    await run(`(() => {
      const f = document.querySelector('#bodyLayer .grid2 .nfield');
      f.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4 }));
      return true;
    })()`);
    await poll(() => current.layers[0].y === 77 ? 1 : 0, 'external y=77 reconciled');
    assert.equal(await run(`document.querySelectorAll('#bodyLayer .grid2 .nfield')[1].querySelector('input').value`), '77', 'external applied at gesture end');
    assert.equal(current.layers[0].x, 25, 'scrub commit kept');
    console.log('PASS: external mid-gesture defers to gesture end and is applied');

    // S5: select focado reflete Undo (documento vence; sem rascunho de select).
    await new Promise((r) => setTimeout(r, U_DEBOUNCE)); // não coalescer com escritas do S4
    await run(`(() => {
      const sel = document.querySelector('#bodyLinhas select');
      sel.focus();
      sel.value = 'triangle';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await poll(() => current.layers[0].armShape === 'triangle' ? 1 : 0, 'armShape triangle');
    await new Promise((r) => setTimeout(r, U_DEBOUNCE)); // push de update coalesce 300ms; botão só habilita depois
    await run(`document.getElementById('undoBtn').click()`);
    await poll(() => current.layers[0].armShape === 'rect' ? 1 : 0, 'undo armShape rect');
    assert.deepEqual(await run(`(() => { const sel = document.querySelector('#bodyLinhas select'); return { v: sel.value, focused: document.activeElement === sel }; })()`), { v: 'rect', focused: true }, 'focused select mirrors document after Undo and keeps focus');
    console.log('PASS: focused select mirrors Undo (model wins, focus kept)');

    // Native Blink input, unlike dispatchEvent: capture established by Chromium.
    win.show(); win.focus();
    if (!await poll(() => win.isFocused(), 'native input window focus', 1500).catch(() => false)) {
      console.log('SKIP: native sendInputEvent, window could not receive focus');
    } else {
      await reset({ x: 0, scale: 1 });
      const point = await run(`(() => {
        const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
        const r = label.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        const outX = x + 100, outY = Math.round(r.bottom + 30);
        return { x, y, outX, outY, target: document.elementFromPoint(x, y) === label, outside: document.elementFromPoint(outX, outY) !== label && outY < innerHeight };
      })()`);
      if (!point.target || !point.outside || point.x < 110) {
        console.log('SKIP: native label occluded or outside point unavailable', point);
      } else {
        const send = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'], clickCount: 1 });
        await run(`(() => {
          const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
          window.__nativeCapture = null;
          label.addEventListener('pointerdown', e => { queueMicrotask(() => { window.__nativeCapture = { id: e.pointerId, captured: label.hasPointerCapture(e.pointerId), dragging: document.body.classList.contains('dragging'), fieldCapture: label.parentElement.querySelector('.nfield')?.hasPointerCapture(e.pointerId), active: e.isPrimary, buttons: e.buttons }; }); });
          label.addEventListener('lostpointercapture', () => { window.__nativeLost = true; });
        })()`);
        send('mouseDown', point.x, point.y);
        await poll(() => run(`window.__nativeCapture`), 'native pointerdown reaches label');
        await poll(() => run(`(() => {
          const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
          return label.hasPointerCapture(window.__nativeCapture.id);
        })()`), 'native label acquired pointer capture');
        send('mouseMove', point.outX, point.outY);
        await poll(() => current.layers[0].scale !== 1, 'native drag outside label persists');
        const scale = current.layers[0].scale;
        const beforeRelease = setCount;
        send('mouseUp', point.outX, point.outY);
        await poll(() => run(`!document.body.classList.contains('dragging')`), 'native pointer released');
        assert.equal(await run(`(() => {
          const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
          return label.hasPointerCapture(window.__nativeCapture.id);
        })()`), false, 'native pointer capture released');
        await poll(() => setCount === beforeRelease + 1, 'native release commits once');
        assert.equal(current.layers[0].scale, scale);
        await run(`document.getElementById('undoBtn').click()`);
        await poll(() => current.layers[0].scale === 1, 'native gesture Undo');
        console.log('PASS: native label captures, drags outside, releases, commits once and Undo works');

        send('mouseMove', point.x, point.y);
        await run(`window.__nativeLost = false`);
        send('mouseDown', point.x, point.y);
        await poll(() => run(`(() => {
          const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
          return label.hasPointerCapture(window.__nativeCapture.id);
        })()`), 'native label captures for lostcapture');
        send('mouseMove', point.outX, point.outY);
        await poll(() => current.layers[0].scale !== 1, 'native lostcapture move persists');
        const lostScale = current.layers[0].scale;
        await run(`(() => {
          const label = [...document.querySelectorAll('#bodyLayer .frow .fl')].find(el => el.textContent === 'Escala');
          label.releasePointerCapture(window.__nativeCapture.id);
        })()`);
        send('mouseMove', point.outX + 1, point.outY);
        await poll(() => run(`window.__nativeLost === true`), 'native lostpointercapture dispatched');
        await poll(() => run(`!document.body.classList.contains('dragging')`), 'native lostcapture finalizes');
        const afterLost = setCount;
        send('mouseUp', point.outX, point.outY);
        await new Promise(r => setTimeout(r, 100));
        assert.equal(setCount, afterLost, 'no extra write after lostpointercapture');
        assert.equal(current.layers[0].scale, lostScale);
        await run(`document.getElementById('undoBtn').click()`);
        await poll(() => current.layers[0].scale === 1, 'native lostcapture Undo');
        console.log('PASS: native down/move, explicit lostcapture, no extra write, Undo works');
      }
    }

    if (process.env.CQ_SMOKE_EXIT1 === '1' || process.argv.includes('--inject-exit1')) throw new Error('injected exit 1 after scenarios');
    assert.deepEqual(errors, [], 'no renderer console errors: ' + JSON.stringify(errors));
    console.log('PASS: designer interaction smoke (isolated Chromium, no production main)');
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('FAIL: designer interaction smoke', error.message || error);
    clearTimeout(timeout);
    if (win) try { win.destroy(); } catch (e) { console.error('win destroy error:', e.message); }
    app.exit(1);
  }
});
}
