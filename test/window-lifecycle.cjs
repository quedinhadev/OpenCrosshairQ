// Teste de regressão real Electron BACK1: Ciclo de vida de janelas, UI hide/restore e Tray.
// Runner Node pai coordena cenários em instâncias Electron filhas com userData isolado.
// NÃO altera arquivos de usuário, registro do Windows ou perfil real.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const isElectron = Boolean(process.versions.electron);

if (!isElectron) {
  // =========================================================================
  // RUNNER NODE PAI
  // =========================================================================

  const appDir = path.resolve(__dirname, '..');
  let electronExe = null;
  try {
    const candidate = require('electron');
    if (typeof candidate === 'string') electronExe = candidate;
  } catch {}
  if (!electronExe) {
    electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  }

  const tempRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
    : path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(tempRoot, { recursive: true });

  function killTree(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}
  }

  function removeUserData(targetDir) {
    const deadline = Date.now() + 3000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return;
      } catch (err) {
        lastError = err;
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          const waitTill = Date.now() + 100;
          while (Date.now() < waitTill) {}
          continue;
        }
        break;
      }
    }
    throw new Error(`Falha ao remover userData ${targetDir}: ${lastError ? lastError.message : 'desconhecida'}`);
  }

  function runScenario(scenario) {
    return new Promise((resolve, reject) => {
      const userData = fs.mkdtempSync(path.join(tempRoot, `cq-lifecycle-${scenario}-`));
      const expectedPassMarker = `[${scenario}] PASS:`;

      const childEnv = { ...process.env, NODE_ENV: 'test' };
      delete childEnv.ELECTRON_RUN_AS_NODE;

      // windowsHide deve ser false: no Windows, windowsHide: true seta STARTF_USESHOWWINDOW
      // com SW_HIDE no STARTUPINFO do processo filho. A API Win32 ShowWindow ignora o primeiro
      // nCmdShow (inclusive SW_SHOW) e força SW_HIDE, impedindo que a janela principal fique visível.
      const child = spawn(electronExe, [__filename, `--scenario=${scenario}`, `--user-data=${userData}`], {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: childEnv,
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let timedOut = false;
      let closeHandled = false;
      let confirmKillTimer = null;

      child.stdout.on('data', (d) => {
        const s = String(d);
        stdoutChunks.push(s);
        process.stdout.write(`[${scenario}] ${s}`);
      });

      child.stderr.on('data', (d) => {
        const s = String(d);
        stderrChunks.push(s);
        process.stderr.write(`[${scenario}:err] ${s}`);
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        console.error(`FAIL: Scenario ${scenario} timed out; killing child tree (PID ${child.pid})`);
        killTree(child.pid);

        confirmKillTimer = setTimeout(() => {
          if (!closeHandled) {
            closeHandled = true;
            reject(new Error(`Processo filho PID ${child.pid} não encerrou após timeout e kill (userData retido: ${userData})`));
          }
        }, 5000);
      }, 25000);

      child.on('close', (code, signal) => {
        if (closeHandled) return;
        closeHandled = true;
        clearTimeout(timeoutTimer);
        if (confirmKillTimer) clearTimeout(confirmKillTimer);

        let cleanupErr = null;
        try {
          removeUserData(userData);
        } catch (err) {
          cleanupErr = err;
        }

        if (timedOut) {
          return reject(new Error(`Scenario ${scenario} timed out`));
        }

        if (code !== 0) {
          return reject(new Error(`Scenario ${scenario} exited with code ${code} (signal ${signal})`));
        }

        const fullStdout = stdoutChunks.join('');
        if (!fullStdout.includes(expectedPassMarker)) {
          return reject(new Error(`Scenario ${scenario} exited 0 without pass marker "${expectedPassMarker}" (early quit/false positive)`));
        }

        if (cleanupErr) {
          return reject(cleanupErr);
        }

        resolve({ scenario, stdout: fullStdout, stderr: stderrChunks.join('') });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (confirmKillTimer) clearTimeout(confirmKillTimer);
        reject(err);
      });
    });
  }

  (async () => {
    try {
      console.log('=== Iniciando regressão Electron window-lifecycle ===');
      console.log('Cenário 1/2: Bandeja ausente (tray-unavailable)...');
      await runScenario('tray-unavailable');
      console.log('PASS: Cenário bandeja ausente concluído com sucesso.');

      console.log('Cenário 2/2: Bandeja disponível (tray-available)...');
      await runScenario('tray-available');
      console.log('PASS: Cenário bandeja disponível concluído com sucesso.');

      console.log('PASS: Todos os cenários de window-lifecycle executados com sucesso.');
      process.exit(0);
    } catch (error) {
      console.error('FAIL: window-lifecycle falhou:', error.message);
      process.exit(1);
    }
  })();

} else {
  // =========================================================================
  // PROCESSO FILHO ELECTRON
  // =========================================================================

  const { app } = require('electron');
  const Module = require('node:module');
  const { EventEmitter, once } = require('node:events');

  const tempRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
    : path.join(os.tmpdir(), 'opencode');

  const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
  const scenario = scenarioArg ? scenarioArg.split('=')[1] : 'tray-available';

  const userDataArg = process.argv.find((a) => a.startsWith('--user-data='));
  const userData = userDataArg ? userDataArg.split('=')[1] : null;

  if (!userData || typeof userData !== 'string' || userData.trim() === '') {
    console.error('FATAL: --user-data obrigatorio e nao pode ser vazio (protecao perfil real)');
    app.exit(1);
    return;
  }

  const expectedPrefix = path.resolve(tempRoot);
  const resolvedUserData = path.resolve(userData);
  if (!resolvedUserData.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
    console.error(`FATAL: --user-data deve residir sob ${expectedPrefix}, recebido: ${resolvedUserData}`);
    app.exit(1);
    return;
  }

  app.setPath('userData', resolvedUserData);

  // Monkey-patch de segurança: impedir escrita de registro/login item settings
  let loginSettingsAttempts = 0;
  app.setLoginItemSettings = () => {
    loginSettingsAttempts++;
    throw new Error('Test violation: setLoginItemSettings chamado durante teste de ciclo de vida');
  };

  // Fake Tray / Menu state
  let fakeTrayInstance = null;
  let fakeMenuTemplate = null;

  // Instrumentação cirúrgica de Module._load:
  // - Desabilita addon nativo crosshairq.node para evitar monitoramento real de foco/mouse.
  // - Controla Tray e Menu apenas quando require('electron') for chamado pelo main.js.
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === 'string' && (request.endsWith('crosshairq.node') || request.includes('crosshairq.node'))) {
      throw new Error('Addon nativo crosshairq.node desativado para teste de ciclo de vida');
    }

    const isMainJs = parent && typeof parent.filename === 'string' &&
      (/[/\\]src[/\\]main[/\\]main\.js$/.test(parent.filename) || parent.filename.endsWith('main.js'));

    if (request === 'electron' && isMainJs) {
      const realElectron = originalLoad.apply(this, arguments);

      if (scenario === 'tray-unavailable') {
        return new Proxy(realElectron, {
          get(target, prop, receiver) {
            if (prop === 'Tray' || prop === 'Menu') {
              return undefined;
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }

      if (scenario === 'tray-available') {
        class FakeTray extends EventEmitter {
          constructor(iconPath) {
            super();
            this.iconPath = iconPath;
            this.tooltip = null;
            this.menu = null;
            this._destroyed = false;
            fakeTrayInstance = this;
          }
          setToolTip(tip) {
            if (this._destroyed) throw new Error('Tray já destruído');
            this.tooltip = tip;
          }
          setContextMenu(menu) {
            if (this._destroyed) throw new Error('Tray já destruído');
            this.menu = menu;
          }
          isDestroyed() {
            return this._destroyed;
          }
          destroy() {
            this._destroyed = true;
          }
        }

        const FakeMenu = {
          buildFromTemplate(template) {
            fakeMenuTemplate = template;
            return {
              template,
              items: template,
            };
          },
        };

        return new Proxy(realElectron, {
          get(target, prop, receiver) {
            if (prop === 'Tray') return FakeTray;
            if (prop === 'Menu') return FakeMenu;
            return Reflect.get(target, prop, receiver);
          },
        });
      }
    }

    return originalLoad.apply(this, arguments);
  };

  const createdWindows = [];
  app.on('browser-window-created', (_event, win) => {
    createdWindows.push(win);
    console.log(`[debug] win#${win.id} created, initial isVisible=${win.isVisible()}, isMinimized=${win.isMinimized()}`);
    win.once('ready-to-show', () => {
      console.log(`[debug] win#${win.id} event: ready-to-show, isVisible=${win.isVisible()}`);
    });
    win.on('show', () => {
      console.log(`[debug] win#${win.id} event: show, isVisible=${win.isVisible()}, isMinimized=${win.isMinimized()}, bounds=${JSON.stringify(win.getBounds())}`);
    });
    win.on('hide', () => console.log(`[debug] win#${win.id} event: hide, isVisible=${win.isVisible()}`));
    win.on('minimize', () => console.log(`[debug] win#${win.id} event: minimize, isMinimized=${win.isMinimized()}`));
    win.on('restore', () => console.log(`[debug] win#${win.id} event: restore, isVisible=${win.isVisible()}`));
    win.webContents.on('did-finish-load', () => {
      console.log(`[debug] win#${win.id} url=${win.webContents.getURL()} did-finish-load`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[debug] win#${win.id} did-fail-load: code=${code} desc=${desc} url=${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[debug] win#${win.id} render-process-gone: ${JSON.stringify(details)}`);
    });
    win.webContents.on('console-message', (_e, level, msg) => {
      console.log(`[debug] win#${win.id} console[${level}]: ${msg}`);
    });
  });

  const childTimeout = setTimeout(() => {
    console.error(`FAIL: Electron child timeout no cenário ${scenario}`);
    app.exit(1);
  }, 20000);

  // Requer o main real do Electron
  require('../src/main/main.js');

  async function waitForWindows() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (createdWindows.length >= 2) {
        const ui = createdWindows.find((w) => {
          try { return new URL(w.webContents.getURL()).pathname.endsWith('/ui/index.html'); }
          catch { return false; }
        });
        const overlay = createdWindows.find((w) => {
          try { return new URL(w.webContents.getURL()).pathname.endsWith('/overlay/overlay.html'); }
          catch { return false; }
        });
        if (ui && overlay) {
          if (ui.webContents.isLoading()) await once(ui.webContents, 'did-finish-load');
          if (overlay.webContents.isLoading()) await once(overlay.webContents, 'did-finish-load');
          return { ui, overlay };
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timeout aguardando inicialização das janelas UI e Overlay');
  }

  async function waitVisible(win, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      if (!win.isDestroyed() && win.isVisible()) return true;
      if (++count % 20 === 0) {
        console.log(`[debug] waitVisible poll: destroyed=${win.isDestroyed()} visible=${win.isVisible()} minimized=${win.isMinimized()} bounds=${JSON.stringify(win.getBounds())}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    console.log(`[debug] waitVisible timeout: destroyed=${win.isDestroyed()} visible=${win.isVisible()} minimized=${win.isMinimized()}`);
    return !win.isDestroyed() && win.isVisible();
  }

  async function waitHidden(win, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!win.isDestroyed() && !win.isVisible()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !win.isDestroyed() && !win.isVisible();
  }

  app.whenReady().then(async () => {
    try {
      const { ui, overlay } = await waitForWindows();

      assert.ok(ui && !ui.isDestroyed(), 'UI window criada');
      assert.ok(overlay && !overlay.isDestroyed(), 'Overlay window criada');

      if (scenario === 'tray-unavailable') {
        await waitVisible(ui);
        assert.equal(ui.isVisible(), true, 'UI inicialmente visível sem bandeja');

        let beforeQuitFired = 0;
        app.on('before-quit', () => {
          beforeQuitFired++;
        });

        app.on('will-quit', () => {
          clearTimeout(childTimeout);
          try {
            assert.equal(beforeQuitFired, 1, 'before-quit deve disparar exatamente uma vez sem recursão');
            assert.equal(loginSettingsAttempts, 0, 'nenhuma escrita em registro de login');
            console.log('[tray-unavailable] PASS: close da UI sem bandeja encerra processo com before-quit sem recursão');
          } catch (err) {
            console.error('FAIL: [tray-unavailable] asserções no will-quit falharam:', err);
            app.exit(1);
          }
        });

        // Fechar UI deve disparar app.quit() imediatamente por falta de bandeja
        ui.close();
        return;
      }

      if (scenario === 'tray-available') {
        assert.ok(fakeTrayInstance, 'fakeTray instanciado');
        assert.equal(fakeTrayInstance.isDestroyed(), false, 'fakeTray não destruído');
        assert.ok(fakeMenuTemplate, 'menu de contexto gerado');

        await waitVisible(ui);
        assert.equal(ui.isVisible(), true, 'UI inicialmente visível');
        assert.equal(overlay.isDestroyed(), false, 'Overlay vivo');

        // 1. Fechamento nativo da UI: deve cancelar e esconder UI, mantendo overlay vivo
        ui.close();
        await waitHidden(ui);
        assert.equal(ui.isVisible(), false, 'UI escondida após close nativo');
        assert.equal(ui.isDestroyed(), false, 'UI não destruída após close nativo');
        assert.equal(overlay.isDestroyed(), false, 'Overlay continua vivo após UI ser escondida');

        // 2. Restauração via Menu da bandeja (item "Abrir OpenCrosshairQ")
        const openItem = fakeMenuTemplate.find((item) => item && typeof item.label === 'string' && item.label.includes('Abrir'));
        assert.ok(openItem, 'Item de menu "Abrir" encontrado');
        assert.equal(typeof openItem.click, 'function', 'Callback click do item "Abrir" disponível');
        openItem.click();
        await waitVisible(ui);
        assert.equal(ui.isVisible(), true, 'UI restaurada e visível via item Abrir do menu');
        assert.equal(ui.isDestroyed(), false, 'UI não destruída após restauração');

        // 3. Fechamento via IPC (windowControl 'close') emitido pelo renderer
        await ui.webContents.executeJavaScript("window.cq.windowControl('close')");
        await waitHidden(ui);
        assert.equal(ui.isVisible(), false, 'UI escondida após comando IPC windowControl close');
        assert.equal(ui.isDestroyed(), false, 'UI não destruída após IPC close');
        assert.equal(overlay.isDestroyed(), false, 'Overlay continua vivo após IPC close');

        // 4. Restauração via clique direto na bandeja
        fakeTrayInstance.emit('click');
        await waitVisible(ui);
        assert.equal(ui.isVisible(), true, 'UI restaurada e visível via clique na bandeja');
        assert.equal(ui.isDestroyed(), false, 'UI não destruída após clique na bandeja');

        // 5. Encerramento limpo via app.quit()
        let beforeQuitFired = false;
        app.on('before-quit', () => {
          beforeQuitFired = true;
        });

        app.on('will-quit', () => {
          clearTimeout(childTimeout);
          try {
            assert.equal(beforeQuitFired, true, 'before-quit disparado durante encerramento');
            assert.equal(fakeTrayInstance.isDestroyed(), true, 'tray destruído no before-quit');
            assert.equal(loginSettingsAttempts, 0, 'nenhuma escrita em registro de login');
            console.log('[tray-available] PASS: ciclo completo de UI hide, tray restore, IPC close e app.quit');
          } catch (err) {
            console.error('FAIL: [tray-available] asserções no will-quit falharam:', err);
            app.exit(1);
          }
        });

        app.quit();
      }
    } catch (error) {
      clearTimeout(childTimeout);
      console.error(`FAIL: Erro no cenário ${scenario}:`, error);
      app.exit(1);
    }
  });
}
