// Integração main↔tray/startup em VM: minimizar REAL (listener capturado),
// restauração por clique/menu, quit pelo menu, before-quit com perfil
// modificado e trayStatus no snapshot. Sem Electron real, sem registro do
// Windows, sem janela visível.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { loadProfiles } = require('../src/main/profiles.js');
const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const localRequire = createRequire(new URL('../src/main/main.js', import.meta.url));
const monitor = () => ({ getStatus: () => ({ available: false, foreground: null, error: null }), start() {}, stop() {} });

// Bandeja falsa: handlers/listeners capturados; setContextMenu lança após
// destroy (prova que nada chama o nativo destruído).
function makeTrayApi() {
  let inst = null;
  class FakeTray {
    constructor(icon) { this.icon = icon; this.handlers = new Map(); this.menus = []; this.destroyed = false; inst = this; }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(menu) { if (this.destroyed) throw new Error('bandeja destruída'); this.menus.push(menu); }
    on(name, fn) { this.handlers.set(name, fn); }
    destroy() { this.destroyed = true; }
  }
  return { Tray: FakeTray, Menu: { buildFromTemplate: (template) => ({ template }) }, instance: () => inst };
}

async function boot(dir, trayApi, opts = {}) {
  const handlers = new Map();
  const events = new Map();
  const appEvents = new Map();
  const windows = [];
  const sent = [];
  let quitCalls = 0;
  class Window {
    constructor() {
      this.listeners = new Map();
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }), setZoomFactor() {} };
      this.hidden = false; this.minimized = false; this.shown = false; this.destroyed = false;
      this.focused = false;
      windows.push(this);
    }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() {} once() {} setBounds() {}
    focus() { this.focused = true; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isMaximized() { return false; }
    maximize() {} unmaximize() {}
    on(name, fn) { this.listeners.set(name, fn); }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.listeners.get('close')?.(event);
      if (event.prevented) return event;
      this.destroyed = true;
      if (windows.every((w) => w.isDestroyed())) appEvents.get('window-all-closed')?.();
      return event;
    }
    minimize() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.listeners.get('minimize')?.(event);
      this.minimized = !event.prevented;
      return event;
    }
    hide() { this.hidden = true; }
    show() { this.hidden = false; this.shown = true; }
    restore() { this.minimized = false; }
  }
  let displays = opts.displays ?? [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  const screenListeners = new Map();
  const app = {
    isPackaged: true,
    whenReady: () => Promise.resolve(),
    getPath: () => dir,
    once: (name, fn) => appEvents.set(name, fn),
    on: (name, fn) => appEvents.set(name, fn),
    quit: () => { quitCalls++; },
  };
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: { on: (c, f) => events.set(c, f), handle: (c, f) => handlers.set(c, f) },
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      on: (name, fn) => screenListeners.set(name, fn),
    },
    Tray: trayApi.Tray, Menu: trayApi.Menu,
  };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './foreground' || name === './input') return { createForegroundMonitor: monitor, createInputMonitor: monitor };
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'), console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ui = windows[0];
  const send = (channel, payload) => events.get(channel)({}, payload);
  const get = () => handlers.get('cq:get-state')();
  const emitScreen = (name, ...args) => screenListeners.get(name)?.(...args);
  return { handlers, events, appEvents, ui, windows, emitScreen, app, send, get, sent, quitCalls: () => quitCalls };
}

// --- cenário A: bandeja funcional — minimizar REAL esconde, clique/menu
// restauram, menu alterna e sai, before-quit persiste perfil com bandeja
// destruída (refresh pós-destroy não pode quebrar a persistência).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
  try {
    const trayApi = makeTrayApi();
    const m = await boot(dir, trayApi);
    const tray = trayApi.instance();
    assert.ok(tray, 'bandeja instanciada');
    assert.equal(tray.tooltip, 'OpenCrosshairQ');
    assert.equal(m.get().trayStatus.available, true, 'snapshot expõe bandeja disponível');

    // Minimizar real: preferência default true + bandeja funcional → esconde.
    const event = m.ui.minimize();
    assert.equal(event.prevented, true, 'minimizar é prevenido com bandeja funcional');
    assert.equal(m.ui.minimized, false, 'janela não minimizou de verdade');
    assert.equal(m.ui.hidden, true, 'janela escondida na bandeja');

    // Restauração por clique na bandeja.
    tray.handlers.get('click')();
    assert.equal(m.ui.hidden, false, 'clique restaura a janela');
    tray.handlers.get('double-click')();
    assert.equal(m.ui.shown, true, 'double-click restaura a janela');

    // Restauração pelo menu.
    m.ui.minimize();
    assert.equal(m.ui.hidden, true);
    const menu = () => tray.menus.at(-1).template;
    assert.equal(menu()[0].label, 'Abrir OpenCrosshairQ');
    menu()[0].click();
    assert.equal(m.ui.hidden, false, 'menu abrir restaura a janela minimizada');
    assert.equal(m.ui.minimized, false);

    // Menu alterna a mira e o rótulo acompanha o estado real.
    assert.equal(menu()[2].label, 'Ocultar mira');
    menu()[2].click();
    assert.equal(m.get().hidden, true, 'menu alterna mira');
    assert.equal(menu()[2].label, 'Exibir mira', 'refresh re-rotula com mira oculta');

    // Menu sair encerra o app.
    menu().at(-1).click();
    assert.equal(m.quitCalls(), 1, 'menu sair chama app.quit');

    // before-quit com perfil modificado: destroy da bandeja ANTES da
    // persistência; refresh pós-destroy é no-op e não pode falhar o store.
    m.send('cq:set', { scale: 7 });
    const menusBefore = tray.menus.length;
    assert.doesNotThrow(() => m.appEvents.get('before-quit')(), 'before-quit não lança');
    assert.equal(tray.destroyed, true, 'before-quit destrói a bandeja');
    assert.equal(tray.menus.length, menusBefore, 'nenhuma chamada nativa pós-destroy');
    const saved = loadProfiles(dir).profiles.default.settings;
    assert.equal(saved.scale, 7, 'perfil modificado persistido no before-quit');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
    assert.equal(settings.profiles.profiles.default.settings.scale, 7, 'registry do store atualizado');

    // Pós-before-quit: refresh morto não pode virar rejeição falsa do store.
    m.send('cq:set', { scale: 9 });
    assert.equal(m.get().scale, 9, 'commit aplicado com bandeja destruída');
    assert.equal(m.get().validationError, null, 'sem rejeição falsa de configuração');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- cenário B: bandeja quebrada/ausente — minimizar segue normal (não esconde),
// fechar com overlay vivo chama app.quit como fallback seguro em vez de esconder
// UI sem recuperação nem deixar overlay órfão.
{
  class BrokenTray { constructor() { throw new Error('sem shell'); } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
  try {
    const m = await boot(dir, { Tray: BrokenTray, Menu: { buildFromTemplate: () => ({}) } });
    const status = m.get().trayStatus;
    assert.equal(status.available, false, 'snapshot expõe bandeja indisponível');
    assert.match(status.error, /sem shell/, 'erro da bandeja visível no status');
    const event = m.ui.minimize();
    assert.equal(event.prevented, false, 'sem bandeja, minimizar segue normal');
    assert.equal(m.ui.minimized, true, 'janela minimizou de verdade');
    assert.equal(m.ui.hidden, false, 'sem bandeja, janela não é escondida');

    // Construtor falho (revisão: fallback:false, refresh no-op pós-fail):
    // close nativo com overlay vivo não esconde UI; chama app.quit como fallback seguro.
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay permanece vivo');
    const closeEv = m.ui.close();
    assert.equal(closeEv.prevented, false, 'close não é cancelado sem bandeja');
    assert.equal(m.ui.isDestroyed(), true, 'janela destruída sem bandeja');
    assert.equal(m.ui.hidden, false, 'janela não é escondida');
    assert.equal(m.quitCalls(), 1, 'app.quit chamado como fallback seguro');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // Bandeja ausente (APIs nulas): IPC close com overlay vivo também chama app.quit
  const dirNoTray = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-notray-'));
  try {
    const m = await boot(dirNoTray, { Tray: null, Menu: null });
    assert.equal(m.get().trayStatus.available, false, 'bandeja indisponível');
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay permanece vivo');
    m.send('cq:window-control', 'close');
    assert.equal(m.quitCalls(), 1, 'tray ausente: IPC close chama app.quit como fallback');
    assert.equal(m.ui.isDestroyed(), true);
    assert.equal(m.ui.hidden, false);
  } finally { fs.rmSync(dirNoTray, { recursive: true, force: true }); }
}

// --- cenário C: refresh da bandeja falha NA alteração que o causou — o
// broadcast da mesma alteração já publica trayStatus available:false + error
// (refresh roda ANTES do broadcast; ordem inversa publicaria disponível:true
// obsoleto e nunca mais re-publicaria). Minimizar segue normal.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
  try {
    class FlakyTray {
      constructor(icon) { this.icon = icon; this.handlers = new Map(); this.menus = []; this.n = 0; this.destroyed = false; }
      setToolTip(t) { this.tooltip = t; }
      setContextMenu(menu) { this.n++; if (this.n > 1) throw new Error('shell sumiu'); this.menus.push(menu); }
      on(name, fn) { this.handlers.set(name, fn); }
      destroy() { this.destroyed = true; }
    }
    const m = await boot(dir, { Tray: FlakyTray, Menu: { buildFromTemplate: (t) => ({ template: t }) } });
    assert.equal(m.get().trayStatus.available, true, 'bandeja inicia disponível');
    const before = m.sent.length;
    m.send('cq:set', { hidden: true });
    assert.equal(m.get().hidden, true, 'commit aplicado');
    const states = m.sent.slice(before).filter((s) => s.channel === 'cq:state');
    assert.ok(states.length >= 1, 'alteração publicada');
    assert.ok(states.every((s) => s.payload.trayStatus?.available === false), 'TODO cq:state pós-falha já traz available:false (refresh antes do broadcast)');
    const last = states.at(-1).payload;
    assert.match(last.trayStatus.error, /shell sumiu/, 'erro da falha publicado no mesmo snapshot');
    assert.equal(last.hidden, true, 'commit veio junto no snapshot');
    const event = m.ui.minimize();
    assert.equal(event.prevented, false, 'bandeja morta não esconde a janela');
    assert.equal(m.ui.minimized, true);

    // Runtime fail seguida de novo close: bandeja invalidada no meio da execução.
    // Overlay vivo; novo close não pode esconder a UI sem saída — chama app.quit como fallback.
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay permanece vivo');
    const closeEv = m.ui.close();
    assert.equal(closeEv.prevented, false, 'close pós-runtime-fail não é cancelado');
    assert.equal(m.ui.isDestroyed(), true, 'UI destruída');
    assert.equal(m.ui.hidden, false, 'runtime fail seguida de close não esconde app sem saída');
    assert.equal(m.quitCalls(), 1, 'app.quit chamado como fallback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- cenário D (BACK-1): fechar centralizado em ui.on('close') —
// com bandeja disponível: IPC close e native close com overlay vivo cancelam destruição
// e escondem para a bandeja (decisão do usuário); tray.restore reexibe (show + focus);
// durante quit real (before-quit) close destrói de verdade sem mascarar quit com preventDefault;
// window-all-closed encerra após todas as janelas destruídas (não fecha overlay antes da UI).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
  try {
    const trayApi = makeTrayApi();
    const m = await boot(dir, trayApi);
    const tray = trayApi.instance();

    // 1. IPC close COM overlay vivo: não destrói janela nem encerra app, esconde para bandeja
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay vivo');
    m.send('cq:window-control', 'close');
    assert.equal(m.ui.isDestroyed(), false, 'IPC close não destrói a janela');
    assert.equal(m.ui.hidden, true, 'IPC close esconde a janela');
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay permanece vivo');
    assert.equal(m.quitCalls(), 0, 'IPC close não encerra o app');

    // Restauração por clique na bandeja: show + focus
    m.ui.focused = false;
    tray.handlers.get('click')();
    assert.equal(m.ui.hidden, false, 'clique na bandeja reexibe a janela escondida');
    assert.equal(m.ui.shown, true, 'tray.restore faz show');
    assert.equal(m.ui.focused, true, 'tray.restore faz focus na janela');

    // 2. Native close COM overlay vivo: interceptado por ui.on('close'), cancela destruição
    m.ui.focused = false;
    const nativeEv = m.ui.close();
    assert.equal(nativeEv.prevented, true, 'native close cancelado quando bandeja disponível');
    assert.equal(m.ui.isDestroyed(), false, 'native close não destrói a janela');
    assert.equal(m.ui.hidden, true, 'native close esconde a janela');
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay permanece vivo');
    assert.equal(m.quitCalls(), 0, 'native close não encerra o app');

    // Restauração por double-click na bandeja: show + focus
    tray.handlers.get('double-click')();
    assert.equal(m.ui.hidden, false, 'double-click reexibe a janela escondida');
    assert.equal(m.ui.shown, true, 'tray.restore faz show');
    assert.equal(m.ui.focused, true, 'tray.restore faz focus');

    // 3. Quitting permite destruir: before-quit desativa cancelamento;
    // NÃO fechar overlay antes da UI — UI fecha primeiro sob quit, overlay depois.
    m.appEvents.get('before-quit')();
    const quitEv = m.ui.close();
    assert.equal(quitEv.prevented, false, 'close durante quit não é cancelado');
    assert.equal(m.ui.isDestroyed(), true, 'UI destruída durante quit');
    assert.equal(m.windows[1].isDestroyed(), false, 'overlay ainda vivo');
    m.windows[1].close();
    assert.equal(m.windows.every((w) => w.isDestroyed()), true, 'todas as janelas destruídas');
    assert.equal(m.quitCalls(), 1, 'window-all-closed encerra o app após todas destruídas');

    // Durante quit real, IPC close também destrói
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
    try {
      const m2 = await boot(dir2, makeTrayApi());
      m2.appEvents.get('before-quit')();
      m2.send('cq:window-control', 'close');
      assert.equal(m2.ui.isDestroyed(), true, 'IPC close durante quit destrói a janela');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- cenário E (BACK-3): display-removed só reseta displayId quando o
// monitor removido foi o selecionado; remoção de outro monitor preserva a
// seleção; reposition roda em ambos os casos.
{
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 3, bounds: { x: 3840, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-main-tray-'));
  try {
    const m = await boot(dir, makeTrayApi(), { displays });
    m.send('cq:set', { displayId: 2 });
    assert.equal(m.get().displayId, 2, 'monitor 2 selecionado');

    // Remove o monitor 3 (não selecionado): seleção preservada.
    const removed = displays.splice(2, 1)[0];
    let boundsCalls = 0;
    m.windows[1].setBounds = () => boundsCalls++;
    m.emitScreen('display-removed', {}, removed);
    assert.equal(m.get().displayId, 2, 'remoção de monitor não selecionado preserva displayId');
    assert.ok(boundsCalls >= 1, 'reposition chamado com monitor preservado');

    // Remove o monitor 2 (selecionado): reseta para o primário.
    boundsCalls = 0;
    const removedSelected = displays.splice(1, 1)[0];
    m.emitScreen('display-removed', {}, removedSelected);
    assert.equal(m.get().displayId, 1, 'remoção do monitor selecionado reseta para o primário');
    assert.ok(boundsCalls >= 1, 'reposition chamado após reset');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('PASS: main↔tray integração (minimizar real, restauração clique/menu, quit, before-quit com perfil modificado, trayStatus, refresh antes do broadcast na falha, fechar para bandeja, display-removed condicional)');
