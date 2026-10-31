// CrosshairQ main process. Window flags mirror the mechanism observed in the
// original app (transparent, frameless, non-focusable, click-through overlay)
// — reimplemented from scratch.
const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('path');
const { createStore, DEFAULTS, validatePatch, createToggleShortcut } = require('./state');
const { loadProfiles, saveProfile, deleteProfileFile, configureProfile } = require('./profiles');
const { createTray, willMinimizeToTray } = require('./tray');
const { createStartup } = require('./startup');
const { createForegroundMonitor } = require('./foreground');
const { createInputMonitor } = require('./input');
const GameState = require('../shared/game-state');
const G = require('../shared/geometry.js');
const Streamer = require('./streamer.js');

let overlay = null;
let ui = null;
let store = null;
let userDataDir = null;
let foregroundMonitor = null;
let inputMonitor = null;
let profileInFocus = true;
let gameInFocus = false;
let nativeStatus = { available: false, foreground: null, error: null };
let pendingProfile = null;
let quitting = false;
let shortcut = null;
let validationError = null;
let applyingProfile = false;
let tray = null;
let startup = null;

function targetDisplay() {
  const preferred = screen.getAllDisplays().find((d) => d.id === store.get().displayId);
  return preferred || screen.getPrimaryDisplay();
}

// Window ratio mirrors the original: 1/2 monitor when "limit size" is on,
// otherwise the whole monitor (tutorial's 1/12 comes later with onboarding).
const LIMIT_SIZE_RATIO = 0.5;

// Bounds for the overlay window, centered on the target display.
// ponytail: add 1/12 tutorial ratio when the tutorial lands.
function calculateWindowBounds(display, ratio = 1) {
  const { width, height } = display.bounds;
  const w = Math.floor(width * ratio);
  const h = Math.floor(height * ratio);
  return {
    width: w, height: h,
    x: Math.floor(display.bounds.x + (width - w) / 2),
    y: Math.floor(display.bounds.y + (height - h) / 2),
  };
}

// DPI compensation observed in the original: zoom = 1/scaleFactor on the
// target display (restores persisted preference instead of forcing it).
function reposition() {
  if (overlay && !overlay.isDestroyed()) {
    const ratio = store.get().limitSize ? LIMIT_SIZE_RATIO : 1;
    const display = targetDisplay();
    overlay.setBounds(calculateWindowBounds(display, ratio));
    overlay.webContents.setZoomFactor(1 / display.scaleFactor);
  }
  broadcast();
}

// Topmost enforcement observed in the original: check every 3 s, re-assert
// every 15 s (guards against shells/games dropping the window level).
let enforceTick = 0;
function enforceTopmost() {
  if (!overlay || overlay.isDestroyed()) return;
  const due = enforceTick % 5 === 0; // every 15 s at a 3 s cadence
  if (due || !overlay.isAlwaysOnTop() || !overlay.isVisible()) {
    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (!overlay.isVisible()) overlay.showInactive();
  }
  enforceTick++;
}

function createOverlay() {
  const display = targetDisplay();
  overlay = new BrowserWindow({
    ...calculateWindowBounds(display),
    transparent: true, frame: false, skipTaskbar: true,
    focusable: false, resizable: false, movable: false,
    hasShadow: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
      sandbox: true, nodeIntegration: false, contextIsolation: true,
    },
  });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  overlay.once('ready-to-show', () => {
    reposition();
    overlay.show();
    if (inputMonitor) overlay.webContents.send('cq:input', inputMonitor.getStatus());
  });
}

function createUi() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  ui = new BrowserWindow({
    title: 'OpenCrosshairQ',
    icon: iconPath,
    width: 1280, height: 820, minWidth: 1040, minHeight: 660, show: false, frame: false,
    backgroundColor: '#0d0d11',
    webPreferences: {
      preload: path.join(__dirname, '..', 'ui', 'preload.js'),
      sandbox: true, nodeIntegration: false, contextIsolation: true,
    },
  });
  ui.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  ui.once('ready-to-show', () => {
    const s = store ? store.get() : null;
    if (s && s.startMinimized) {
      if (willMinimizeToTray(s, tray)) {
        return;
      }
      ui.minimize();
    } else {
      ui.show();
    }
  });
}

function broadcast() {
  if (!store || quitting) return;
  const state = snapshot();
  for (const win of [overlay, ui]) {
    if (win && !win.isDestroyed()) win.webContents.send('cq:state', state);
  }
}

function snapshot() {
  return {
    ...store.get(), profileInFocus, gameInFocus,
    nativeStatus, shortcutStatus: shortcut?.getStatus() ?? null, validationError,
    trayStatus: tray ? { available: tray.available, error: tray.error } : null,
  };
}
const PROFILE_KEYS = ['visible', 'hidden', 'scale', 'offsetX', 'offsetY', 'limitSize', 'showSecondary', 'model', 'model2', 'layers', 'drawing', 'displayId', 'crosshairSize', 'crosshairOffset', 'defaultCrosshair', 'keybinds', 'firingOptions'];
function setState(patch) {
  if (shortcut && 'keybinds' in patch) {
    const status = shortcut.update(patch.keybinds, () => store.set(patch));
    if (status.error) throw new Error(status.error);
  } else store.set(patch);
}
function persistCurrentProfile() {
  const state = store.get();
  const current = state.profiles.profiles[state.profiles.currentProfileId];
  if (!current) return;
  const profile = { ...current, settings: Object.fromEntries(PROFILE_KEYS.map(key => [key, state[key]])) };
  saveProfile(userDataDir, profile);
  store.set({ profiles: { profiles: { ...state.profiles.profiles, [profile.id]: profile } } });
}
function queueProfileSave() {
  clearTimeout(pendingProfile);
  pendingProfile = setTimeout(() => {
    pendingProfile = null;
    try { persistCurrentProfile(); } catch (error) { console.error('[profiles]', error.message); }
  }, 200);
}

app.whenReady().then(() => {
  userDataDir = app.getPath('userData');
  const profiles = loadProfiles(userDataDir);
  if (!profiles.profiles['default']) {
    profiles.profiles['default'] = {
      id: 'default', name: 'default', createdAt: Date.now(),
      process: null, settings: { ...DEFAULTS },
    };
  }
  store = createStore(userDataDir, profiles);

  function applyProfile(id, savePrevious = true) {
    if (typeof id !== 'string' || !Object.hasOwn(store.get().profiles.profiles, id)) return false;
    clearTimeout(pendingProfile);
    pendingProfile = null;
    applyingProfile = true;
    try {
      if (savePrevious) persistCurrentProfile();
      const p = store.get().profiles.profiles[id];
      const settings = validatePatch(p.settings, store.get());
      const foregroundPath = nativeStatus.foreground?.executablePath;
      const nextFocus = !p.process?.path || !p.hideCrosshairWhenUnfocused || !foregroundPath || p.process.path === foregroundPath;
      setState({
        visible: settings.visible ?? true,
        hidden: settings.hidden ?? false,
        scale: settings.scale ?? 1,
        offsetX: settings.offsetX ?? 0,
        offsetY: settings.offsetY ?? 0,
        limitSize: settings.limitSize ?? false,
        showSecondary: settings.showSecondary ?? false,
        model: settings.model ?? G.defaultModel(),
        model2: settings.model2 ?? G.defaultModel(),
        layers: settings.layers ?? [],
        drawing: settings.drawing ?? null,
        displayId: settings.displayId ?? null,
        crosshairSize: settings.crosshairSize ?? 1,
        crosshairOffset: settings.crosshairOffset ?? { x: 0, y: 0 },
        defaultCrosshair: settings.defaultCrosshair ?? null,
        keybinds: settings.keybinds ?? DEFAULTS.keybinds,
        firingOptions: settings.firingOptions ?? DEFAULTS.firingOptions,
        profiles: { currentProfileId: id },
      });
      profileInFocus = nextFocus;
      validationError = null;
    } catch (error) {
      console.error('[profile apply]', error.message);
      validationError = `Perfil rejeitado: ${error.message}`;
      broadcast();
      return false;
    } finally { applyingProfile = false; }
    reposition();
    return true;
  }

  const selected = store.get().profiles.currentProfileId;
  // Existing legacy settings remain the seed until a default profile file exists.
  if (selected !== 'default' || fs.existsSync(path.join(userDataDir, 'profiles', 'default.json'))) applyProfile(selected, false);
  createUi();
  createOverlay();

  // Bandeja: restauração por clique e menu abrir/toggle-mira/sair. Se a bandeja
  // não puder ser criada, minimizar segue o comportamento normal.
  tray = createTray({ Tray, Menu }, {
    iconPath: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    getHidden: () => store.get().hidden,
    toggleCrosshair: () => {
      try {
        validationError = null;
        store.set({ hidden: !store.get().hidden });
      } catch (error) {
        console.error('[tray toggle]', error.message);
        validationError = `Configuração rejeitada: ${error.message}`;
        broadcast();
      }
    },
    restore: () => {
      if (ui && !ui.isDestroyed()) {
        if (ui.isMinimized()) ui.restore();
        ui.show();
        ui.focus();
      }
    },
    quit: () => app.quit(),
  });

  // Minimizar esconde a janela somente com minimizeToTray ligado e bandeja funcional.
  ui.on('minimize', (event) => {
    if (willMinimizeToTray(store.get(), tray)) {
      event.preventDefault();
      ui.hide();
    }
  });

  // Fechar vai para a bandeja se disponível; fallback seguro encerra o app se indisponível.
  ui.on('close', (event) => {
    if (quitting) return;
    if (tray?.available) {
      event.preventDefault();
      ui.hide();
    } else {
      app.quit();
    }
  });


  shortcut = createToggleShortcut(globalShortcut, () => {
    try {
      validationError = null;
      store.set({ hidden: !store.get().hidden });
    } catch (error) {
      console.error('[shortcut toggle]', error.message);
      validationError = `Configuração rejeitada: ${error.message}`;
      broadcast();
    }
  });
  shortcut.update(store.get().keybinds);
  // refresh ANTES do broadcast: falha da bandeja precisa constar no snapshot
  // enviado na MESMA alteração (trayStatus available:false + error), não só na
  // seguinte — broadcast primeiro publicaria disponível:true obsoleto.
  store.onChange(() => tray?.refresh());
  store.onChange(() => { if (!applyingProfile) broadcast(); });
  const topmostTimer = setInterval(enforceTopmost, 3000);
  let native = null;
  let loadError = null;
  const resPath = typeof process !== 'undefined' && process.resourcesPath;
  const nativePaths = [
    path.join(__dirname, '../../native/build/crosshairq.node'),
    path.join(__dirname, '../../native/build/crosshairq.node').replace('app.asar', 'app.asar.unpacked'),
    resPath ? path.join(resPath, 'app.asar.unpacked', 'native', 'build', 'crosshairq.node') : null,
  ].filter(Boolean);
  for (const p of nativePaths) {
    try {
      native = require(p);
      if (native) break;
    } catch (error) {
      loadError = error.message;
    }
  }
  function evaluateNative(status) {
    nativeStatus = status;
    // gameInFocus: correspondência estrita com o executável selecionado quando onlyInGame estiver ativo
    const fgPath = status.foreground?.executablePath;
    const state = store.get();
    if (state.onlyInGame) {
      if (state.onlyInGameProcessPath && typeof fgPath === 'string' && fgPath) {
        const normFg = fgPath.toLowerCase().replace(/\//g, '\\');
        const normTarget = state.onlyInGameProcessPath.toLowerCase().replace(/\//g, '\\');
        gameInFocus = normFg === normTarget || path.basename(normFg) === path.basename(normTarget);
      } else {
        gameInFocus = false;
      }
    } else {
      gameInFocus = typeof fgPath === 'string' && !!fgPath && !/explorer\.exe$/i.test(fgPath);
    }
    const previous = { profileId: state.profiles.currentProfileId, profileInFocus };
    const next = GameState.evaluateForeground(previous, status.foreground?.executablePath, state.profiles.profiles, {
      autoSwitch: state.profileDetectionEnabled,
    });
    if (next.profileId !== previous.profileId) {
      // Evaluate current selection before attempting autoswitch; rejection must not inherit candidate focus.
      profileInFocus = GameState.evaluateForeground(previous, fgPath, state.profiles.profiles, { autoSwitch: false }).profileInFocus;
      applyProfile(next.profileId);
    } else {
      profileInFocus = next.profileInFocus;
      broadcast();
    }
  }
  foregroundMonitor = createForegroundMonitor(native, evaluateNative, loadError);
  nativeStatus = foregroundMonitor.getStatus();
  foregroundMonitor.start();
  inputMonitor = createInputMonitor(native, input => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('cq:input', input);
  });
  inputMonitor.start();
  app.once('before-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (error) { console.error('[shortcut]', error.message); }
    try { tray?.destroy(); } catch (error) { console.error('[tray]', error.message); }
    try { Streamer.stop(); } catch (error) { console.error('[streamer]', error.message); }
    inputMonitor?.stop();
    foregroundMonitor?.stop();
    clearInterval(topmostTimer);
    clearTimeout(pendingProfile);
    try { persistCurrentProfile(); } catch (error) { console.error('[profiles]', error.message); }
    try { store.flush(); } catch (error) { console.error('[settings]', error.message); }
    quitting = true;
  });

  ipcMain.handle('cq:get-state', () => snapshot());
  ipcMain.handle('cq:get-native-status', () => foregroundMonitor.getStatus());
  ipcMain.handle('cq:configure-profile', (_event, options) => {
    const state = store.get();
    const configured = configureProfile(state.profiles.profiles, options);
    const previous = state.profiles.profiles[configured.id];
    saveProfile(userDataDir, configured);
    try {
      store.set({ profiles: { profiles: { ...state.profiles.profiles, [configured.id]: configured } } });
    } catch (error) {
      // Registry commit failed: roll profile file back so disk and memory agree.
      try { saveProfile(userDataDir, previous); } catch (rollbackError) { console.error('[cq:configure-profile] rollback failed:', rollbackError.message); }
      throw error;
    }
    evaluateNative(foregroundMonitor.getStatus());
    return { id: configured.id, process: configured.process, hideCrosshairWhenUnfocused: configured.hideCrosshairWhenUnfocused };
  });
  ipcMain.on('cq:window-control', (_e, action) => {
    if (!ui || ui.isDestroyed()) return;
    if (action === 'minimize') ui.minimize();
    else if (action === 'maximize') { if (ui.isMaximized()) ui.unmaximize(); else ui.maximize(); }
    else if (action === 'close') ui.close();
  });
  ipcMain.on('cq:set', (_e, patch) => {
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      // Runtime focus/registry are main-owned, never restored from a renderer patch.
      patch = Object.fromEntries(Object.entries(patch).filter(([key]) => [...PROFILE_KEYS, 'animations', 'profileDetectionEnabled', 'onlyInGame', 'onlyInGameProcessPath', 'minimizeToTray', 'startMinimized'].includes(key)));
      const needsReposition = ['displayId', 'limitSize'].some((key) => key in patch);
      const prev = store.get();
      try {
        patch = validatePatch(patch, prev);
        validationError = null;
        setState(patch);
      } catch (error) {
        console.error('[cq:set]', error.message);
        validationError = `Configuração rejeitada: ${error.message}`;
        broadcast();
        return;
      }
      if (store.get() === prev && !needsReposition) broadcast();
      if (PROFILE_KEYS.some(key => key in patch)) queueProfileSave();
      if ('profileDetectionEnabled' in patch || 'onlyInGame' in patch || 'onlyInGameProcessPath' in patch) evaluateNative(foregroundMonitor.getStatus());
      if (needsReposition) reposition();
    }
  });
  ipcMain.handle('cq:browse-game-executable', async () => {
    const parentWin = (ui && !ui.isDestroyed()) ? ui : null;
    const result = await dialog.showOpenDialog(parentWin, {
      title: 'Selecionar Executável do Jogo',
      filters: [{ name: 'Executáveis Windows (*.exe)', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('cq:get-displays', () =>
    screen.getAllDisplays().map((d) => ({
      id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, label: d.label,
    })));


  // Contrato IPC de início automático (preload/UI: canal novo, nada de checkbox otimista):
  //   invoke 'cq:get-startup-status' → { supported, available, configured, approved, enabled, error }
  //     supported: plataforma é Windows; available: build empacotada (dev = false);
  //     configured: entrada gerenciada por nós (name 'OpenCrosshairQ', user,
  //       nosso executável Windows sem case, args POSICIONAIS expostos pelo
  //       Electron iguais a []); nomes ignoram case; outros nomes/escopos
  //       (machine/legados) não são nossos e nunca são tocados. Switches --...
  //       invisíveis em launchItems[].args não são parte da identidade verificada;
  //       no-op pode mantê-los; escrita/rollback pode removê-los. Homônima sob
  //       outro exe é invisível ao filtro Electron; não há garantia de preservação
  //       de comando completo. Divergência posicional visível aborta sem escrita;
  //     approved: StartupApproved da entrada nossa (launchItems[].enabled);
  //       null quando não há entrada;
  //     enabled: estado EFETIVO agregado pelo SO (executableWillLaunchAtLogin:
  //       mesmo exe, quaisquer args, run key aprovada) — boolean, ou null
  //       quando a leitura falhou (desconhecido); error explica o null.
  //   invoke 'cq:set-startup' (boolean) → { ok, configured, approved, enabled, error }
  //     ok=false: operação falhou; pode não ter escrito OU ter tentado rollback
  //     ao par (configurado, aprovação) ANTERIOR. Rollback pode falhar: error
  //     explicita falha detectada; campos são autoritativos, estado real relido
  //     ou null quando desconhecido. Homônima user com args POSICIONAIS
  //     divergentes visíveis aborta ANTES de escrever. A UI reexibe o retorno,
  //     nunca o valor pedido.
  //     Ligar = entrada + aprovação; desligar = não iniciar agora: se já não
  //     efetivo, no-op preserva configured:true/approved:false; senão remove
  //     nossa entrada e exige efetivo false (não remove entradas alheias).
  //   send 'cq:set' { minimizeToTray: boolean } persiste a preferência de bandeja
  //     (via snapshot em 'cq:state'); minimizar só esconde com bandeja funcional.
  //   snapshot 'cq:state' inclui trayStatus: { available, error } | null —
  //     disponibilidade real da bandeja (false após destroy/falha runtime);
  //     refresh da bandeja roda ANTES do broadcast, então a falha já aparece
  //     no snapshot da alteração que a causou.
  startup = createStartup({ app });
  ipcMain.handle('cq:get-startup-status', () => startup.getStatus());
  ipcMain.handle('cq:set-startup', (_e, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('startup inválido');
    return startup.set(enabled);
  });

  // Perfis (mecanismo do original: JSON por perfil em <userData>\profiles).
  ipcMain.handle('cq:get-profiles', () => {
    const profiles = store.get().profiles.profiles;
    return Object.values(profiles).map((p) => ({
      id: p.id, name: p.name, createdAt: p.createdAt, process: p.process,
      hideCrosshairWhenUnfocused: !!p.hideCrosshairWhenUnfocused,
    }));
  });
  ipcMain.on('cq:set-profile', (_e, payload) => { if (payload && typeof payload === 'object' && !Array.isArray(payload)) applyProfile(payload.id); });
  ipcMain.on('cq:create-profile', (_e, payload) => {
    try {
      validationError = null;
      const name = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload.name : undefined;
      clearTimeout(pendingProfile);
      pendingProfile = null;
      persistCurrentProfile();
      const cur = store.get();
      const id = 'profile_' + require('node:crypto').randomUUID();
      const p = {
        id, name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 200) : `Perfil ${Object.keys(cur.profiles.profiles).length + 1}`,
        createdAt: Date.now(), process: null,
        settings: {
          visible: cur.visible, hidden: cur.hidden, scale: cur.scale,
          offsetX: cur.offsetX, offsetY: cur.offsetY,
          limitSize: cur.limitSize, showSecondary: cur.showSecondary,
          model: cur.model, model2: cur.model2,
          layers: cur.layers, drawing: cur.drawing,
          displayId: cur.displayId ?? null,
          crosshairSize: cur.crosshairSize ?? 1,
          crosshairOffset: cur.crosshairOffset ?? { x: 0, y: 0 },
          defaultCrosshair: cur.defaultCrosshair ?? null,
          keybinds: cur.keybinds ?? DEFAULTS.keybinds,
          firingOptions: cur.firingOptions ?? DEFAULTS.firingOptions,
        },
      };
      saveProfile(userDataDir, p);
      const previousFocus = profileInFocus;
      profileInFocus = true;
      try {
        store.set({ profiles: { currentProfileId: id, profiles: { ...cur.profiles.profiles, [id]: p } } });
      } catch (error) {
        // Registry commit failed: remove the just-written file so disk and memory agree.
        profileInFocus = previousFocus;
        try { deleteProfileFile(userDataDir, id); } catch (rollbackError) { console.error('[cq:create-profile] rollback failed:', rollbackError.message); }
        throw error;
      }
      broadcast();
    } catch (error) {
      console.error('[cq:create-profile]', error.message);
      validationError = `Perfil rejeitado: ${error.message}`;
      broadcast();
    }
  });
  ipcMain.on('cq:delete-profile', (_e, payload) => {
    try {
      const id = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload.id : undefined;
      if (typeof id !== 'string' || id === 'default' || !Object.hasOwn(store.get().profiles.profiles, id)) return;
      // Snapshot COMPLETO antes de qualquer commit: seleção, settings pendentes
      // (ainda não salvos no arquivo) e foco precisam voltar se a exclusão falhar.
      const stateBefore = store.get();
      const focusBefore = profileInFocus;
      const removed = stateBefore.profiles.profiles[id];
      const isActive = stateBefore.profiles.currentProfileId === id;
      validationError = null;
      // Ativo troca para default ANTES do unlink: BACK7 exige que o arquivo do
      // ativo não seja apagado se a ativação do default falhar (reordenar o
      // unlink para antes do switch quebraria essa garantia).
      if (isActive && !applyProfile('default', false)) return;
      try {
        deleteProfileFile(userDataDir, id);
        const profiles = { ...store.get().profiles.profiles };
        delete profiles[id];
        store.set({ profiles: { profiles } });
      } catch (error) {
        // Exclusão não comprovada: restaura arquivo e, se o ativo foi trocado,
        // o snapshot completo (setState mantém atalho/registro consistentes).
        let detail = '';
        try { saveProfile(userDataDir, removed); }
        catch (rollbackError) { detail = `; rollback do arquivo falhou: ${rollbackError.message}`; }
        if (isActive) {
          try {
            profileInFocus = focusBefore;
            setState({ ...stateBefore });
          } catch (restoreError) { detail += `; restauração de estado falhou: ${restoreError.message}`; }
        }
        throw new Error(error.message + detail);
      }
      broadcast();
    } catch (error) {
      console.error('[cq:delete-profile]', error.message);
      validationError = `Perfil rejeitado: ${error.message}`;
      broadcast();
    }
  });
  ipcMain.on('cq:rename-profile', (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const { id, name } = payload;
      if (typeof id !== 'string' || !Object.hasOwn(store.get().profiles.profiles, id)) return;
      const p = store.get().profiles.profiles[id];
      if (typeof name !== 'string' || !name.trim() || name.length > 200) return;
      validationError = null;
      const renamed = { ...p, name: name.trim() };
      saveProfile(userDataDir, renamed);
      try {
        store.set({ profiles: { profiles: { ...store.get().profiles.profiles, [id]: renamed } } });
      } catch (error) {
        // Registry commit failed: roll profile file back so disk and memory agree.
        try { saveProfile(userDataDir, p); } catch (rollbackError) { console.error('[cq:rename-profile] rollback failed:', rollbackError.message); }
        throw error;
      }
      broadcast();
    } catch (error) {
      console.error('[cq:rename-profile]', error.message);
      validationError = `Perfil rejeitado: ${error.message}`;
      broadcast();
    }
  });

  // StreamerServer (esqueleto stdlib; detecção de processo vem com o addon Fase 4).
  ipcMain.handle('cq:streamer-start', (_e, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid options');
    return Streamer.start(options.port);
  });
  ipcMain.handle('cq:streamer-stop', () => Streamer.stop());
  ipcMain.handle('cq:get-streaming', () => Streamer.getStatus());

  // Global toggle follows the current profile; registration status is broadcast.

  screen.on('display-metrics-changed', (_e, _display, changed) => {
    if (changed.length) reposition();
  });
  screen.on('display-removed', () => {
    // Só reseta quando o monitor escolhido foi o removido; senão preserva.
    if (!screen.getAllDisplays().some((d) => d.id === store.get().displayId)) {
      store.set({ displayId: screen.getPrimaryDisplay().id });
    }
    reposition();
  });
});

app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (error) { console.error('[shortcut]', error.message); } });
app.on('window-all-closed', () => app.quit());
