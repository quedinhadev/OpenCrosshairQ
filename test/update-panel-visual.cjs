// Visual QA runner for update panel – Electron isolated, no production touch.
// Run with: npm exec -- electron test/update-panel-visual.cjs
// Or: .\node_modules\electron\dist\electron.exe test/update-panel-visual.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });

const userData = fs.mkdtempSync(path.join(tempRoot, 'cq-update-visual-'));
const sessionData = fs.mkdtempSync(path.join(tempRoot, 'cq-update-session-'));

app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.setLoginItemSettings = () => { throw new Error('QA forbids Windows login writes'); };

const outputDir = path.resolve(__dirname, '../../analysis/release-0.2.0/visual');
fs.mkdirSync(outputDir, { recursive: true });

const appRoot = path.resolve(__dirname, '..');
const uiHtml = path.join(appRoot, 'src/ui/index.html');
const preloadPath = path.join(__dirname, 'update-panel-visual-preload.js');

let win;

async function waitReady(webContents, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = await webContents.executeJavaScript('!!document.getElementById("btnCheckUpdates")');
    if (exists) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('UI did not expose btnCheckUpdates in time');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function capture(webContents, fileName) {
  const img = await webContents.capturePage();
  const buffer = img.toPNG();
  const outPath = path.join(outputDir, fileName);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

async function measure(webContents) {
  return await webContents.executeJavaScript(`
    (() => {
      const getRect = id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const fs = parseFloat(style.fontSize) || 0;
        const overflow = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        return {
          id,
          visible: !!(el.offsetParent !== null && r.width > 0 && r.height > 0),
          x: r.x, y: r.y, w: r.width, h: r.height,
          fontSize: fs,
          overflow,
          text: (el.textContent || '').trim().slice(0, 200),
          hidden: el.hidden,
          display: getComputedStyle(el).display
        };
      };
      const focusInfo = () => {
        const a = document.activeElement;
        const style = a ? getComputedStyle(a) : null;
        const r = a ? a.getBoundingClientRect() : null;
        return {
          id: a?.id || null,
          tag: a?.tagName || null,
          outline: style?.outlineWidth || null,
          focusRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
        };
      };
      const lang = localStorage.getItem('cq.language') || document.documentElement.lang || 'pt-BR';
      return {
        lang,
        btnCheck: getRect('btnCheckUpdates'),
        btnInstall: getRect('btnInstallUpdate'),
        status: getRect('updateStatus'),
        focus: focusInfo()
      };
    })()
  `);
}

(async () => {
  app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        width: 1100,
        height: 760,
        show: false,
        frame: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false
        }
      });

      win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        if (level >= 3) console.error(`CONSOLE[${level}] ${message} (${sourceId}:${line})`);
      });

      win.loadFile(uiHtml);

      await new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', reject);
      });
      console.log('STEP did-finish-load');

      // Stub window.confirm for test only
      try {
        await win.webContents.executeJavaScript(`
          window.__origConfirm = window.confirm;
          window.confirm = (msg) => { window.__lastConfirm = msg; return true; };
          void 0;
        `);
        console.log('STEP confirm-stub');
      } catch (e) {
        console.error('STEP confirm-stub FAIL', e);
        throw e;
      }

      try {
        await waitReady(win.webContents);
        console.log('STEP waitReady');
      } catch (e) {
        console.error('STEP waitReady FAIL', e);
        throw e;
      }

      // Navigate to settings page
      await win.webContents.executeJavaScript(`(() => { window.location.hash = '#startup'; })(); void 0;`);
      await sleep(300);

      // Ensure language is pt-BR initially
      await win.webContents.executeJavaScript(`(() => {
        localStorage.setItem('cq.language', 'pt-BR');
        const sel = document.getElementById('optionLanguage');
        if (sel) sel.value = 'pt-BR';
      })(); void 0;`);
      await sleep(200);

      const sizes = [
        { w: 1100, h: 760, name: '1100x760' },
        { w: 900, h: 650, name: '900x650' }
      ];

      const states = [
        { phase: 'idle', desc: 'idle' },
        { phase: 'checking', desc: 'checking' },
        { phase: 'downloading', desc: 'downloading', version: '1.0.0', progress: 45 },
        { phase: 'downloaded', desc: 'downloaded', version: '1.0.0' },
        { phase: 'error', desc: 'error', error: 'Falha de rede' },
        { phase: 'unsupported', desc: 'unsupported' },
        { phase: 'not-available', desc: 'notavailable' }
      ];

      const languages = [
        { code: 'pt-BR', name: 'pt' },
        { code: 'en-US', name: 'en' }
      ];

      const results = [];

      for (const size of sizes) {
        win.setSize(size.w, size.h);
        await sleep(250);
        // Focus initialization category
        await win.webContents.executeJavaScript(`(() => {
          const b = [...document.querySelectorAll('#optCats [data-optcat]')].find(e=>e.dataset.optcat==='inicializacao');
          if (b) b.click();
        })(); void 0;`);
        await sleep(200);

        for (const lang of languages) {
          await win.webContents.executeJavaScript(`(() => {
            localStorage.setItem('cq.language', '${lang.code}');
            const sel = document.getElementById('optionLanguage');
            if (sel) { sel.value = '${lang.code}'; sel.dispatchEvent(new Event('change', {bubbles:true})); }
          })(); void 0;`);
          await sleep(250);

          for (const st of states) {
            const base = {
              supported: st.phase === 'unsupported' ? false : true,
              currentVersion: '0.9.5',
              phase: st.phase,
              version: st.version || null,
              progress: st.progress || null,
              error: st.error || null,
              reason: null
            };
            await win.webContents.executeJavaScript(`window.cq.__testEmitUpdate(${JSON.stringify(base)}); void 0;`);
            await sleep(200);

            // Ensure panel visible
            await win.webContents.executeJavaScript(`(() => {
              const cat = document.querySelector('.settings-cat[data-cat="inicializacao"]');
              if (cat && !cat.classList.contains('on')) {
                const btn = [...document.querySelectorAll('#optCats [data-optcat]')].find(e=>e.dataset.optcat==='inicializacao');
                if (btn) btn.click();
              }
            })(); void 0;`);
            await sleep(150);

            // Keyboard focus test on btnCheckUpdates
            await win.webContents.executeJavaScript(`(() => {
              const btn = document.getElementById('btnCheckUpdates');
              if (btn) { btn.focus(); }
            })(); void 0;`);
            await sleep(100);

            let measurement;
            try {
              measurement = await measure(win.webContents);
            } catch (merr) {
              console.error('MEASURE FAIL', merr);
              throw merr;
            }
            const fileName = `update-${size.name}-${lang.name}-${st.desc}.png`;
            const screenshotPath = await capture(win.webContents, fileName);

            results.push({
              size: size.name,
              language: lang.code,
              state: st.desc,
              screenshot: screenshotPath,
              measurement
            });

            // Log summary
            console.log(`OK ${size.name} ${lang.name} ${st.desc} -> ${screenshotPath}`);
            if (measurement.btnCheck && !measurement.btnCheck.visible) {
              console.warn(`WARN btnCheckUpdates not visible in ${size.name} ${lang.name} ${st.desc}`);
            }
            if (measurement.status && measurement.status.overflow) {
              console.warn(`WARN updateStatus overflow in ${size.name} ${lang.name} ${st.desc}`);
            }
            if (measurement.btnInstall && measurement.btnInstall.visible) {
              // Ensure install button rect non-zero
              if (!measurement.btnInstall.w || !measurement.btnInstall.h) {
                console.warn(`WARN btnInstallUpdate zero size`);
              }
            }
          }
        }
      }

      // Write JSON report
      const reportPath = path.join(outputDir, 'update-panel-visual-report.json');
      fs.writeFileSync(reportPath, JSON.stringify({ generated: new Date().toISOString(), userData, sessionData, results }, null, 2));

      console.log('REPORT', reportPath);
      console.log('Screenshots saved to', outputDir);

      // Cleanup userData
      try {
        fs.rmSync(userData, { recursive: true, force: true });
        fs.rmSync(sessionData, { recursive: true, force: true });
      } catch {}

      app.exit(0);
    } catch (err) {
      console.error('FAIL', err && err.stack ? err.stack : err);
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(sessionData, { recursive: true, force: true }); } catch {}
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
})();
