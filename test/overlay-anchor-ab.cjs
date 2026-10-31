// Own-profile A/B. Node parent owns timeout; Electron never removes live userData.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function require1x(image) {
  const scaleFactors = typeof image.getScaleFactors === 'function' ? image.getScaleFactors() : null;
  assert.deepEqual(scaleFactors, [1], 'physical raster requires exactly one 1x NativeImage representation');
  return scaleFactors;
}
if (process.argv.includes('--test-raster-guard')) {
  let count = 0;
  const source = fs.readFileSync(__filename, 'utf8');
  const raster = require('node:vm').runInNewContext(source.slice(source.lastIndexOf('  function raster(image) {'), source.lastIndexOf('  app.whenReady()')) + ';raster', { assert, require1x });
  const png = Buffer.alloc(24); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  assert.equal(raster({ getScaleFactors: () => [1], getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.from([0, 0, 0, 255]), toPNG: () => png }).cx, .5); count++;
  for (const factors of [[2], [1, 2], [], null, undefined]) {
    let physicalPass = false, reads = 0;
    const image = { getSize() { reads++; throw new Error('must reject before physical bitmap read'); } };
    if (factors !== undefined) image.getScaleFactors = () => factors;
    assert.throws(() => { raster(image); physicalPass = true; }, /physical raster requires exactly one 1x/);
    assert.equal(physicalPass, false); assert.equal(reads, 0); count++;
  }
  console.log(`PASS: ${count} raster representation guard cases; incompatible images never reach physical PASS`);
} else {
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const stage = arg('stage', 'diagnostic'), dpi = Number(arg('dpr', '1'));
assert.ok(['diagnostic', 'confirmation', 'production'].includes(stage));
assert.ok([1, 1.25, 1.5].includes(dpi));
const output = path.resolve(__dirname, `../../analysis/improvements-20261024/anchor-ab-${stage}-${dpi}.json`);
if (!process.argv.includes('--worker')) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, '--worker', `--stage=${stage}`, `--dpr=${dpi}`], { stdio: 'inherit', env });
  const timeout = setTimeout(() => { console.error('A/B timeout: terminating owned Electron only', child.pid); child.kill(); }, 120000);
  child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.on('close', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, screen } = require('electron');
  const G = require('../src/shared/geometry.js');
  assert.ok(process.env.LOCALAPPDATA);
  const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, 'cq-overlay-anchor-ab-'));
  app.setPath('userData', temp);
  app.on('window-all-closed', () => {}); // variants replace windows; parent owns exit timeout
  app.commandLine.appendSwitch('force-device-scale-factor', String(dpi));
  const sourcePath = path.join(__dirname, '../src/overlay/overlay.js');
  const currentSource = fs.readFileSync(sourcePath, 'utf8');
  const currentHTML = fs.readFileSync(path.join(__dirname, '../src/overlay/overlay.html'), 'utf8');
  // Preserve reproducible old-production controls after the accepted source fix.
  const baseline = stage !== 'production' && !currentSource.includes('function snapTargetsPixelCenter(')
    ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../analysis/improvements-20261024/anchor-ab-diagnostic-1.json'), 'utf8')) : null;
  const source = baseline?.overlaySource ?? currentSource;
  const html = baseline?.overlayHTML ?? currentHTML;
  const report = { stage, dpi, electron: process.versions.electron, chromium: process.versions.chrome, pid: process.pid, temp,
    cleanup: 'retained; parent may remove only after close', source: sourcePath,
    overlaySource: source, overlayHTML: html, control: baseline ? 'frozen pre-patch source/CSS in diagnostic-1.json' : 'current source/CSS',
    sourceSHA256: require('node:crypto').createHash('sha256').update(source).digest('hex'),
    tolerance: { exactPerAxis: .02, snapPerAxis: .52, radial: 'record only, not gated' }, cases: [] };
  let win;
  const anchor = `function snapTargetsPixelCenter(effectiveScale) {
    const viewport = document.documentElement.getBoundingClientRect();
    for (const t of targets) {
      t.style.transform = \`translate(\${viewport.width / 2 - 128 + state.offsetX + (state.crosshairOffset?.x ?? 0)}px, \${viewport.height / 2 - 128 - state.offsetY - (state.crosshairOffset?.y ?? 0)}px) scale(\${effectiveScale})\`;
    }
  }`;
  function variantSource(variant) {
    if (variant === 'production' || variant === 'no-will') return source;
    const start = source.indexOf('function snapTargetsPixelCenter('), end = source.indexOf('\n  let snapFrame', start);
    assert.ok(start > 0 && end > start, 'source replacement contract');
    if (variant.startsWith('no-snap')) return source.slice(0, start) + `function snapTargetsPixelCenter(effectiveScale) { for (const t of targets) t.style.transform = \`translate(-50%, -50%) scale(\${effectiveScale})\`; }\n` + source.slice(end);
    return (source.slice(0, start) + anchor + '\n' + source.slice(end))
      .replace('t.style.left = `calc(50% + ${offX}px)`;', "t.style.left = '0px';")
      .replace('t.style.top = `calc(50% - ${offY}px)`;', "t.style.top = '0px';");
  }
  function raster(image) {
    const scaleFactors = require1x(image);
    const { width, height } = image.getSize(), bytes = image.toBitmap(), png = image.toPNG();
    assert.equal(bytes.length, width * height * 4, 'bitmap is exactly width*height*4; no second DPR multiplication');
    assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
    let weight = 0, sx = 0, sy = 0, left = width, right = -1, top = height, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = bytes[(y * width + x) * 4 + 3];
      if (!a) continue;
      weight += a; sx += (x + .5) * a; sy += (y + .5) * a;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    assert.ok(weight > 0, 'visible alpha required');
    return { width, height, bytes: bytes.length, scaleFactors,
      png: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, cx: sx / weight, cy: sy / weight, left, right, top, bottom, weight };
  }
  app.whenReady().then(async () => {
    const display = screen.getPrimaryDisplay();
    report.display = { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor };
    const variants = stage === 'diagnostic' ? ['production', 'no-will', 'no-snap', 'no-snap-no-will', 'anchor', 'anchor-no-will'] : stage === 'production' ? ['production'] : ['production', 'anchor', 'anchor-no-will'];
    const configs = stage === 'diagnostic'
      ? [[960,540,1,1,'cross'],[961,541,1,1,'cross'],[961,540,1,1,'cross'],[960,541,1,1,'dot'],[961,541,.8,1,'dot'],[961,541,1.25,1,'cross']]
      : [[960,540,1,1,'cross'],[961,541,1,1,'dot'],[961,540,1,.5,'dot'],[960,541,1,2,'cross'],
         [961,541,.8,.5,'cross'],[960,540,.8,2,'dot'],[961,540,1.25,2,'dot'],[960,541,1.25,.5,'cross'],
         [961,541,.8,1,'dot'],[961,541,1.25,1,'cross'],[960,540,1,1,'dot',3,-2], [961,541,1,2,'cross',-2,3]];
    if (stage === 'production') configs.push([963,543,1,2,'cross',-2,3,true], [963,543,.8,2,'cross',-2,3,true]);
    for (const variant of variants) {
      win = new BrowserWindow({ width: 800, height: 600, frame: false, transparent: true, show: false,
        webPreferences: { partition: 'cq-anchor-ab', sandbox: true, contextIsolation: true } });
      await win.loadFile(path.join(__dirname, '../src/overlay/overlay.html'));
      await win.webContents.executeJavaScript(`${baseline ? "document.querySelectorAll('.svg-target').forEach(t => { t.style.left='50%'; t.style.top='50%'; t.style.transform='translate(-50%, -50%) scale(1)'; t.style.willChange='transform'; });" : ''}
        window.cq = { onState(fn) { window.anchorRender = fn; }, onInput() {} }; ${variantSource(variant)}
        ${variant.endsWith('no-will') || variant === 'no-will' ? "document.querySelectorAll('.svg-target').forEach(t => t.style.willChange = 'auto');" : ''}`);
      for (const [width,height,zoom,scale,shape,offsetX=0,offsetY=0,noBroadcast=false] of configs) {
        win.setBounds({ x: 0, y: 0, width, height });
        win.webContents.setZoomFactor(zoom);
        // Resize/zoom IPC can arrive after an immediate render. Settle first,
        // otherwise this measures a stale viewport rather than a layout variant.
        await win.webContents.executeJavaScript(`new Promise(resolve => { let n=0; const next=()=>++n===5?resolve():requestAnimationFrame(next); requestAnimationFrame(next); })`);
        const model = G.defaultModel();
        if (shape === 'dot') { model.armLen = 0; model.armThick = 0; model.dot.size = 8; }
        const state = { visible: true, scale, offsetX, offsetY, model, model2: model, layers: [] };
        const metrics = await win.webContents.executeJavaScript(`(async () => {
          ${noBroadcast ? '' : `window.anchorRender(${JSON.stringify(state)});`}
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const t = document.getElementById('primary'), svg = t.firstElementChild;
          const rect = n => { const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
          const m = svg.getScreenCTM();
          return { viewport:rect(document.documentElement), target:rect(t), svg:rect(svg), innerWidth, innerHeight, dpr:devicePixelRatio,
            origin:{x:m.e,y:m.f}, ctm:{a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f}, style:{left:t.style.left,top:t.style.top,transform:t.style.transform,willChange:getComputedStyle(t).willChange} };
        })()`);
        const pixels = raster(await win.webContents.capturePage());
        const expected = { x: pixels.width / 2 + offsetX * metrics.dpr, y: pixels.height / 2 - offsetY * metrics.dpr };
        const geom = { x: metrics.origin.x * metrics.dpr - expected.x, y: metrics.origin.y * metrics.dpr - expected.y };
        const delta = { x: pixels.cx - expected.x, y: pixels.cy - expected.y };
        const record = { variant, requested:{width,height,zoom,scale,shape,offsetX,offsetY,noBroadcast}, bounds:win.getBounds(),contentBounds:win.getContentBounds(),metrics,pixels,expected,
          geom, raster:delta, rasterMinusCTM:{x:pixels.cx-metrics.origin.x*metrics.dpr,y:pixels.cy-metrics.origin.y*metrics.dpr}, radial:Math.hypot(delta.x,delta.y),
          exact:Math.max(Math.abs(geom.x),Math.abs(geom.y),Math.abs(delta.x),Math.abs(delta.y)) < .02,
          snapBudget:Math.max(Math.abs(delta.x),Math.abs(delta.y)) <= .52 };
        report.cases.push(record);
      }
      win.destroy(); win = null;
    }
    report.summary = Object.fromEntries(variants.map(v => { const cases=report.cases.filter(c=>c.variant===v); return [v,{cases:cases.length,exact:cases.filter(c=>c.exact).length,snapBudget:cases.filter(c=>c.snapBudget).length,
      maxGeom:Math.max(...cases.flatMap(c=>[Math.abs(c.geom.x),Math.abs(c.geom.y)])), maxRaster:Math.max(...cases.flatMap(c=>[Math.abs(c.raster.x),Math.abs(c.raster.y)])),maxRadial:Math.max(...cases.map(c=>c.radial))}]; }));
    console.log(JSON.stringify(report.summary,null,2));
    if (stage !== 'diagnostic') assert.ok(report.cases.filter(c=>c.variant === (stage === 'production' ? 'production' : 'anchor-no-will')).every(c=>c.exact), 'candidate exact geometry AND raster, <.02 physical px per axis');
  }).catch(error => { report.error = error.stack; console.error(error); process.exitCode = 1; }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n'); console.log('REPORT',output,'PROFILE RETAINED',temp); }
    catch(error) { console.error(error); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  });
}
}
