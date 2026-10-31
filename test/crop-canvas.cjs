// Run from app: node test/crop-canvas.cjs
// Real designer.html/designer.js, real Chromium Canvas; only cq persistence is stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const poll = async (fn, label) => {
  const deadline = Date.now() + 5000;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`timeout: ${label}`);
};

if (!process.versions.electron) {
  assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA required');
  const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const run = fs.mkdtempSync(path.join(root, 'cq-crop-canvas-'));
  const profile = path.join(run, 'profile');
  fs.mkdirSync(profile); // Must exist before Electron starts.
  const env = { ...process.env, CQ_CROP_RUN: run };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = require('electron');
  const report = { command: 'node test/crop-canvas.cjs', executable, parentPid: process.pid, run, profile, closed: false, timedOut: false, stdout: '', stderr: '' };
  const child = spawn(executable, [__filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  report.pid = child.pid;
  console.log(`CHILD pid=${child.pid} executable=${executable} evidence=${run}`);
  let finished = false, killDeadline;
  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout); clearTimeout(killDeadline);
    report.code = code;
    report.cleanup = 'retained; close not confirmed';
    if (report.closed) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        report.cleanup = 'removed after close';
      } catch (error) { report.cleanup = `retained: ${error.code}: ${error.message}`; report.cleanupError = true; }
    }
    report.verdict = code === 0 && report.closed && !report.timedOut && !report.spawnError && !report.cleanupError ? 'PASS' : 'FAIL';
    process.exitCode = report.verdict === 'PASS' ? 0 : 1;
    try { fs.writeFileSync(path.join(run, 'parent.json'), JSON.stringify(report, null, 2)); }
    catch (error) { console.error('FAIL evidence write:', error.message); process.exitCode = 1; }
    console.log(`RESULT ${report.verdict} code=${code} close=${report.closed} timeout=${report.timedOut} cleanup=${report.cleanup}`);
    if (!report.closed) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  }
  child.stdout.on('data', data => { report.stdout += data; process.stdout.write(data); });
  child.stderr.on('data', data => { report.stderr += data; process.stderr.write(data); });
  child.on('error', error => { report.spawnError = error.message; console.error('FAIL spawn:', error.message); });
  child.on('close', code => { report.closed = true; finish(code); });
  const timeout = setTimeout(() => {
    report.timedOut = true;
    console.error(`FAIL timeout: own child pid=${child.pid}; terminating only its tree`);
    if (child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', error => { report.killError = error.message; child.kill('SIGKILL'); });
      killer.on('close', code => { report.killCode = code; if (code !== 0 && !report.closed) child.kill('SIGKILL'); });
      killer.unref();
    }
    killDeadline = setTimeout(() => finish(1), 5000);
  }, 30000);
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const run = process.env.CQ_CROP_RUN;
  // Reject direct Electron launch before ready: never fall back to real userData.
  if (!run || !fs.existsSync(path.join(run, 'profile'))) process.exit(1);
  app.setPath('userData', path.join(run, 'profile'));
  app.setPath('sessionData', path.join(run, 'profile'));
  app.on('window-all-closed', () => {});
  const sourcePath = path.join(__dirname, '../src/designer/designer.js');
  const htmlPath = path.join(__dirname, '../src/designer/designer.html');
  const fingerprint = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const before = { js: fingerprint(sourcePath), html: fingerprint(htmlPath) };
  const results = [], writes = [], rendererErrors = [];
  let win;
  async function test(name, fn) {
    try { const evidence = await fn(); results.push({ name, status: 'PASS', evidence }); console.log(`PASS ${name} ${JSON.stringify(evidence ?? '')}`); }
    catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
  }
  const js = code => win.webContents.executeJavaScript(code);
  async function main() {
    const layer = require('../src/shared/layers.js').newModelLayer();
    ipcMain.handle('crop:getState', () => ({ layers: [layer], profiles: { currentProfileId: 'crop-test' } }));
    ipcMain.on('crop:set', (_event, patch) => writes.push(patch));
    const preload = path.join(run, 'preload.cjs');
    fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cq', {
  getState: () => ipcRenderer.invoke('crop:getState'),
  onState: () => () => {},
  set: patch => ipcRenderer.send('crop:set', patch)
});\n`);
    await app.whenReady();
    console.log(`ENV ${JSON.stringify({ platform: process.platform, versions: process.versions, sourcePath, htmlPath, sha256: before, userData: app.getPath('userData') })}`);
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(details));
    await win.loadFile(htmlPath);
    await poll(() => js(`document.getElementById('layerCount').textContent === '1' && window.__cqDesignerBooted`), 'real designer boot');
    await test('destination-in textual guard (not pixel proof)', () => {
      assert.match(source, /globalCompositeOperation\s*=\s*['"]destination-in['"]/);
      return { file: sourcePath, line: source.slice(0, source.indexOf("globalCompositeOperation = 'destination-in'")).split('\n').length };
    });
    await test('Chromium destination-in vs source-over pixel control', async () => {
      const pixels = await js(`(() => {
        const c = document.createElement('canvas'); c.width = c.height = 700;
        const x = c.getContext('2d'); x.fillStyle = '#1a7ae6'; x.fillRect(0, 0, 700, 700);
        x.fillRect(250, 250, 200, 200);
        const sourceOverOutside = x.getImageData(200, 350, 1, 1).data[3];
        x.globalCompositeOperation = 'destination-in'; x.fillRect(250, 250, 200, 200);
        return { sourceOverOutside, center: x.getImageData(350, 350, 1, 1).data[3], outside: x.getImageData(200, 350, 1, 1).data[3] };
      })()`);
      assert.deepEqual(pixels, { sourceOverOutside: 255, center: 255, outside: 0 }, 'outside-alpha assertion must distinguish missing mask from destination-in');
      return pixels;
    });
    await test('real cutCommit without image is no-op', async () => {
      const count = writes.length;
      await js(`document.querySelector('[data-act="cut"]').click(); document.getElementById('cutCommit').click();`);
      // IPC barrier: earlier sends have reached main before invoke resolves.
      await js('window.cq.getState()');
      assert.equal(writes.length, count);
    });
    for (const [label, value] of [['rectangle', 'square'], ['circle', 'circle']]) {
      await test(`real cutCommit ${label} size=200 PNG pixels`, async () => {
        await js(`(async () => {
          document.querySelector('[data-act="cut"]').click();
          const c = document.createElement('canvas'); c.width = c.height = 600;
          const x = c.getContext('2d'); x.fillStyle = '#1a7ae6'; x.fillRect(0, 0, 600, 600);
          const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
          const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'solid.png', { type: 'image/png' }));
          const input = document.getElementById('cutFile'); input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await poll(() => js(`(() => {
          const x = document.getElementById('cutCanvas').getContext('2d');
          return x.getImageData(350, 350, 1, 1).data[3] === 255 && x.getImageData(200, 350, 1, 1).data[3] === 255;
        })()`), `${label} image.onload drew solid source`);
        const count = writes.length;
        await js(`(() => {
          const size = document.getElementById('cutSize'); size.value = '200'; size.dispatchEvent(new Event('input', { bubbles: true }));
          const shape = document.getElementById('cutShape'); shape.value = ${JSON.stringify(value)};
          if (shape.value !== ${JSON.stringify(value)}) throw new Error('missing real shape option');
          document.getElementById('cutCommit').click();
        })()`);
        const patch = await poll(() => writes[count], `${label} cq.set capture`);
        assert.equal(writes.length, count + 1, 'one persistence write per crop');
        const image = patch.layers.at(-1);
        assert.equal(image.type, 'image');
        assert.match(image.src, /^data:image\/png;base64,/);
        const bytes = Buffer.from(image.src.split(',')[1], 'base64');
        fs.writeFileSync(path.join(run, `${label}.png`), bytes);
        const pixels = await js(`(async () => {
          const image = new Image(); image.src = ${JSON.stringify(image.src)}; await image.decode();
          const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
          const x = c.getContext('2d'); x.drawImage(image, 0, 0);
          const rgba = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
          return { width: c.width, height: c.height, center: rgba(350, 350), outside: rgba(200, 350), corner: rgba(270, 270), margin: rgba(10, 10) };
        })()`);
        fs.writeFileSync(path.join(run, `${label}-pixels.json`), JSON.stringify(pixels, null, 2));
        console.log(`PIXELS ${label} ${JSON.stringify(pixels)}`);
        assert.equal(pixels.width, 700); assert.equal(pixels.height, 700);
        // Interior samples avoid antialiased boundaries: exact alpha, tolerance 0.
        assert.deepEqual(pixels.center, [26, 122, 230, 255], 'crop must preserve source center');
        assert.equal(pixels.outside[3], 0, 'outside crop but inside original image must be transparent');
        assert.equal(pixels.corner[3], label === 'circle' ? 0 : 255, 'circle corner vs rectangle interior');
        assert.equal(pixels.margin[3], 0, 'original transparent margin remains transparent');
        return pixels;
      });
    }
    assert.deepEqual({ js: fingerprint(sourcePath), html: fingerprint(htmlPath) }, before, 'production changed during run; rerun for stable evidence');
    assert.deepEqual(rendererErrors, [], 'renderer process must survive');
  }
  main().catch(error => { results.push({ name: 'runner', status: 'FAIL', error: error.stack }); console.error('FAIL runner:', error.stack); }).finally(() => {
    let code = results.some(result => result.status === 'FAIL') ? 1 : 0;
    try { fs.writeFileSync(path.join(run, 'cases.json'), JSON.stringify(results, null, 2)); }
    catch (error) { code = 1; console.error('FAIL cases write:', error.message); }
    console.log(`SUMMARY cases=${results.length} PASS=${results.filter(r => r.status === 'PASS').length} FAIL=${results.filter(r => r.status === 'FAIL').length} SKIP=0`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(code); // Parent owns cleanup, only after child's close event.
  });
}
