// Central state store with persistence. Single source of truth for the overlay,
// mirroring the original's central-state + broadcast mechanism.
const fs = require('fs');
const path = require('path');
const Layers = require('../shared/layers');
const PROFILE_KEYS = ['visible', 'hidden', 'scale', 'offsetX', 'offsetY', 'limitSize', 'showSecondary', 'captureVisible', 'model', 'model2', 'layers', 'drawing', 'displayId', 'crosshairSize', 'crosshairOffset', 'defaultCrosshair', 'keybinds', 'firingOptions'];

// Shape validation for the remappable action shortcuts (aim/fire/reload).
// Values are kept verbatim: key names are resolved by main/keymap.js.
function keybindBinding(binding, label) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError(`atalho ${label} inválido`);
  if (binding.enabled !== undefined && typeof binding.enabled !== 'boolean') throw new TypeError(`${label}.enabled inválido`);
  if (binding.pressType !== undefined && !['press', 'hold', 'toggle'].includes(binding.pressType)) throw new TypeError(`${label}.pressType inválido`);
  if (binding.controller !== undefined && binding.controller !== null) {
    if (typeof binding.controller !== 'object' || Array.isArray(binding.controller)
      || !require('./keybind-dispatch').CONTROLLER_KEYS.includes(binding.controller.key)) throw new TypeError(`${label}.controller inválido`);
  }
  if (binding.pc === undefined || binding.pc === null) return;
  if (typeof binding.pc !== 'object' || Array.isArray(binding.pc)) throw new TypeError(`${label}.pc inválido`);
  if (typeof binding.pc.key !== 'string' || !binding.pc.key) throw new TypeError(`${label}.pc.key inválido`);
  if (binding.pc.modifiers !== undefined && (!Array.isArray(binding.pc.modifiers) || binding.pc.modifiers.some((m) => typeof m !== 'string' || !m))) throw new TypeError(`${label}.pc.modifiers inválido`);
}


function validatePatch(patch, current = {}) {
  const ALLOWED_KEYS = [...new Set([...Object.keys(DEFAULTS), 'animations'])];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch inválido');
  const next = {};
  for (const key of Object.keys(patch)) if (ALLOWED_KEYS.includes(key)) next[key] = patch[key];
  for (const key of ['model', 'model2']) {
    if (key in next) next[key] = next[key] == null ? defaultModel() : Layers.validateModel(next[key]);
  }
  if ('layers' in next || 'drawing' in next) {
    if ('drawing' in next && next.drawing != null && !('layers' in next)) throw new TypeError('drawing exige camadas; SVG isolado não é aceito');
    next.layers = Layers.validateLayers('layers' in next ? next.layers : (current.layers ?? []));
    next.drawing = next.layers.length || next.drawing != null ? Layers.renderLayers(next.layers) : null;
  }
  if ('keybinds' in next) {
    const kb = next.keybinds;
    if (!kb || typeof kb !== 'object' || Array.isArray(kb)) throw new TypeError('atalhos inválidos');
    const binding = kb.globalShortcut ?? DEFAULTS.keybinds.globalShortcut;
    accelerator(binding);
    for (const action of ['aim', 'fire', 'reload']) {
      if (!kb[action]) continue;
      keybindBinding(kb[action], action);
      if (action === 'aim' && kb.aim.pressType !== undefined && !['hold', 'toggle'].includes(kb.aim.pressType)) throw new TypeError('aim.pressType inválido');
    }
    next.keybinds = { ...kb, globalShortcut: binding };
  }

  if ('hidden' in next && typeof next.hidden !== 'boolean') throw new TypeError('hidden inválido');
  if ('visible' in next && typeof next.visible !== 'boolean') throw new TypeError('visible inválido');
  if ('limitSize' in next && typeof next.limitSize !== 'boolean') throw new TypeError('limitSize inválido');
  if ('showSecondary' in next && typeof next.showSecondary !== 'boolean') throw new TypeError('showSecondary inválido');
  if ('minimizeToTray' in next && typeof next.minimizeToTray !== 'boolean') throw new TypeError('minimizeToTray inválido');
  if ('startMinimized' in next && typeof next.startMinimized !== 'boolean') throw new TypeError('startMinimized inválido');
  if ('onlyInGame' in next && typeof next.onlyInGame !== 'boolean') throw new TypeError('onlyInGame inválido');
  if ('captureVisible' in next && typeof next.captureVisible !== 'boolean') throw new TypeError('captureVisible inválido');
  if ('onlyInGameProcessPath' in next) {
    if (next.onlyInGameProcessPath !== null && typeof next.onlyInGameProcessPath !== 'string') throw new TypeError('onlyInGameProcessPath inválido');
    if (next.onlyInGameProcessPath === null) next.onlyInGameProcessPath = '';
  }
  if ('profileDetectionEnabled' in next && typeof next.profileDetectionEnabled !== 'boolean') throw new TypeError('profileDetectionEnabled inválido');
  if ('animations' in next && (next.animations !== null && (typeof next.animations !== 'object' || Array.isArray(next.animations)))) throw new TypeError('animations inválido');
  if ('defaultCrosshair' in next && next.defaultCrosshair !== null) next.defaultCrosshair = Layers.validateCrosshair(next.defaultCrosshair);
  if ('displayId' in next && next.displayId !== null && (!Number.isInteger(next.displayId) || next.displayId < -2147483648 || next.displayId > 2147483647)) throw new TypeError('displayId inválido');
  for (const key of ['scale', 'crosshairSize']) if (key in next) {
    if (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || next[key] < 0.01 || next[key] > 100) throw new TypeError(`${key} inválido`);
  }
  for (const key of ['offsetX', 'offsetY']) if (key in next) {
    if (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || Math.abs(next[key]) > 100000) throw new TypeError(`${key} inválido`);
  }
  if ('crosshairOffset' in next) {
    const v = next.crosshairOffset;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('crosshairOffset inválido');
    else {
      if (typeof v.x !== 'number' || !Number.isFinite(v.x) || Math.abs(v.x) > 100000) throw new TypeError('crosshairOffset.x inválido');
      if (typeof v.y !== 'number' || !Number.isFinite(v.y) || Math.abs(v.y) > 100000) throw new TypeError('crosshairOffset.y inválido');
      next.crosshairOffset = { x: v.x, y: v.y };
    }
  }
  if ('firingOptions' in next && (next.firingOptions === null || typeof next.firingOptions !== 'object' || Array.isArray(next.firingOptions))) throw new TypeError('firingOptions inválido');
  if ('profiles' in next) {
    const p = next.profiles;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('profiles inválido');
    if ('currentProfileId' in p && p.currentProfileId !== null && typeof p.currentProfileId !== 'string') throw new TypeError('currentProfileId inválido');
    if ('profiles' in p && (!p.profiles || typeof p.profiles !== 'object' || Array.isArray(p.profiles))) throw new TypeError('profiles inválido');
    const profiles = p.profiles ?? current.profiles?.profiles ?? {};
    const selected = p.currentProfileId ?? current.profiles?.currentProfileId ?? 'default';
    if (!Object.hasOwn(profiles, selected)) throw new TypeError('currentProfileId inválido');
    next.profiles = { currentProfileId: selected, profiles };
  }
  return next;
}

function accelerator(binding) {
  if (!binding || typeof binding !== 'object' || (binding.enabled !== undefined && typeof binding.enabled !== 'boolean') || (binding.pressType !== undefined && binding.pressType !== 'press')) throw new TypeError('alternar global exige tecla de pressão');
  const pc = binding.pc;
  const aliases = { Ctrl: 'Control', Meta: 'Super' };
  if (!pc || !Array.isArray(pc.modifiers) || pc.modifiers.length > 4 || !pc.modifiers.every(m => ['Ctrl', 'Control', 'Alt', 'Shift', 'Meta', 'Super', 'Command', 'CommandOrControl'].includes(m))) throw new TypeError('modificadores inválidos');
  if (typeof pc.key !== 'string' || !/^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|[+\-=,.;/\[\]\\'`])$/.test(pc.key)) throw new TypeError('tecla global não suportada');
  const key = pc.key === '+' ? 'Plus' : pc.key.replace(/^Arrow/, '');
  return [...new Set(pc.modifiers.map(m => aliases[m] || m)), key].join('+');
}

function createToggleShortcut(api, toggle) {
  let registered = null;
  let signature = null;
  let requestedSignature = null;
  let appliedBindings = null;
  let status = { registered: false, accelerator: null, error: null };
  return {
    update(keybinds, commit) {
      const binding = keybinds?.globalShortcut ?? DEFAULTS.keybinds.globalShortcut;
      const nextSignature = JSON.stringify(binding);
      // An action-only edit must not reacquire an unavailable, unchanged global shortcut.
      const actionOnlyEdit = JSON.stringify(keybinds) !== appliedBindings;
      if (commit && nextSignature === requestedSignature && (actionOnlyEdit || !status.error)) {
        if (nextSignature === signature) status = { registered: !!registered, accelerator: registered, error: null };
        try { commit(); appliedBindings = JSON.stringify(keybinds); return { ...status, committed: true }; }
        catch (error) { return { ...status, committed: false, error: error.message }; }
      }
      if (!commit) { requestedSignature = nextSignature; appliedBindings = JSON.stringify(keybinds); }
      let candidate = null;
      let acquired = false;
      try {
        candidate = binding.enabled === false ? null : accelerator(binding);
        if (nextSignature !== signature && candidate && candidate !== registered) {
          if (!api.register(candidate, toggle)) throw new Error('Combinação indisponível; escolha outra tecla.');
          acquired = true;
        }
        status = { registered: !!candidate, accelerator: candidate, error: null };
        // Keep old registration until persistence succeeds; failed commits release only candidate.
        commit?.();
        if (registered && registered !== candidate) api.unregister(registered);
        registered = candidate;
        signature = nextSignature;
        requestedSignature = nextSignature;
        appliedBindings = JSON.stringify(keybinds);
      } catch (error) {
        if (acquired) api.unregister(candidate);
        status = { registered: !!registered, accelerator: candidate, error: error.message };
      }
      return { ...status, committed: !status.error };
    },
    getStatus: () => status,
  };
}

const DEFAULTS = {
  hidden: false,          // hidden by the global toggle (original: isHiddenByKeyboard)
  visible: true,         // normal visibility toggle
  scale: 1,               // 0.01..100 (IPC), UI clamps 0.01..10 step 0.1
  offsetX: 0, offsetY: 0, // +X right, +Y up (original semantics)
  crosshairSize: 1,       // perfil: multiplicador de tamanho da mira
  crosshairOffset: { x: 0, y: 0 }, // perfil: deslocamento da mira
  displayId: null,        // resolved to primary on first read
  limitSize: false,       // original limitCrosshairSizeEnabled: window at 1/2 monitor
  minimizeToTray: true,   // minimizar esconde a janela na bandeja (requer bandeja funcional)
  startMinimized: false,  // iniciar aplicativo minimizado/na bandeja
  showSecondary: false,   // one global secondary (original: isSavedCrosshairVisible)
  defaultCrosshair: null, // perfil: mira default serializada
  captureVisible: true, // overlay visible in screen recordings (OBS Display Capture). false = content protection on.
  keybinds: {             // perfil: atalhos (globalShortcut/aim/fire/reload)
    crosshairs: [],
    globalShortcut: { id: null, enabled: true, action: 'toggleHide', pressType: 'press', pc: { modifiers: ['Alt', 'Shift'], key: 'Z', platform: 'PC' }, controller: null },
    aim: { id: null, enabled: true, action: 'aim', pressType: 'hold', pc: { modifiers: [], key: 'RightClick', platform: 'PC' }, controller: { key: 'leftTrigger' } },
    fire: { id: null, enabled: true, action: 'fire', pressType: 'hold', pc: { modifiers: [], key: 'LeftClick', platform: 'PC' }, controller: { key: 'rightTrigger' } },
    reload: { id: null, enabled: true, action: 'reload', pressType: 'press', pc: { modifiers: [], key: 'R', platform: 'PC' }, controller: { key: 'faceWest' } },
  },
  firingOptions: { duration: 0, startDelay: 0, easing: 'linear', mouseButton: 'left', loop: false, direction: 'normal', pressType: 'press', releaseBehavior: 'reset' },
  onlyInGame: false,      // gate uses a separately supplied foreground observation
  onlyInGameProcessPath: '', // executável selecionado para filtro de jogo
  profileDetectionEnabled: true,
  model: null,            // set by caller via defaults module when renderer-less
  model2: null,           // secondary crosshair model
  layers: [],             // designer layers (own format, by design)
  drawing: null,          // compiled SVG fragment from the designer
  profiles: null,         // { currentProfileId, profiles: { id: profile } } initialized by main
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('estado exige objetos JSON');
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function createStore(userDataDir, initialProfiles) {
  const file = path.join(userDataDir, 'settings.json');
  let state = { ...structuredClone(DEFAULTS), model: defaultModel(), model2: defaultModel() };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('settings inválido');
    if (saved.keybinds?.aim && saved.keybinds.aim.enabled === undefined) {
      saved.keybinds.aim.enabled = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[settings]', error.message);
    saved = {};
  }
  // Validate disk fields independently so one corrupt value cannot erase valid settings.
  for (const key of Object.keys(saved)) {
    if (['profiles', 'layers', 'drawing'].includes(key)) continue;
    try { Object.assign(state, validatePatch({ [key]: saved[key] }, state)); }
    catch (error) { console.error('[settings]', error.message); }
  }
  try { Object.assign(state, validatePatch({ layers: saved.layers ?? [], drawing: saved.drawing ?? null }, state)); }
  catch (error) { console.error('[settings]', error.message); }
  const selected = saved.profiles?.currentProfileId;
  const profiles = initialProfiles?.profiles ?? {};
  state.profiles = {
    currentProfileId: Object.hasOwn(profiles, selected) ? selected : 'default',
    profiles: structuredClone(profiles),
  };
  const journal = saved.profileSettingsJournal;
  if (journal && journal.id === selected && journal.settings && Object.hasOwn(profiles, selected)) {
    try {
      const settings = validatePatch(Object.fromEntries(PROFILE_KEYS.filter(key => key in journal.settings).map(key => [key, journal.settings[key]])), state);
      state.profiles.profiles[selected] = { ...state.profiles.profiles[selected], settings };
    } catch (error) { console.error('[profile recovery]', error.message); }
  }
  state = deepFreeze(state);

  const listeners = new Set();
  const persist = (next = state) => {
    const temporary = `${file}.tmp`;
    try {
      const id = next.profiles.currentProfileId;
      const profileSettingsJournal = next.profiles.profiles[id]?.settings
        ? { id, settings: Object.fromEntries(PROFILE_KEYS.map(key => [key, next[key]])) } : null;
      fs.writeFileSync(temporary, JSON.stringify({ ...next, profileSettingsJournal }, null, 2));
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* temp may not exist */ }
      throw error;
    }
  };
  const set = (patch) => {
    patch = structuredClone(validatePatch(patch, state));
    const next = { ...state, ...patch };
    // Live settings and their selected profile journal persist in one atomic write.
    deepFreeze(next);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    // ponytail: synchronous commit keeps memory/disk atomic; serialize async writes if settings grow.
    persist(next);
    state = next;
    for (const fn of listeners) fn(state);
  };
  return {
    get: () => state,
    set,
    onChange(fn) { listeners.add(fn); },
    flush() { persist(); },
  };
}

function defaultModel() {
  return require('../shared/geometry.js').defaultModel();
}

module.exports = { createStore, DEFAULTS, validatePatch, accelerator, createToggleShortcut };
