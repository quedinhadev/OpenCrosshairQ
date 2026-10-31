// Testes de auditoria e regressão de back-end:
// BACK2: criação de perfil grava displayId imediatamente no JSON em disco e no store.
// BACK7: exclusão de perfil ativo usa applyProfile('default', false) sem salvar condenado;
//        se applyProfile default falhar, aborta sem excluir ativo e sem corromper seleção.
// BACK9 + RUN6: eliminação de broadcasts redundantes provados (cq:set, reposition, applyProfile/evaluateNative).
// BACK13: require node:fs inline movido para o topo do módulo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const localRequire = createRequire(new URL('../src/main/main.js', import.meta.url));
const { loadProfiles } = require('../src/main/profiles.js');

function createBootHelper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-backend-audit-'));
  const handlers = new Map();
  const events = new Map();
  const appEvents = new Map();
  const sends = [];
  const windows = [];
  let fgStatus = { available: false, foreground: null, error: null };
  let evalNativeFn = null;

  class Window {
    constructor() {
      this.webContents = {
        send: (channel, payload) => sends.push({ channel, payload, window: this }),
        setZoomFactor() {},
      };
      this.destroyed = false;
      this.listeners = new Map();
      windows.push(this);
    }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    loadFile() {}
    once() {}
    on(event, fn) { this.listeners.set(event, fn); }
    setBounds() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    show() {}
    hide() {}
    focus() {}
  }

  const display1 = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const display2 = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const displays = [display1, display2];

  const app = {
    isPackaged: true,
    whenReady: () => Promise.resolve(),
    getPath: () => dir,
    once: (n, f) => appEvents.set(n, f),
    on: (n, f) => appEvents.set(n, f),
    quit: () => {},
  };

  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: {
      on: (channel, fn) => events.set(channel, fn),
      handle: (channel, fn) => handlers.set(channel, fn),
    },
    globalShortcut: {
      register: () => true,
      unregister: () => {},
      unregisterAll: () => {},
    },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      on: () => {},
    },
    Tray: null,
    Menu: null,
  };

  const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');

  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './foreground') {
        return {
          createForegroundMonitor: (native, onEvaluate) => {
            evalNativeFn = onEvaluate;
            return {
              getStatus: () => fgStatus,
              start: () => {},
              stop: () => {},
            };
          },
        };
      }
      if (name === './input') {
        return {
          createInputMonitor: () => ({ getStatus: () => ({}), start: () => {}, stop: () => {} }),
        };
      }
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'),
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
  });

  return {
    dir,
    handlers,
    events,
    sends,
    windows,
    appEvents,
    source,
    get: () => handlers.get('cq:get-state')(),
    send: (channel, payload) => events.get(channel)({}, payload),
    triggerEvaluateNative: (status) => {
      fgStatus = status;
      evalNativeFn?.(status);
    },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// 1. BACK13: require node:fs inline no topo de main.js
// ---------------------------------------------------------------------------
{
  const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  assert.ok(
    /const fs = require\(['"]node:fs['"]\);/.test(source) || /const fs = require\(['"]fs['"]\);/.test(source),
    'fs deve ser importado no topo do main.js'
  );
  const bodyAfterImports = source.slice(source.indexOf('let overlay'));
  assert.ok(
    !bodyAfterImports.includes("require('node:fs')") && !bodyAfterImports.includes('require("node:fs")'),
    'não deve haver require("node:fs") inline espalhado no corpo de main.js'
  );
}

// ---------------------------------------------------------------------------
// 2. BACK2: cq:create-profile inclui displayId imediatamente em settings e disco
// ---------------------------------------------------------------------------
{
  const env = createBootHelper();
  try {
    await new Promise((r) => setImmediate(r));
    // Define um displayId específico
    env.send('cq:set', { displayId: 2 });
    assert.equal(env.get().displayId, 2, 'displayId definido como 2');

    // Cria novo perfil
    env.send('cq:create-profile', { name: 'Monitor Profile' });
    const newId = env.get().profiles.currentProfileId;
    assert.notEqual(newId, 'default');

    // REGRESSÃO IMEDIATA: lê o JSON do perfil direto do disco ANTES de qualquer timer/troca
    const profileDiskPath = path.join(env.dir, 'profiles', `${newId}.json`);
    assert.ok(fs.existsSync(profileDiskPath), 'arquivo de perfil criado em disco');
    const diskJson = JSON.parse(fs.readFileSync(profileDiskPath, 'utf8'));

    assert.equal(diskJson.settings.displayId, 2, 'disco JSON contém displayId imediatamente');
    assert.equal(
      env.get().profiles.profiles[newId].settings.displayId,
      2,
      'settings do perfil em memória contém displayId'
    );
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 3. BACK7: delete perfil ativo chama applyProfile default com savePrevious=false;
//    não salva perfil condenado e se applyProfile default falhar, aborta exclusão.
// ---------------------------------------------------------------------------
{
  const env = createBootHelper();
  try {
    await new Promise((r) => setImmediate(r));
    env.send('cq:create-profile', { name: 'Target Profile' });
    const targetId = env.get().profiles.currentProfileId;
    assert.notEqual(targetId, 'default');

    const targetFile = path.join(env.dir, 'profiles', `${targetId}.json`);
    assert.ok(fs.existsSync(targetFile), 'perfil ativo salvo em disco');

    // Alteração pendente: salvar o perfil condenado seria uma escrita observável.
    env.send('cq:set', { scale: 2.75 });
    assert.notEqual(JSON.parse(fs.readFileSync(targetFile, 'utf8')).settings.scale, 2.75);
    const rename = fs.renameSync;
    let targetWrites = 0;
    try {
      fs.renameSync = (from, to) => {
        if (path.resolve(to) === path.resolve(targetFile)) targetWrites++;
        return rename(from, to);
      };
      env.send('cq:delete-profile', { id: targetId });
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(targetWrites, 0, 'exclusão não salva perfil condenado, mesmo com alteração pendente');
    assert.equal(env.get().profiles.currentProfileId, 'default', 'seleção retornou para default');
    assert.ok(!fs.existsSync(targetFile), 'arquivo do perfil excluído foi removido');
    assert.ok(!Object.hasOwn(env.get().profiles.profiles, targetId), 'perfil removido do store');

    // Caso B: exclusão de perfil ativo quando ativação do 'default' falha
    // Cria outro perfil para ser o ativo
    env.send('cq:create-profile', { name: 'Survivor Profile' });
    const survivorId = env.get().profiles.currentProfileId;
    assert.notEqual(survivorId, 'default');
    const survivorFile = path.join(env.dir, 'profiles', `${survivorId}.json`);
    assert.ok(fs.existsSync(survivorFile));

    // Simula falha de disco durante applyProfile('default')
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('disk failure during applyProfile default'); };

      // Tenta deletar o perfil ativo sob falha do default
      env.send('cq:delete-profile', { id: survivorId });
    } finally {
      fs.renameSync = originalRename;
    }

    // Verificações: não deve ter excluído o perfil ativo nem corrompido seleção!
    assert.equal(env.get().profiles.currentProfileId, survivorId, 'seleção mantida no perfil ativo em caso de falha');
    assert.ok(fs.existsSync(survivorFile), 'arquivo do perfil ativo não foi apagado do disco');
    assert.ok(Object.hasOwn(env.get().profiles.profiles, survivorId), 'perfil ativo preservado no store');
    assert.ok(env.get().validationError, 'erro de validação registrado no snapshot');
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 4. BACK9 + RUN6: redundâncias de broadcast provadas
// ---------------------------------------------------------------------------
{
  const env = createBootHelper();
  try {
    await new Promise((r) => setImmediate(r));
    // Limpa envios do boot
    env.sends.length = 0;

    // 4.1 cq:set com alteração de estado simples (scale)
    // Deve disparar exatamente 1 broadcast imediato (2 envios, 1 por janela: ui + overlay)
    env.send('cq:set', { scale: 3.5 });
    const stateBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(stateBroadcasts.length, 2, 'cq:set com mudança de valor faz exatamente 1 broadcast imediato (2 envios)');
    assert.equal(stateBroadcasts[0].payload.scale, 3.5);
    assert.equal(stateBroadcasts[0].payload.validationError, null);

    // Timer debounce (200ms): após o timer disparar, persistCurrentProfile atualiza o registry
    // e gera o broadcast de persistência com o perfil atualizado
    await new Promise((r) => setTimeout(r, 250));
    const timerBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(timerBroadcasts.length, 4, 'após timer de 200ms, persistência dispara exatamente 1 broadcast adicional');
    const lastSnapshot = timerBroadcasts.at(-1).payload;
    assert.equal(lastSnapshot.profiles.profiles.default.settings.scale, 3.5, 'perfil persistido reflete scale');

    // 4.2 cq:set idempotente (mesmo valor scale: 3.5)
    // Deve disparar exatamente 1 broadcast para garantir validationError: null sem duplicação
    env.send('cq:set', { scale: -1 });
    assert.ok(env.get().validationError, 'controle negativo cria erro antes do patch idempotente');
    env.sends.length = 0;
    env.send('cq:set', { scale: 3.5 });
    const idempBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(idempBroadcasts.length, 2, 'cq:set idempotente faz exatamente 1 broadcast');
    assert.equal(idempBroadcasts[0].payload.scale, 3.5);
    assert.equal(idempBroadcasts[0].payload.validationError, null);

    // 4.3 cq:set com displayId (needsReposition)
    // Dispara broadcast da alteração de estado + broadcast do reposition
    env.sends.length = 0;
    env.send('cq:set', { displayId: 2 });
    const reposBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(reposBroadcasts.length, 4, 'cq:set com reposition faz 2 broadcasts (state + bounds reposition)');
    assert.equal(reposBroadcasts[0].payload.displayId, 2);
    assert.equal(reposBroadcasts[0].payload.validationError, null);

    // 4.4 applyProfile não duplica broadcast após reposition
    env.sends.length = 0;
    env.send('cq:set-profile', { id: 'default' });
    const applyBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(applyBroadcasts.length, 2, 'applyProfile faz apenas 1 broadcast (via reposition)');

    // 4.5 evaluateNative com troca de perfil (autoswitch) não duplica broadcast do applyProfile
    // Configura um perfil com processo associado via contrato oficial cq:configure-profile
    env.send('cq:create-profile', { name: 'GameProfile' });
    const gameProfId = env.get().profiles.currentProfileId;
    env.send('cq:set-profile', { id: 'default' }); // volta para default
    env.handlers.get('cq:configure-profile')({}, {
      id: gameProfId,
      processPath: 'C:\\Games\\test.exe',
      hideCrosshairWhenUnfocused: true,
    });

    env.sends.length = 0;
    // Simula detecção de jogo pelo native foreground
    env.triggerEvaluateNative({
      available: true,
      foreground: { executablePath: 'C:\\Games\\test.exe', windowTitle: 'Game' },
      error: null,
    });

    assert.equal(env.get().profiles.currentProfileId, gameProfId, 'trocou para GameProfile');
    const autoSwitchBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(autoSwitchBroadcasts.length, 2, 'autoswitch faz apenas 1 broadcast (via applyProfile/reposition)');

    // 4.6 evaluateNative sem troca de perfil (apenas atualização de foco)
    env.sends.length = 0;
    env.triggerEvaluateNative({
      available: true,
      foreground: { executablePath: 'C:\\Windows\\explorer.exe', windowTitle: 'Explorer' },
      error: null,
    });
    const focusBroadcasts = env.sends.filter((s) => s.channel === 'cq:state');
    assert.equal(focusBroadcasts.length, 2, 'foco sem autoswitch faz exatamente 1 broadcast');
    assert.equal(focusBroadcasts[0].payload.gameInFocus, false);

    // Autoswitch rejeitado ainda publica erro e foco do perfil atual.
    env.send('cq:set-profile', { id: 'default' });
    env.sends.length = 0;
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('autoswitch persistence rejected'); };
      env.triggerEvaluateNative({
        available: true,
        foreground: { executablePath: 'C:\\Games\\test.exe', windowTitle: 'Game' },
        error: null,
      });
    } finally {
      fs.renameSync = originalRename;
    }
    const rejectedBroadcasts = env.sends.filter(s => s.channel === 'cq:state');
    assert.equal(rejectedBroadcasts.length, 2, 'autoswitch rejeitado publica snapshot em ambas janelas');
    assert.equal(rejectedBroadcasts[0].payload.profiles.currentProfileId, 'default');
    assert.match(rejectedBroadcasts[0].payload.validationError, /autoswitch persistence rejected/);
    assert.equal(rejectedBroadcasts[0].payload.gameInFocus, true);
    assert.equal(rejectedBroadcasts[0].payload.profileInFocus, true);
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 5. BACK-5: before-quit para streamer gracioso
// ---------------------------------------------------------------------------
{
  const Streamer = localRequire('./streamer.js');
  const env = createBootHelper();
  try {
    await new Promise((r) => setImmediate(r));
    const startHandler = env.handlers.get('cq:streamer-start');
    assert.ok(startHandler, 'cq:streamer-start registrado');
    const started = await startHandler({}, { port: 29991 });
    assert.equal(started.running, true, 'streamer em execução antes do quit');
    assert.equal(Streamer.getStatus().running, true);

    const beforeQuit = env.appEvents.get('before-quit');
    assert.ok(beforeQuit, 'before-quit registrado');
    beforeQuit();

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Streamer.getStatus().running, false, 'streamer parado gracioso no before-quit');
  } finally {
    await Streamer.stop();
    env.cleanup();
  }
}

console.log('PASS: backend-audit (BACK2, BACK5, BACK7, BACK9+RUN6, BACK13)');
