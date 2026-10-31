// Smoke test for CrosshairQ window chrome.
// Run: node test/window-chrome.cjs   (from app/)
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appDir = path.resolve(__dirname, '..');
const electronPath = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainSrc = fs.readFileSync(path.join(appDir, 'src', 'main', 'main.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(appDir, 'src', 'ui', 'index.html'), 'utf8');
const stdout = [];
const stderr = [];
const passes = [];
const failures = [];
let userData = null;

function recordPass(name) { passes.push(name); console.log(`PASS: ${name}`); }
function recordFail(name, error) {
  const msg = error && error.message ? error.message : String(error);
  failures.push({ name, error: msg });
  console.error(`FAIL: ${name}: ${msg}`);
}
async function check(name, fn) {
  try { await fn(); recordPass(name); }
  catch (e) { recordFail(name, e); throw new Error(name + ': ' + (e && e.message ? e.message : e)); }
}

let child = null;
let childError = null;
let isCleaningUp = false;
let hardTimeout = null;

function isChildExited(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null;
}

async function removeUserData(dir, optionsOrRetries = 10, delayMs = 200, rmFn = fs.rmSync) {
  if (!dir || !fs.existsSync(dir)) return true;
  const opts = typeof optionsOrRetries === 'object' && optionsOrRetries !== null
    ? optionsOrRetries
    : { maxRetries: optionsOrRetries, delayMs, rmFn };
  const retries = opts.maxRetries ?? 10;
  const delay = opts.delayMs ?? 200;
  const rm = opts.rmFn ?? fs.rmSync;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (attempt === retries) {
        console.error(`FAIL: unable to remove userData ${dir} after ${retries} attempts:`, err);
        return false;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
}

async function cleanupCore({
  code = 0,
  childProc = child,
  profileDir = userData,
  exitFn = null,
  killFn = null,
  removeFn = removeUserData,
  waitTimeoutMs = 5000,
} = {}) {
  let finalCode = code;

  if (childProc && !isChildExited(childProc)) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitTimeoutMs);
      const onExit = () => { clearTimeout(timer); resolve(); };
      childProc.once('exit', onExit);
      if (killFn) {
        killFn(childProc);
      } else {
        try {
          execFileSync('taskkill', ['/PID', String(childProc.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          try { childProc.kill('SIGKILL'); } catch {}
        }
      }
    });

    if (!isChildExited(childProc)) {
      console.error(`FAIL: process PID ${childProc.pid} did not exit within timeout; retaining profile at ${profileDir}`);
      finalCode = 1;
      if (exitFn) exitFn(finalCode);
      return finalCode;
    }
  }

  if (profileDir) {
    const ok = await removeFn(profileDir);
    if (!ok) {
      finalCode = 1;
    }
  }

  if (exitFn) exitFn(finalCode);
  return finalCode;
}

async function cleanup(code) {
  if (isCleaningUp) return;
  isCleaningUp = true;
  if (hardTimeout) {
    try { clearTimeout(hardTimeout); } catch {}
  }
  return await cleanupCore({
    code,
    childProc: child,
    profileDir: userData,
    exitFn: process.exit,
    waitTimeoutMs: 5000,
  });
}

let wsState = { id: 0, pending: new Map() };
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new (globalThis.WebSocket)(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('websocket error'));
    setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.onmessage = (event) => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id && wsState.pending.has(msg.id)) {
        const p = wsState.pending.get(msg.id); wsState.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)); else p.resolve(msg.result);
      }
    };
  });
}
function cdpSend(ws, method, params = {}, timeout = 10000) {
  const id = ++wsState.id;
  return new Promise((resolve, reject) => {
    wsState.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (wsState.pending.has(id)) { wsState.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, timeout);
  });
}
async function evalExpr(ws, expression, awaitPromise = false) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}
const closeEnough = (a, b, tol = 2) => Math.abs(a - b) <= tol;

function assertRegions(r) {
  assert.ok(r, 'regions result must be present');
  assert.equal(r.topbar, 'drag', 'topbar must be -webkit-app-region: drag');
  assert.ok(Array.isArray(r.btns), 'btns must be an array');
  assert.equal(r.btns.length, 3, 'all 3 window control buttons must be inspected');
  for (const b of r.btns) {
    assert.equal(b.region, 'no-drag', `${b.id} must be -webkit-app-region: no-drag`);
  }
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 15000, childProc = child) {
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childError) {
      throw new Error(`Electron spawn error: ${childError.message}`);
    }
    if (childProc && isChildExited(childProc)) {
      throw new Error(`Electron child exited early with code ${childProc.exitCode ?? childProc.signalCode}`);
    }
    try {
      if (fs.existsSync(activePortFile)) {
        const text = fs.readFileSync(activePortFile, 'utf8');
        const lines = text.trim().split(/\r?\n/);
        const port = parseInt(lines[0], 10);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          return port;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for DevToolsActivePort in ${userDataDir}`);
}

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP discovery HTTP ${res.status}`);
  return await res.json();
}
async function waitForUi(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await targets(port);
      const ui = t.find((x) => x.type === 'page' && /ui\/index\.html/.test(x.url || ''));
      if (ui && ui.webSocketDebuggerUrl) return { ui, targets: t };
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('UI target not found via CDP discovery');
}

async function run() {
  const tempRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
    : path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(tempRoot, { recursive: true });
  userData = fs.mkdtempSync(path.join(tempRoot, 'cq-window-chrome-'));

  hardTimeout = setTimeout(async () => {
    console.error('FAIL: hard timeout');
    await cleanup(1);
  }, 25000);

  try {
    await check('main BrowserWindow options in src/main/main.js', async () => {
      assert.match(mainSrc, /width:\s*1280,\s*height:\s*820,\s*minWidth:\s*1040,\s*minHeight:\s*660/);
      assert.match(mainSrc, /frame:\s*false/);
    });
    await check('IPC cq:window-control handlers in main.js', async () => {
      assert.match(mainSrc, /ipcMain\.on\(\s*['"]cq:window-control['"]/);
      assert.match(mainSrc, /action === 'minimize'/);
      assert.match(mainSrc, /action === 'maximize'/);
      assert.match(mainSrc, /action === 'close'/);
    });
    await check('topbar drag/no-drag CSS in index.html', async () => {
      assert.match(indexSrc, /-webkit-app-region:\s*drag;/);
      assert.match(indexSrc, /-webkit-app-region:\s*no-drag;/);
    });

    child = spawn(electronPath, [appDir, '--remote-debugging-port=0', `--user-data-dir=${userData}`], {
      cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    console.log(`Electron PID ${child.pid}; userData ${userData}`);
    child.on('error', (err) => {
      childError = err;
      console.error('FAIL: Electron spawn error:', err);
    });
    child.stdout.on('data', (d) => { const s = String(d).trim(); if (s) { stdout.push(s); } });
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) { stderr.push(s); console.error(s); } });
    child.on('exit', (code) => { if (code && code !== 0) console.error(`Electron exited ${code}`); });

    let port;
    await check('CDP discovery URL via DevToolsActivePort', async () => {
      port = await waitForDevToolsPort(userData, 15000, child);
      assert.ok(port > 0, `invalid port ${port}`);
      const r = await waitForUi(port, 16000);
      assert.ok(r.targets && r.targets.length > 0);
    });
    const { ui } = await waitForUi(port, 2000);
    const ws = await connectCdp(ui.webSocketDebuggerUrl);
    await cdpSend(ws, 'Runtime.enable');
    await new Promise((r) => setTimeout(r, 700));

    await check('topbar computed -webkit-app-region', async () => {
      const r = await evalExpr(ws, `(() => {
        const g = (e) => e ? (getComputedStyle(e).getPropertyValue('-webkit-app-region') || '').trim() : '';
        return {
          topbar: g(document.querySelector('.topbar')),
          btns: ['#btnWinMin','#btnWinMax','#btnWinClose'].map((s) => ({ id: s.slice(1), region: g(document.querySelector(s)) }))
        };
      })()`);
      assertRegions(r);
    });

    await check('main window outer size 1280x820', async () => {
      const d = await evalExpr(ws, `({w:window.outerWidth,h:window.outerHeight,iw:window.innerWidth,ih:window.innerHeight})`);
      assert.ok(closeEnough(d.w, 1280) || closeEnough(d.iw, 1280), `outerWidth ${d.w}, innerWidth ${d.iw}`);
      assert.ok(closeEnough(d.h, 820) || closeEnough(d.ih, 820), `outerHeight ${d.h}, innerHeight ${d.ih}`);
    });

    const allRoutes = ['crosshairs', 'designer', 'positions', 'keybinds', 'startup'];
    async function routesAt(label) {
      await check(`all 5 routes render without clipping at ${label}`, async () => {
        for (const route of allRoutes) {
          await evalExpr(ws, `(() => { const b = document.querySelector('[data-route="${route}"]'); if (b) b.click(); return true; })()`);
          await new Promise((r) => setTimeout(r, 250));
          const info = await evalExpr(ws, `(() => {
            const page = document.querySelector('.page.on');
            const vals = [document.documentElement.scrollWidth, document.body.scrollWidth];
            const c = document.getElementById('content'); if (c) vals.push(c.scrollWidth);
            const close = document.querySelector('.winbtn.close')?.getBoundingClientRect();
            return { pageId: page?.id || null, maxScroll: Math.max(...vals), innerW: window.innerWidth, closeRight: close?.right, closeLeft: close?.left, closeTop: close?.top, closeBottom: close?.bottom };
          })()`);
          assert.equal(info.pageId, 'page-' + route, `${route} not visible`);
          assert.ok(info.maxScroll <= info.innerW + 1, `${route} horizontal overflow ${info.maxScroll}>${info.innerW}`);
          assert.ok(info.closeRight <= info.innerW + 1 && info.closeLeft >= -1, 'close clipped horizontally');
          assert.ok(info.closeBottom <= 51 && info.closeTop >= -1, 'close not in topbar');
        }
      });
    }
    await routesAt('1280x820');

    await check('startup tray switch supports Tab focus-visible and Space toggle/restore', async () => {
      const initial = await evalExpr(ws, `(() => {
        const target = document.getElementById('optionMinimizeToTray');
        document.getElementById('showSecondary').focus();
        return { page: document.querySelector('.page.on')?.id, disabled: target.disabled, checked: target.checked };
      })()`);
      assert.equal(initial.page, 'page-startup');
      assert.equal(initial.disabled, false, 'tray switch must be enabled');
      async function press(key, code, windowsVirtualKeyCode) {
        for (const type of ['keyDown', 'keyUp']) {
          await cdpSend(ws, 'Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode });
        }
      }
      assert.equal(await evalExpr(ws, `document.activeElement.id === 'optionMinimizeToTray'`), false);
      for (let tabs = 0; tabs < 8; tabs++) {
        await press('Tab', 'Tab', 9);
        if (await evalExpr(ws, `document.activeElement.id === 'optionMinimizeToTray'`)) break;
      }
      const focused = await evalExpr(ws, `(() => {
        const target = document.getElementById('optionMinimizeToTray');
        const style = getComputedStyle(target.nextElementSibling);
        return { active: document.activeElement === target, visible: target.matches(':focus-visible'),
          sibling: target.nextElementSibling.tagName, outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
      })()`);
      assert.equal(focused.active, true, 'Tab must focus tray switch within 8 presses');
      assert.equal(focused.visible, true, 'tray switch must match :focus-visible');
      assert.equal(focused.sibling, 'I', 'focus outline must belong to adjacent i');
      assert.ok(!['none', 'hidden'].includes(focused.outlineStyle), `outlineStyle ${focused.outlineStyle}`);
      assert.ok(focused.outlineWidth >= 2, `outlineWidth ${focused.outlineWidth}px < 2px`);
      for (const expected of [!initial.checked, initial.checked]) {
        await press(' ', 'Space', 32);
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(await evalExpr(ws, `document.getElementById('optionMinimizeToTray').checked`), expected,
          'Space must toggle then restore checked');
      }
      console.log(`UI1: ${JSON.stringify({ ...focused, initialChecked: initial.checked, restoredChecked: initial.checked })}`);
    });

    await check('window accepts minimum 1040x660', async () => {
      await evalExpr(ws, `window.resizeTo(1040,660); true`);
      await new Promise((r) => setTimeout(r, 400));
      const d = await evalExpr(ws, `({w:window.outerWidth,h:window.outerHeight,iw:window.innerWidth,ih:window.innerHeight})`);
      assert.ok(closeEnough(d.w, 1040, 20) || closeEnough(d.iw, 1040, 5), `outerWidth ${d.w}, innerWidth ${d.iw}`);
      assert.ok(closeEnough(d.h, 660, 20) || closeEnough(d.ih, 660, 5), `outerHeight ${d.h}, innerHeight ${d.ih}`);
    });
    await routesAt('1040x660');

    await evalExpr(ws, `window.resizeTo(1280,820); true`);
    await new Promise((r) => setTimeout(r, 300));

    await check('window control buttons visible in topbar', async () => {
      const r = await evalExpr(ws, `(() => {
        const rect = (id) => { const e = document.querySelector(id); const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right, t: b.top, b: b.bottom }; };
        return { min: rect('#btnWinMin'), max: rect('#btnWinMax'), close: rect('#btnWinClose'), cls: !!document.querySelector('.winbtn.close'), innerW: window.innerWidth };
      })()`);
      for (const key of ['min', 'max', 'close']) {
        const q = r[key];
        assert.ok(q.w > 0 && q.h > 0, `${key} zero size`);
        assert.ok(q.r <= r.innerW + 1 && q.l >= -1, `${key} clipped horizontally`);
        assert.ok(q.b <= 51 && q.t >= -1, `${key} not in topbar`);
      }
      assert.ok(r.cls);
    });

    await check('iframe loads with at least 1 #layers item', async () => {
      await evalExpr(ws, `(() => { const b = document.querySelector('[data-route="designer"]'); if (b) b.click(); return true; })()`);
      const count = await evalExpr(ws, `new Promise((resolve) => {
        let n = 0;
        const check = () => {
          const frame = document.getElementById('designerFrame');
          const doc = frame?.contentDocument;
          const lis = doc ? doc.querySelectorAll('#layers li, #layers > li') : [];
          if (lis.length) return resolve(lis.length);
          if (++n >= 100) return resolve(0);
          setTimeout(check, 80);
        };
        check();
      })`, true);
      assert.ok(count >= 1, `iframe #layers has ${count}`);
    });

    // close not tested.
    try { ws.close(); } catch {}
    if (failures.length) throw new Error(`${failures.length} checks failed`);
    console.log(`PASS: window-chrome smoke (${passes.length}/${passes.length})`);
    await cleanup(0);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    await cleanup(1);
  }
}

if (require.main === module) {
  run();
} else {
  module.exports = {
    waitForDevToolsPort,
    removeUserData,
    cleanup,
    cleanupCore,
    assertRegions,
    closeEnough,
    isChildExited,
  };
}
