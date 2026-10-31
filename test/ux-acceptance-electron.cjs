// QA owns ux-acceptance*. Run: node test/ux-acceptance-electron.cjs [--legacy]
// Real main/preload/UI in DPR modes; legacy runners retain their documented stubs.
// Login writes are blocked; application and Chromium storage use temporary profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
const output = process.env.CQ_REFINEMENT_OUTPUT || path.resolve(__dirname, '../../analysis/ux-rework-20261026/logs');
if (process.env.CQ_REFINEMENT_OUTPUT) {
  assert.ok(process.versions.electron, 'refinement entry point is the guarded parent, not this runner');
  const { contained } = require('./refinement-acceptance-electron.cjs');
  contained(path.resolve(__dirname, '../../analysis/refinement-20261027/qa-evidence'), output);
  contained(root, process.env.CQ_UX_PROFILE);
  contained(root, process.env.CQ_REFINEMENT_SESSION);
  assert.notEqual(process.env.CQ_UX_PROFILE, process.env.CQ_REFINEMENT_SESSION);
}
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  const { spawn, execFileSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const appRoot = path.resolve(__dirname, '..');
  function snapshot() {
    const files = ['package.json', 'package-lock.json', 'assets/icon.png', 'assets/icon.ico', 'build/icon.ico', 'native/build/crosshairq.node'];
    for (const dir of ['src', 'test']) {
      for (const item of fs.readdirSync(path.join(appRoot, dir), { recursive: true, withFileTypes: true })) {
        if (item.isFile()) files.push(path.relative(appRoot, path.join(item.parentPath, item.name)).replaceAll('\\', '/'));
      }
    }
    return Object.fromEntries(files.sort().map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(appRoot, file))).digest('hex')]));
  }
  (async () => {
    const modes = process.argv.includes('--legacy')
      ? ['electron-smoke.cjs', 'foreground-electron.cjs', 'native-smoke.cjs', 'designer-interaction-smoke.cjs']
      : ['1', '1.25', '1.5', '2'];
    let failed = 0;
    for (const mode of modes) {
      const profile = fs.mkdtempSync(path.join(root, 'cq-ux-acceptance-'));
      const env = { ...process.env, CQ_UX_PROFILE: profile, CQ_UX_MODE: mode, CQ_SMOKE_USER_DATA: profile };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [__filename, `--user-data-dir=${profile}`];
      if (!mode.endsWith('.cjs')) args.push(`--force-device-scale-factor=${mode}`);
      const sourcesBefore = snapshot();
      const result = await new Promise(resolve => {
        const child = spawn(require('electron'), args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
        let stdout = '', stderr = '', timedOut = false;
        console.log(`CHILD mode=${mode} pid=${child.pid} profile=${profile}`);
        const timer = setTimeout(() => {
          timedOut = true; console.error(`FAIL timeout mode=${mode} pid=${child.pid}`);
          try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
          catch (error) { stderr += `\nkill: ${error.message}`; }
        }, 90000);
        child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
        child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
        child.on('error', error => { stderr += error.stack; });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const profiles = [profile, ...stdout.split('\n').filter(s => s.startsWith('UX_PROFILE=')).map(s => s.slice(11).trim())];
          const cleanup = [];
          for (const dir of new Set(profiles)) {
            const rel = path.relative(root, dir);
            assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'cleanup confined to Temp/opencode');
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); cleanup.push({ dir, removed: true }); }
            catch (error) { cleanup.push({ dir, retained: error.message }); }
          }
          const passMarker = mode.endsWith('.cjs') ? stdout.includes('PASS:') : stdout.includes('UX_SUMMARY=');
          resolve({ mode, executable: require('electron'), pid: child.pid, code, signal, timedOut, stdout, stderr, cleanup,
            verdict: code === 0 && !timedOut && passMarker && cleanup.every(c => c.removed) ? 'PASS' : 'FAIL' });
        });
      });
      result.sourcesBefore = sourcesBefore;
      result.sourcesAfter = snapshot();
      result.sourcesStable = JSON.stringify(result.sourcesBefore) === JSON.stringify(result.sourcesAfter);
      if (!result.sourcesStable) result.verdict = 'FAIL';
      fs.writeFileSync(path.join(output, `ux-acceptance-electron-${mode}.json`), JSON.stringify(result, null, 2));
      console.log(`RESULT ${result.verdict} ${mode}`);
      if (result.verdict !== 'PASS') failed++;
    }
    process.exitCode = failed ? 1 : 0;
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, globalShortcut } = require('electron');
  const rel = path.relative(root, process.env.CQ_UX_PROFILE || '');
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  app.setPath('userData', process.env.CQ_UX_PROFILE);
  app.setPath('sessionData', process.env.CQ_REFINEMENT_SESSION || process.env.CQ_UX_PROFILE);
  let loginWrites = 0;
  app.setLoginItemSettings = () => { loginWrites++; throw new Error('QA forbids Windows login writes'); };
  const exit = app.exit.bind(app);
  app.exit = code => exit(loginWrites ? 1 : code);
  app.on('will-quit', () => { if (loginWrites) process.exitCode = 1; });
  if (process.env.CQ_UX_MODE.endsWith('.cjs')) {
    // Legacy runners may allocate their own profile. Parent learns exact path and
    // removes it only after this process closes. Startup remains dev-gated.
    process.nextTick(() => console.log('UX_PROFILE=' + app.getPath('userData')));
    require('./' + process.env.CQ_UX_MODE);
  } else {
    const results = [];
    const L = require('../src/shared/layers');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function wait(fn, label) {
      const deadline = Date.now() + 5000;
      do { const value = await fn(); if (value) return value; await sleep(25); } while (Date.now() < deadline);
      throw new Error('timeout: ' + label);
    }
    async function check(name, fn) {
      try { await fn(); results.push({ name, verdict: 'PASS' }); console.log('PASS: ' + name); }
      catch (error) { const verdict = error.code === 'UX_SKIP' ? 'SKIP' : 'FAIL'; results.push({ name, verdict, error: error.stack }); console.error(verdict + ': ' + name + '\n' + error.stack); }
    }
    // Disable global shortcut at boot. Enable only one verified free candidate in
    // toggle test. No synthetic OS input, foreground changes or login writes.
    fs.mkdirSync(path.join(app.getPath('userData'), 'profiles'));
    fs.writeFileSync(path.join(app.getPath('userData'), 'profiles/default.json'), JSON.stringify({
      id: 'default', name: 'Default', createdAt: 0, process: null,
      settings: { keybinds: { ...require('../src/main/state').DEFAULTS.keybinds, globalShortcut: { ...require('../src/main/state').DEFAULTS.keybinds.globalShortcut, enabled: false } } },
    }));
    require('../src/main/main');
    app.whenReady().then(async () => {
      const ui = await wait(() => BrowserWindow.getAllWindows().find(w => /\/ui\/index.html$/.test(w.webContents.getURL())), 'UI window');
      const overlay = await wait(() => BrowserWindow.getAllWindows().find(w => /\/overlay\/overlay.html$/.test(w.webContents.getURL())), 'overlay');
      const run = script => ui.webContents.executeJavaScript(script);
      const get = () => run('window.cq.getState()');
      const set = patch => run(`(async()=>{window.cq.set(${JSON.stringify(patch)});return window.cq.getState()})()`);
      const click = id => run(`document.getElementById(${JSON.stringify(id)}).click();void 0`);
      await wait(() => run('!!window.cq && !!document.querySelector("#keybindList .kb-toggle")'), 'UI bindings');
      console.log('UX_ENV=' + JSON.stringify({ versions: process.versions, executable: process.execPath, packaged: app.isPackaged, dpr: await run('devicePixelRatio'), profile: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
      assert.equal(app.getPath('sessionData'), process.env.CQ_REFINEMENT_SESSION || process.env.CQ_UX_PROFILE);
      if (process.env.CQ_REFINEMENT_OUTPUT) {
        const summary = await require('./refinement-acceptance-cases.cjs').runCases({ app, ui, overlay, run, get, set, wait, output, loginWrites: () => loginWrites });
        console.log('REFINEMENT_SUMMARY=' + JSON.stringify(summary));
        app.exit(summary.fail ? 1 : 0);
        return;
      }
      if (process.env.CQ_UX_MODE === '1') {
        await check('global toggle changes real registration, persists false and survives reload', async () => {
          const state = await get();
          let combo;
          for (const key of ['F23', 'F22', 'F21']) {
            const candidate = 'Control+Alt+Shift+' + key;
            if (globalShortcut.register(candidate, () => {})) { globalShortcut.unregister(candidate); combo = key; break; }
          }
          if (!combo) throw Object.assign(new Error('occupied Windows shortcuts'), { code: 'UX_SKIP' });
          await set({ keybinds: { ...state.keybinds, globalShortcut: { ...state.keybinds.globalShortcut, enabled: false, pc: { modifiers: ['Ctrl', 'Alt', 'Shift'], key: combo, platform: 'PC' } } } });
          await run('document.querySelectorAll("#keybindList .kb-toggle button")[1].click()');
          await wait(async () => (await get()).keybinds.globalShortcut.enabled && globalShortcut.isRegistered('Control+Alt+Shift+' + combo), 'enabled and registered');
          await wait(() => run('document.querySelectorAll("#keybindList .kb-toggle button")[1].getAttribute("aria-pressed") === "true"'), 'toggle reflects on');
          await run('document.querySelectorAll("#keybindList .kb-toggle button")[0].click()');
          await wait(async () => !(await get()).keybinds.globalShortcut.enabled, 'disabled');
          assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+' + combo), false);
          await wait(() => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'profiles/default.json'))).settings.keybinds?.globalShortcut?.enabled === false, 'persist false');
          await ui.reload();
          await wait(() => run('document.querySelector("#keybindList .kb-toggle button")?.getAttribute("aria-pressed") === "true"'), 'reload persisted DOM');
        });
        await check('Mirar selector exposes hold/toggle and persists both choices', async () => {
          const select = await run(`(()=>{const e=document.querySelector('#keybindList .kb-sub');return {disabled:e.disabled,options:[...e.options].map(o=>o.value)}})()`);
          assert.equal(select.disabled, false, 'Mirar cannot be inert');
          assert.ok(select.options.includes('hold') && select.options.includes('toggle'), JSON.stringify(select));
          for (const value of ['toggle', 'hold']) {
            await run(`(()=>{const e=document.querySelector('#keybindList .kb-sub');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
            await wait(async () => (await get()).keybinds.aim.pressType === value, 'Mirar ' + value);
          }
        });
        await check('malformed saved collection cannot prevent boot or overwrite recovery data', async () => {
          const previous = await run('localStorage.getItem("cq.savedCustomCrosshairs")');
          try {
            await run('localStorage.setItem("cq.savedCustomCrosshairs", "{}")');
            await ui.reload();
            await wait(() => run('!!document.querySelector("#keybindList .kb-toggle")'), 'boot despite invalid collection');
            assert.ok((await get()).keybinds, 'authoritative state remains available');
            assert.equal(await run('localStorage.getItem("cq.savedCustomCrosshairs")'), '{}', 'invalid original stays recoverable');
          } finally {
            await run(previous === null ? 'localStorage.removeItem("cq.savedCustomCrosshairs")' : `localStorage.setItem("cq.savedCustomCrosshairs", ${JSON.stringify(previous)})`);
            await ui.reload();
            await wait(() => run('!!document.querySelector("#keybindList .kb-toggle")'), 'restore collection');
          }
        });
        await check('share/import roundtrip preserves Unicode, zero, false and empty', async () => {
          await set({ layers: [{ id: 'qa-text', type: 'text', text: '日本語 😀', x: 0, y: 0, opacity: 0, visible: false }], drawing: '' });
          await wait(() => run('document.getElementById("continuePreview").innerHTML === ""'), 'UI echo');
          const expected = L.validateCrosshair(await get());
          await click('btnShare');
          const code = await run('document.getElementById("shareCodeText").value');
          assert.ok(code.startsWith('CQ1:'));
          await click('shareModalClose');
          await set({ layers: [], drawing: '' });
          await click('btnImport');
          await run(`document.getElementById('importCodeText').value=${JSON.stringify(code)}`);
          await click('btnApplyImportCode');
          await wait(() => run('!document.getElementById("importModal").classList.contains("on")'), 'import complete');
          assert.deepEqual(L.validateCrosshair(await get()), expected);
          assert.ok(await run('JSON.parse(localStorage.getItem("cq.savedCustomCrosshairs")).some(x=>x.layers[0]?.id==="qa-text")'));
        });
        await check('share/import preserves an explicitly empty layered document', async () => {
          await set({ model: { color: '#123456' }, layers: [], drawing: '' });
          await wait(() => run('document.getElementById("continuePreview").innerHTML === ""'), 'explicit empty echo');
          await click('btnShare');
          const code = await run('document.getElementById("shareCodeText").value');
          assert.ok(code.startsWith('CQ1:'));
          await click('shareModalClose');
          await click('btnImport');
          await run(`document.getElementById('importCodeText').value=${JSON.stringify(code)}`);
          await click('btnApplyImportCode');
          await wait(() => run('!document.getElementById("importModal").classList.contains("on")'), 'empty import');
          assert.deepEqual((await get()).layers, []);
          assert.equal((await get()).drawing, '');
        });
        await check('malformed metadata is sanitized before persistence and survives reload', async () => {
          await click('btnImport');
          await run(`document.getElementById('importCodeText').value='{"model":{},"creator":{"toString":null}}'`);
          await click('btnApplyImportCode');
          await wait(() => run('!document.getElementById("importModal").classList.contains("on")'), 'sanitized import');
          const entries = await run('JSON.parse(localStorage.getItem("cq.savedCustomCrosshairs"))');
          assert.ok(entries.every(e => typeof e.name === 'string' && typeof e.creator === 'string'));
          await ui.reload();
          await wait(() => run('!!document.querySelector("#keybindList .kb-toggle")'), 'boot after sanitized import');
          assert.ok((await get()).keybinds);
        });
        for (const [name, raw] of [['malformed', 'CQ1:not-base64'], ['unknown document', '{"format":"CQ9","layers":[],"drawing":""}'], ['oversize raster', JSON.stringify({ layers: [{ id: 'huge', type: 'image', src: 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024), w: 1, h: 1 }] })]]) {
          await check('import rejects ' + name + ' without mutation', async () => {
            const before = L.validateCrosshair(await get());
            const saved = await run('localStorage.getItem("cq.savedCustomCrosshairs")');
            await click('btnImport');
            await run(`document.getElementById('importCodeText').value=${JSON.stringify(raw)}`);
            await click('btnApplyImportCode');
            await wait(() => run('!!document.getElementById("importStatus").textContent || !document.getElementById("importModal").classList.contains("on")'), 'import outcome');
            assert.ok(await run('document.getElementById("importModal").classList.contains("on")'), 'invalid input must keep modal open');
            assert.ok(await run('!!document.getElementById("importStatus").textContent'));
            assert.deepEqual(L.validateCrosshair(await get()), before);
            assert.equal(await run('localStorage.getItem("cq.savedCustomCrosshairs")'), saved);
          });
        }
        await check('PT-BR/en switch changes shell text and persists reload', async () => {
          const language = lang => run(`(()=>{const e=document.getElementById('optionLanguage');e.value=${JSON.stringify(lang)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
          await language('en-US');
          assert.equal(await run('document.querySelector("[data-route=crosshairs] span").textContent'), 'Crosshairs');
          assert.equal(await run('document.documentElement.lang'), 'en-US');
          assert.equal(await run('document.getElementById("shareModalTitle").textContent'), 'Share Crosshair');
          await ui.reload();
          await wait(() => run('document.getElementById("optionLanguage")?.value === "en-US"'), 'language reload');
          assert.equal(await run('document.querySelector("[data-route=crosshairs] span").textContent'), 'Crosshairs');
          await language('pt-BR');
          assert.equal(await run('document.querySelector("[data-route=crosshairs] span").textContent'), 'Miras');
          assert.equal(await run('document.documentElement.lang'), 'pt-BR');
        });
        await check('English also translates keybind labels and controls', async () => {
          await run(`(()=>{const e=document.getElementById('optionLanguage');e.value='en-US';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
          const labels = await run('document.getElementById("keybindList").textContent');
          assert.doesNotMatch(labels, /Mirar|Atirar|Recarregar|LIGADO|DESLIGADO/);
          await run(`(()=>{const e=document.getElementById('optionLanguage');e.value='pt-BR';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        });
        await check('removed sections absent; hidden stored keybind data preserved on reload', async () => {
          const before = (await get()).keybinds;
          await ui.reload();
          await wait(() => run('!!document.querySelector("#keybindList .kb-toggle")'), 'reload bindings');
          assert.deepEqual((await get()).keybinds, before);
          assert.deepEqual(await run(`[...document.querySelectorAll('h1,h2,h3,h4,.nav-section,.nav-label,.section-title')].map(e=>e.textContent.trim().toLocaleUpperCase('pt-BR')).filter(s=>['ENTRADA','INTEGRAÇÕES','COMUNIDADE','MIRA AVANÇADO'].includes(s))`), []);
        });
        await check('explicit empty document remains empty when Creator opens', async () => {
          await set({ layers: [], drawing: '' });
          await run('document.querySelector("[data-route=designer]").click()');
          await wait(() => run('!!document.getElementById("designerFrame")?.contentDocument?.getElementById("layers")'), 'Creator');
          await sleep(250);
          assert.deepEqual((await get()).layers, []);
          assert.equal((await get()).drawing, '');
          const count = await run('document.getElementById("designerFrame").contentDocument.getElementById("layers").children.length');
          assert.equal(count, 0);
        });
      }
      await check('preset preview and canonical SVG rasterize identically at equal viewBox', async () => {
        await run('document.querySelector("[data-route=crosshairs]").click()');
        await wait(() => run('!!document.querySelector(".mod-card-preview svg")'), 'preset SVG');
        await run(`document.querySelector(${JSON.stringify('.mod-card [aria-label="Aplicar mira"]')}).click()`);
        await sleep(250);
        const state = await get();
        const canonical = L.renderCrosshair(state);
        const pixels = await run(`(async()=>{
          const source=document.querySelector('.mod-card-preview svg').cloneNode(true);
          const box=source.viewBox.baseVal;const view=[box.x,box.y,box.width,box.height].join(' ');
          source.setAttribute('width','256');source.setAttribute('height','256');
          const reference='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="'+view+'">'+${JSON.stringify(canonical)}+'</svg>';
          const raster=async text=>{const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(text);await img.decode();const c=document.createElement('canvas');c.width=c.height=256*devicePixelRatio;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);return [...ctx.getImageData(0,0,c.width,c.height).data]};
          const a=await raster(new XMLSerializer().serializeToString(source)),b=await raster(reference);
          let different=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])different++;
          return {dpr:devicePixelRatio,different,total:a.length,preview:source.outerHTML,reference};
        })().catch(e=>({rasterError:String(e),stack:e.stack,source:document.querySelector('.mod-card-preview svg')?.outerHTML}))`);
        fs.writeFileSync(path.join(output, `ux-acceptance-pixels-${process.env.CQ_UX_MODE}.json`), JSON.stringify(pixels));
        assert.equal(pixels.rasterError, undefined, JSON.stringify(pixels));
        assert.equal(pixels.different, 0, 'zero differing RGBA channels; normalized viewport only, never geometry');
      });
      await check('simultaneous catalog previews never reference another SVG', async () => {
        const refs = await run(`(()=>{const svgs=[...document.querySelectorAll('.mod-card-preview svg')];const broken=[];for(const svg of svgs)for(const use of svg.querySelectorAll('use')){const href=use.getAttribute('href')||use.getAttribute('xlink:href');if(!href?.startsWith('#'))continue;const target=document.getElementById(href.slice(1));if(!target||target.ownerSVGElement!==svg)broken.push(href)}return {count:svgs.length,broken}})()`);
        assert.ok(refs.count >= 2, 'multiple presets must coexist in the DOM');
        assert.deepEqual(refs.broken, [], 'references must stay within their own preview SVG');
      });
      await check('real overlay renders canonical body and centers within .05 CSS px / .1 physical px', async () => {
        const state = await get();
        const body = L.renderCrosshair(state);
        const metrics = await overlay.webContents.executeJavaScript(`(()=>{const e=document.querySelector('#primary svg');const r=document.documentElement.getBoundingClientRect(),m=e.getScreenCTM();return {body:e.innerHTML,x:m.e,y:m.f,w:r.width,h:r.height,dpr:devicePixelRatio}})()`);
        fs.writeFileSync(path.join(output, `ux-acceptance-center-${process.env.CQ_UX_MODE}.json`), JSON.stringify({ metrics, bounds: overlay.getBounds(), zoom: overlay.webContents.getZoomFactor() }, null, 2));
        // Browser serializer normalization is done in a detached SVG, not regex.
        const normalized = await run(`(()=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.innerHTML=${JSON.stringify(body)};return s.innerHTML})()`);
        assert.equal(metrics.body, normalized);
        for (const [value, dimension] of [[metrics.x, metrics.w], [metrics.y, metrics.h]]) {
          assert.ok(Math.abs(value - dimension / 2) <= .05);
          assert.ok(Math.abs(value - dimension / 2) * metrics.dpr <= .1);
        }
      });
      if (process.env.CQ_UX_MODE === '1') {
        await check('final layouts fit client widths; profile and position captures', async () => {
          for (const [width, height] of [[1280, 820], [1040, 660]]) {
            ui.setContentSize(width, height);
            await wait(() => run(`innerWidth===${width}&&innerHeight===${height}`), 'client dimensions');
            for (const route of ['crosshairs', 'positions', 'keybinds', 'startup']) {
              await run(`document.querySelector('[data-route="${route}"]').click()`);
              await sleep(250);
              const layout = await run(`(()=>{const e=document.documentElement;return {width:e.clientWidth,scroll:e.scrollWidth}})()`);
              assert.ok(layout.scroll <= layout.width, `${route}: horizontal overflow ${JSON.stringify(layout)}`);
              if (route === 'keybinds') {
                const tops = await run(`[...document.querySelectorAll('#keybindList tr:first-child td:nth-child(2) kbd')].map(e=>e.getBoundingClientRect().top)`);
                assert.ok(tops.length >= 4 && Math.max(...tops) - Math.min(...tops) < 1, 'four-key shortcut stays on one line');
              }
              if (route === 'positions') {
                assert.ok(await run(`[...document.querySelectorAll('.shortcut-strip .seg button')].every(e=>getComputedStyle(e).textTransform==='uppercase')`));
                const toast = await run(`(()=>{const t=document.getElementById('toast').getBoundingClientRect(),p=document.getElementById('posName').getBoundingClientRect();return {top:t.top,bottom:t.bottom,inputTop:p.top}})()`);
                assert.ok(toast.top >= 50 && toast.bottom < toast.inputTop, 'toast clears titlebar and position input');
              }
              fs.writeFileSync(path.join(output, `final-${width}x${height}-${route}.png`), (await ui.webContents.capturePage()).toPNG());
            }
            await click('profileChip');
            await click('tabPerfis');
            await sleep(250);
            assert.equal(await run('document.activeElement.id'), 'profileModalClose', 'profile opens with keyboard focus');
            assert.equal(await run('document.querySelector(".profile-actions button:nth-child(2)").disabled'), true, 'default cannot be deleted');
            assert.equal(await run('document.querySelector(".profile-actions button:nth-child(3)").classList.contains("btn")'), true, 'rename uses shared button style');
            const dialog = await run(`(()=>{const r=document.querySelector('#profileModal .modal-card').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`);
            assert.ok(dialog.x >= 0 && dialog.y >= 0 && dialog.right <= dialog.w && dialog.bottom <= dialog.h, JSON.stringify(dialog));
            fs.writeFileSync(path.join(output, `final-${width}x${height}-profiles.png`), (await ui.webContents.capturePage()).toPNG());
            await click('profileModalClose');
          }
        });
      }
      await check('no Windows login writes attempted', async () => assert.equal(loginWrites, 0));
      const summary = { mode: process.env.CQ_UX_MODE, results, pass: results.filter(r => r.verdict === 'PASS').length, fail: results.filter(r => r.verdict === 'FAIL').length, skip: results.filter(r => r.verdict === 'SKIP').length };
      console.log('UX_SUMMARY=' + JSON.stringify(summary));
      app.exit(summary.fail ? 1 : 0);
    }).catch(error => { console.error(error); app.exit(1); });
  }
}
