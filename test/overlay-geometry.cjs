// Isolated Electron geometry/raster check. Never boots main or opens user data.
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const G = require('../src/shared/geometry.js');
const { center, tolerance, raster, captureRelation } = require('./overlay-geometry-qa.cjs');
if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA required for isolated geometry test');
const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const temp = process.env.CQ_GEOMETRY_USER_DATA || fs.mkdtempSync(path.join(tempRoot, 'cq-overlay-geometry-'));
const relative = path.relative(tempRoot, temp);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Geometry profile must be below LOCALAPPDATA Temp/opencode');
app.setPath('userData', temp);
// Electron still owns LevelDB files during will-quit. Keep this isolated temp;
// cleanup, when needed, belongs to a parent after the Electron process exits.
const report = { electron: process.versions.electron, pid: process.pid, temp, cleanup: 'retained; never remove active userData', cases: [] };
const physicalTolerance = tolerance.numericalEpsilon;
report.tolerance = { ...tolerance, acceptancePerAxis: physicalTolerance, snapBudgetAlternativePerAxis: tolerance.snappingPerAxis + tolerance.numericalEpsilon };
let win;

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  report.display = { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor };
  const source = fs.readFileSync(path.join(__dirname, '../src/overlay/overlay.js'), 'utf8');
  report.source = Object.fromEntries(['../src/overlay/overlay.js', '../src/overlay/overlay.html', '../src/shared/geometry.js', 'overlay-geometry.cjs', 'overlay-geometry-runner.cjs', 'overlay-geometry-qa.cjs'].map(file => {
    const absolute = path.resolve(__dirname, file), bytes = fs.readFileSync(absolute);
    return [absolute, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
  }));
  report.startedAt = new Date().toISOString();
  win = new BrowserWindow({ width: 800, height: 600, frame: false, transparent: true, show: false,
    webPreferences: { partition: 'cq-overlay-geometry', sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '../src/overlay/overlay.html'));
  console.log(`READY pid=${process.pid} profile=${temp}`);
  if (process.argv.includes('--inject-timeout')) await new Promise(() => {});
  if (process.argv.includes('--inject-failure')) throw new Error('CQ_GEOMETRY_TEST_ONLY_FAILURE');
  if (process.argv.includes('--teardown-only')) {
    report.geometry = 'not executed; lifecycle-only probe';
    console.log('PASS: isolated window load; teardown follows');
    return;
  }
  await win.webContents.executeJavaScript(`window.cq = { onState(fn) { window.geometryRender = fn; }, onInput() {} }; ${source}`);
  const model = G.defaultModel();
  const state = { visible: true, scale: 1, offsetX: 0, offsetY: 0, model, model2: model, layers: [] };
  for (const ratio of [1, .5, .501]) for (const zoom of new Set([1, 1 / display.scaleFactor, .8, 1.25])) {
    const b = display.bounds;
    const width = Math.floor(b.width * ratio), height = Math.floor(b.height * ratio);
    win.setBounds({ x: Math.floor(b.x + (b.width - width) / 2), y: Math.floor(b.y + (b.height - height) / 2), width, height });
    win.webContents.setZoomFactor(zoom);
    for (const scale of [1, .5, 2]) for (const inline of [true, false]) {
       const metrics = await win.webContents.executeJavaScript(`(async () => {
         for (let frame = 0; frame < 5; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
        document.querySelectorAll('.svg-target > svg').forEach(svg => svg.style.display = ${inline ? "'inline'" : "''"});
        window.geometryRender(${JSON.stringify({ ...state, scale })});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const target = document.getElementById('primary'), svg = target.firstElementChild;
        const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
        const matrix = svg.getScreenCTM();
        return { innerWidth, innerHeight, viewport:rect(document.documentElement), dpr:devicePixelRatio, target:rect(target), svg:rect(svg), origin:{x:matrix.e,y:matrix.f} };
      })()`);
       const image = await win.webContents.capturePage(), pixels = raster(image), png = image.toPNG();
       pixels.representation.png = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
       assert.equal(pixels.representation.png.width, pixels.width, 'PNG IHDR width must match bitmap');
       assert.equal(pixels.representation.png.height, pixels.height, 'PNG IHDR height must match bitmap');
       const captureFile = path.join(path.dirname(process.env.CQ_GEOMETRY_REPORT || path.join(temp, 'geometry.json')), `after-anchor-${report.cases.length}.png`);
       fs.writeFileSync(captureFile, png);
       const record = { ratio, zoom, scale, inline, bounds: win.getBounds(), contentBounds: win.getContentBounds(), metrics, pixels, captureFile };
      const dx = pixels.cx - pixels.width / 2, dy = pixels.cy - pixels.height / 2;
      record.captureRelation = captureRelation(pixels, record.contentBounds, report.display);
       record.directCenter = { ...center(dx, dy), snapBudgetAlternativePass: center(dx, dy).pass,
         pass: Number.isFinite(dx) && Number.isFinite(dy) && Math.abs(dx) <= physicalTolerance && Math.abs(dy) <= physicalTolerance,
         units: 'capture bitmap pixels',
         cssPerAxisTolerance: record.captureRelation.physicalDimensionsSupported ? physicalTolerance / metrics.dpr : null };
       record.originCenter = Object.fromEntries([['x', 'width'], ['y', 'height']].map(([axis, size]) => [axis, (metrics.origin[axis] - metrics.viewport[size] / 2) * metrics.dpr]));
       record.originCenter.distance = Math.hypot(record.originCenter.x, record.originCenter.y);
       record.originCenter.pass = ['x', 'y'].every(axis => Number.isFinite(record.originCenter[axis]) && Math.abs(record.originCenter[axis]) <= physicalTolerance);
       record.failures = [];
      report.cases.push(record);
       if (!inline) {
        try {
         assert.ok(record.captureRelation.physicalDimensionsSupported, 'capture dimensions must support display physical-pixel relation');
         assert.ok(record.directCenter.pass, `raster center: dx=${dx}, dy=${dy}, radial diagnostic=${record.directCenter.distance}; .02 physical px/axis, no snapping`);
        assert.equal(metrics.target.height, metrics.svg.height, 'SVG must not leave inline baseline space');
        for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
          const physical = metrics.origin[axis] * metrics.dpr;
           const expected = metrics.viewport[size] * metrics.dpr / 2;
           assert.ok(Math.abs(physical - expected) <= physicalTolerance, `${axis}: origin equals fractional mathematical viewport center (.02 physical px/axis)`);
         }
         assert.ok(Math.abs(pixels.cx - metrics.origin.x * metrics.dpr) <= physicalTolerance, 'raster X centroid agrees with SVG origin within .02 physical px');
         assert.ok(Math.abs(pixels.cy - metrics.origin.y * metrics.dpr) <= physicalTolerance, 'raster Y centroid agrees with SVG origin within .02 physical px');
        } catch (error) { record.failures.push(error.message); }
       }
    }
  }
   report.sourceUnchanged = Object.entries(report.source).every(([file, metadata]) => createHash('sha256').update(fs.readFileSync(file)).digest('hex') === metadata.sha256);
   const block = report.cases.filter(c => !c.inline), failed = block.filter(c => c.failures.length);
   report.summary = { measured: report.cases.length, block: block.length, inlineDiagnostic: report.cases.length - block.length, pass: block.length - failed.length, fail: failed.length };
   assert.ok(report.sourceUnchanged, 'source must remain unchanged throughout matrix');
   assert.equal(failed.length, 0, `${failed.length}/${block.length} production block cases fail; per-case evidence retained`);
   console.log(`PASS: ${report.cases.length} isolated overlay geometry/raster measurements; ${block.length} production assertions, inline diagnostic only`);
}).catch(error => { report.error = error.stack; report.errorRepresentation = error.representation; console.error(error); process.exitCode = 1; }).finally(() => {
  const suffix = process.argv.includes('--hidpi-report') ? '-hidpi' : '';
  try {
    fs.writeFileSync(process.env.CQ_GEOMETRY_REPORT || path.join(temp, `geometry${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    console.error('Geometry report write failed:', error);
    process.exitCode = 1;
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (error) { console.error('Geometry window teardown failed:', error); process.exitCode = 1; }
    console.log(`TEARDOWN pid=${process.pid} code=${process.exitCode || 0}`);
    app.exit(process.exitCode || 0);
  }
});
