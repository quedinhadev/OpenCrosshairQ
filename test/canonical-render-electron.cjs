// node app/test/canonical-render-electron.cjs — parent owns isolated profile cleanup.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../analysis/ux-rework-20261026');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  (async () => {
    const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
    fs.mkdirSync(tempRoot, { recursive: true }); fs.mkdirSync(output, { recursive: true });
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const profile = fs.mkdtempSync(path.join(tempRoot, 'cq-canonical-'));
      await new Promise((resolve, reject) => {
        const env = { ...process.env, CQ_CANONICAL_PROFILE: profile, CQ_CANONICAL_DPR: String(dpr) };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [__filename, `--force-device-scale-factor=${dpr}`], { env, stdio: 'inherit', windowsHide: true });
        const deadline = setTimeout(() => { child.kill(); }, 60000);
        child.once('error', reject);
        child.once('close', code => {
          clearTimeout(deadline);
          // Only after exit/close. Cleanup error never hides test result.
          try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
          catch (error) { console.error('isolated cleanup retained:', profile, error.message); }
          if (code === 0) resolve(); else reject(new Error(`Electron DPR=${dpr} code=${code}`));
        });
      });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, screen } = require('electron');
  const L = require('../src/shared/layers.js');
  const G = require('../src/shared/geometry.js');
  const { createHash } = require('node:crypto');
  const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  const relative = path.relative(tempRoot, process.env.CQ_CANONICAL_PROFILE || '');
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  app.setPath('userData', process.env.CQ_CANONICAL_PROFILE);
  const report = { electron: process.versions.electron, requestedDpr: process.env.CQ_CANONICAL_DPR,
    tolerancePhysicalPerAxis: .02, pixelEqualityTolerance: 0, cases: [] };
  let win;
  app.whenReady().then(async () => {
    const display = screen.getPrimaryDisplay();
    report.display = { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor };
    win = new BrowserWindow({ width: 600, height: 400, frame: false, show: false, transparent: true,
      webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadFile(path.resolve(__dirname, '../src/overlay/overlay.html'));
    const source = fs.readFileSync(path.resolve(__dirname, '../src/overlay/overlay.js'), 'utf8');
    await win.webContents.executeJavaScript(`window.cq={onState(fn){window.renderCanonical=fn},onInput(){}};${source}`);
    for (const width of [600, 601]) for (const zoom of [1, .8, 1.25]) for (const scale of [1, 1.5]) {
      win.setSize(width, 400); win.webContents.setZoomFactor(zoom);
      const model = { ...G.defaultModel(), color: '#67c1f5' };
      const state = { visible: true, model, model2: model, layers: [], drawing: null, scale, offsetX: 0, offsetY: 0 };
      const capture = async payload => {
        const metrics = await win.webContents.executeJavaScript(`(async()=>{
          window.renderCanonical(${JSON.stringify(payload)});
          for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
          const svg=document.querySelector('#primary svg'), target=svg.parentElement;
          const m=svg.getScreenCTM(), r=document.documentElement.getBoundingClientRect();
          return {dpr:devicePixelRatio,viewport:{width:r.width,height:r.height},origin:{x:m.e,y:m.f},
            svgHeight:svg.getBoundingClientRect().height,targetHeight:target.getBoundingClientRect().height};
        })()`);
        const image = await win.webContents.capturePage(); const png = image.toPNG();
        return { metrics, png, hash: createHash('sha256').update(png).digest('hex'),
          width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      };
      const simple = await capture(state);
      const layered = await capture({ ...state, layers: [L.modelToLayer(model)], drawing: '<rect fill="red"/>' });
      assert.equal(simple.hash, layered.hash, 'same canonical geometry gives byte-identical capture');
      const m = simple.metrics;
      assert.equal(m.targetHeight, m.svgHeight, 'no inline SVG baseline gap');
      for (const [axis, dimension] of [['x', 'width'], ['y', 'height']]) {
        assert.ok(Math.abs((m.origin[axis] - m.viewport[dimension] / 2) * m.dpr) <= .02, 'exact viewport center within .02 physical px/axis');
      }
      report.cases.push({ width, zoom, scale, metrics: m, png: { width: simple.width, height: simple.height },
        bounds: win.getBounds(), contentBounds: win.getContentBounds(), byteIdentical: simple.hash === layered.hash });
    }
    console.log(`PASS canonical Electron DPR=${report.requestedDpr}: ${report.cases.length} cases`);
  }).catch(error => { report.error = error.stack; console.error(error); process.exitCode = 1; }).finally(() => {
    try { fs.writeFileSync(path.join(output, `canonical-electron-${report.requestedDpr}.json`), JSON.stringify(report, null, 2)); }
    finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(process.exitCode || 0); }
  });
}
