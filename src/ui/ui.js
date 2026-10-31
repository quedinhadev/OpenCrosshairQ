// UI renderer: binds controls to the central store via IPC.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editing = 'model';
  let currentRoute = 'crosshairs';
  let currentXTab = 'descobrir';
  let displaysCache = [];
  const isApp = typeof window !== 'undefined' && typeof window.addEventListener === 'function';

  const currentModel = () => (state && (state[editing] || state.model)) || {};
  const set = (patch) => { if (window.cq && typeof window.cq.set === 'function') window.cq.set(patch); };
  const setModel = (patch) => set({ [editing]: { ...currentModel(), ...patch } });

  function escapeHtml(s) {
    const str = typeof s === 'string' ? s : (s == null ? '' : (typeof s === 'number' || typeof s === 'boolean' ? String(s) : ''));
    return str.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('on'), 2800);
  }
  const corruptStorageKeys = new Set();

  function loadJson(key, fallback) {
    try {
      if (typeof localStorage === 'undefined') return fallback;
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined || raw === '') {
        corruptStorageKeys.delete(key);
        return fallback;
      }
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(fallback) && !Array.isArray(parsed)) {
          corruptStorageKeys.add(key);
          return fallback;
        }
        corruptStorageKeys.delete(key);
        return parsed;
      } catch {
        corruptStorageKeys.add(key);
        return fallback;
      }
    } catch {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      if (typeof localStorage === 'undefined') return false;
      if (corruptStorageKeys.has(key)) {
        toast('Armazenamento local corrompido: gravação bloqueada para evitar perda de dados.');
        return false;
      }
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(str, 'utf8');
    if (typeof Blob !== 'undefined') return new Blob([str]).size;
    return str.length;
  }

  function encodeBase64(str) {
    if (typeof btoa === 'function') {
      try { return btoa(unescape(encodeURIComponent(str))); } catch { /* fallback */ }
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'utf8').toString('base64');
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    const utf8 = unescape(encodeURIComponent(str));
    let output = '';
    for (let block = 0, charCode, i = 0, map = chars;
         utf8.charAt(i | 0) || (map = '=', i % 1);
         output += map.charAt(63 & block >> 8 - i % 1 * 8)) {
      charCode = utf8.charCodeAt(i += 3/4);
      block = block << 8 | charCode;
    }
    return output;
  }
  function decodeBase64(str) {
    if (typeof atob === 'function') {
      try { return decodeURIComponent(escape(atob(str))); } catch { /* fallback */ }
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'base64').toString('utf8');
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let input = String(str).replace(/=+$/, '');
    let output = '';
    for (let bc = 0, bs = 0, buffer, i = 0;
         buffer = input.charAt(i++);
         ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer,
           bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
      buffer = chars.indexOf(buffer);
    }
    return decodeURIComponent(escape(output));
  }

  let audioCtx = null;
  function getAudioContext() {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtx) {
      try { audioCtx = new AudioCtx(); } catch { /* unsupported */ }
    }
    return audioCtx;
  }
  function playSfx(type) {
    if (loadJson('cq.soundEffects', false) !== true) return;
    const ctx = getAudioContext();
    if (!ctx || ctx.state === 'closed') return;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      if (type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(300, now + 0.035);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.04);
      } else if (type === 'toggle') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(660, now + 0.025);
        gain.gain.setValueAtTime(0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.065);
      } else if (type === 'success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.07);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.085);
      }
    } catch { /* audio not available */ }
  }

  const I18N = {
    'pt-BR': {
      navCrosshairs: 'Miras',
      navDesigner: 'Criador',
      navPositions: 'Posições',
      navKeybinds: 'Atalhos',
      navSettings: 'Configurações',
      tabDiscover: 'Descobrir',
      tabBrowse: 'Navegar',
      tabSaved: 'Salvos',
      tabCommunity: 'Comunidade',
      quickBrowse: 'Navegar',
      quickDesigner: 'Criador',
      shareCrosshair: 'Compartilhar',
      importCrosshair: 'Importar',
      shareModalTitle: 'Compartilhar Mira',
      shareModalDesc: 'Copie o código versionado da sua mira ou salve em arquivo JSON.',
      btnCopyShareCode: 'Copiar Código',
      btnExportShareFile: 'Salvar JSON',
      importModalTitle: 'Importar Mira',
      importModalDesc: 'Cole o código da mira (CQ1:...) ou escolha um arquivo .json.',
      btnApplyImportCode: 'Aplicar Código',
      btnImportFileSelect: 'Arquivo JSON...',
      renameModalTitle: 'Renomear Mira',
      btnCancel: 'Cancelar',
      btnSave: 'Salvar',
      profilesModalTitle: 'Perfis',
      tabCurrent: 'Atual',
      tabProfiles: 'Perfis',
      openDesigner: 'Abrir Criador',
      manageProfiles: 'Gerenciar perfis',
      createProfile: 'Criar',
      placeholderNewProfile: 'Nome do novo perfil',
      placeholderRename: 'Nome da mira',
      renameProfileModalTitle: 'Renomear Perfil',
      placeholderRenameProfile: 'Nome do perfil',
      captureForeground: 'Capturar',
      saveAssociation: 'Salvar associação',
      refreshStatus: 'Atualizar status',
      lblLanguage: 'Idioma',
      descLanguage: 'Escolha seu idioma preferido',
      lblSounds: 'Sons da Interface',
      descSounds: 'Efeitos sonoros sutis em cliques e ações na interface.',
      lblOnlyInGame: 'Mostrar Apenas no Jogo',
      descOnlyInGame: 'Exibir a mira apenas quando um jogo for detectado como a janela ativa.',
      statusOnlyInGameActive: 'Jogo em foco detectado: a mira está ativa.',
      statusOnlyInGameWaiting: 'Aguardando jogo em foco; mira oculta na área de trabalho.',
      statusOnlyInGameDisabled: 'Mira visível em todas as janelas.',
      statusOnlyInGameHidden: 'Mira oculta nas configurações.',
      tabOptGeneral: 'Geral',
      tabOptDisplay: 'Modos de Exibição',
      tabOptStream: 'Gravação / Streaming',
      close: 'Fechar',
      emptySaved: 'Nenhuma mira salva ainda. Use o marcador em um cartão para salvar.',
      codeCopied: 'Código copiado.',
      fileExported: 'Arquivo exportado.',
      importSuccess: 'Mira importada com sucesso.',
      resetDefaults: 'Restaurar padrões',
      kbGlobalToggle: 'Alternar Global',
      kbAim: 'Mirar',
      kbFire: 'Atirar',
      kbReload: 'Recarregar',
      kbOff: 'DESLIGADO',
      kbOn: 'LIGADO',
      kbUnassigned: 'Não atribuído',
      kbAimHold: 'Ocultar Mira (Segurar)',
      kbAimToggle: 'Alternar Mira',
      kbAimOff: 'Desligado',
    },
    'en-US': {
      navCrosshairs: 'Crosshairs',
      navDesigner: 'Creator',
      navPositions: 'Positions',
      navKeybinds: 'Keybinds',
      navSettings: 'Settings',
      tabDiscover: 'Discover',
      tabBrowse: 'Browse',
      tabSaved: 'Saved',
      tabCommunity: 'Community',
      quickBrowse: 'Browse',
      quickDesigner: 'Creator',
      shareCrosshair: 'Share',
      importCrosshair: 'Import',
      shareModalTitle: 'Share Crosshair',
      shareModalDesc: 'Copy the versioned crosshair code or save to a JSON file.',
      btnCopyShareCode: 'Copy Code',
      btnExportShareFile: 'Save JSON',
      importModalTitle: 'Import Crosshair',
      importModalDesc: 'Paste the crosshair code (CQ1:...) or choose a .json file.',
      btnApplyImportCode: 'Apply Code',
      btnImportFileSelect: 'JSON File...',
      renameModalTitle: 'Rename Crosshair',
      btnCancel: 'Cancel',
      btnSave: 'Save',
      profilesModalTitle: 'Profiles',
      tabCurrent: 'Current',
      tabProfiles: 'Profiles',
      openDesigner: 'Open Creator',
      manageProfiles: 'Manage Profiles',
      createProfile: 'Create',
      placeholderNewProfile: 'New profile name',
      placeholderRename: 'Crosshair name',
      renameProfileModalTitle: 'Rename Profile',
      placeholderRenameProfile: 'Profile name',
      captureForeground: 'Capture',
      saveAssociation: 'Save association',
      refreshStatus: 'Refresh status',
      lblLanguage: 'Language',
      descLanguage: 'Choose your preferred language',
      lblSounds: 'Interface Sounds',
      descSounds: 'Subtle sound effects for clicks and interface actions.',
      lblOnlyInGame: 'Show Only In-Game',
      descOnlyInGame: 'Display crosshair only when a game is detected as active window.',
      statusOnlyInGameActive: 'Foreground game detected: crosshair active.',
      statusOnlyInGameWaiting: 'Waiting for foreground game; crosshair hidden on desktop.',
      statusOnlyInGameDisabled: 'Crosshair visible in all windows.',
      statusOnlyInGameHidden: 'Crosshair hidden in settings.',
      tabOptGeneral: 'General',
      tabOptDisplay: 'Display Modes',
      tabOptStream: 'Recording / Streaming',
      close: 'Close',
      emptySaved: 'No saved crosshairs yet. Click the bookmark on any card to save.',
      codeCopied: 'Code copied.',
      fileExported: 'File exported.',
      importSuccess: 'Crosshair imported successfully.',
      resetDefaults: 'Restore defaults',
      kbGlobalToggle: 'Toggle Global',
      kbAim: 'Aim',
      kbFire: 'Fire',
      kbReload: 'Reload',
      kbOff: 'OFF',
      kbOn: 'ON',
      kbUnassigned: 'Unassigned',
      kbAimHold: 'Hide Crosshair (Hold)',
      kbAimToggle: 'Toggle Crosshair',
      kbAimOff: 'Off',
    }
  };
  let currentLang = 'pt-BR';
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('cq.language');
      if (stored) {
        try { currentLang = JSON.parse(stored); } catch { currentLang = stored; }
      }
    }
  } catch {}
  if (!I18N[currentLang]) currentLang = 'pt-BR';

  function applyLanguage(lang) {
    if (!I18N[lang]) lang = 'pt-BR';
    currentLang = lang;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('cq.language', lang);
    } catch {}
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
    }
    const dict = I18N[lang];
    if ($('optionLanguage')) $('optionLanguage').value = lang;

    const q = (sel) => (typeof document !== 'undefined' && typeof document.querySelector === 'function') ? document.querySelector(sel) : null;

    const navCrosshairs = q('[data-route="crosshairs"] span');
    if (navCrosshairs) navCrosshairs.textContent = dict.navCrosshairs;
    const navDesigner = q('[data-route="designer"] span');
    if (navDesigner) navDesigner.textContent = dict.navDesigner;
    const navPositions = q('[data-route="positions"] span');
    if (navPositions) navPositions.textContent = dict.navPositions;
    const navKeybinds = q('[data-route="keybinds"] span');
    if (navKeybinds) navKeybinds.textContent = dict.navKeybinds;
    const navSettings = q('[data-route="startup"] span');
    if (navSettings) navSettings.textContent = dict.navSettings;

    const updateTabLabel = (sel, text) => {
      const el = q(sel);
      if (!el) return;
      const sp = el.querySelector ? el.querySelector('.xtab-label') : null;
      if (sp) sp.textContent = text;
      else el.textContent = text;
    };
    updateTabLabel('[data-xtab="descobrir"]', dict.tabDiscover);
    updateTabLabel('[data-xtab="navegar"]', dict.tabBrowse);
    updateTabLabel('[data-xtab="salvos"]', dict.tabSaved);
    updateTabLabel('[data-xtab="workshop"]', dict.tabCommunity);

    const updateOptTab = (id, text) => {
      const el = $(id);
      if (!el) return;
      const sp = el.querySelector ? el.querySelector('.opt-tab-label') : null;
      if (sp) sp.textContent = text;
      else el.textContent = text;
    };
    updateOptTab('optTabGeral', dict.tabOptGeneral);
    updateOptTab('optTabDisplay', dict.tabOptDisplay);
    updateOptTab('optTabStream', dict.tabOptStream);

    const btnQuickNavegar = $('btnQuickNavegar');
    if (btnQuickNavegar && typeof btnQuickNavegar.querySelector === 'function') {
      const sp = btnQuickNavegar.querySelector('span');
      if (sp) sp.textContent = dict.quickBrowse;
    }
    const btnQuickCriador = $('btnQuickCriador');
    if (btnQuickCriador && typeof btnQuickCriador.querySelector === 'function') {
      const sp = btnQuickCriador.querySelector('span');
      if (sp) sp.textContent = dict.quickDesigner;
    }
    const btnShare = $('btnShare');
    if (btnShare && typeof btnShare.querySelector === 'function') {
      const sp = btnShare.querySelector('span');
      if (sp) sp.textContent = dict.shareCrosshair;
    }
    const btnImport = $('btnImport');
    if (btnImport && typeof btnImport.querySelector === 'function') {
      const sp = btnImport.querySelector('span');
      if (sp) sp.textContent = dict.importCrosshair;
    }

    if ($('shareModalTitle')) $('shareModalTitle').textContent = dict.shareModalTitle;
    if ($('shareModalDesc')) $('shareModalDesc').textContent = dict.shareModalDesc;
    if ($('btnCopyShareText')) $('btnCopyShareText').textContent = dict.btnCopyShareCode;
    if ($('btnExportShareText')) $('btnExportShareText').textContent = dict.btnExportShareFile;
    if ($('importModalTitle')) $('importModalTitle').textContent = dict.importModalTitle;
    if ($('importModalDesc')) $('importModalDesc').textContent = dict.importModalDesc;
    if ($('btnApplyImportCode')) $('btnApplyImportCode').textContent = dict.btnApplyImportCode;
    if ($('btnImportFileSelect')) $('btnImportFileSelect').textContent = dict.btnImportFileSelect;
    if ($('renameModalTitle')) $('renameModalTitle').textContent = dict.renameModalTitle;
    if ($('btnRenameCancel')) $('btnRenameCancel').textContent = dict.btnCancel;
    if ($('btnRenameSave')) $('btnRenameSave').textContent = dict.btnSave;
    if ($('renameInput')) $('renameInput').placeholder = dict.placeholderRename;

    if ($('profileModalClose')) $('profileModalClose').setAttribute('aria-label', dict.close);
    if ($('renameModalClose')) $('renameModalClose').setAttribute('aria-label', dict.close);
    if ($('shareModalClose')) $('shareModalClose').setAttribute('aria-label', dict.close);
    if ($('importModalClose')) $('importModalClose').setAttribute('aria-label', dict.close);

    if ($('profileModalTitle')) $('profileModalTitle').textContent = dict.profilesModalTitle;
    if ($('tabConfig')) $('tabConfig').textContent = dict.tabCurrent;
    if ($('tabPerfis')) $('tabPerfis').textContent = dict.tabProfiles;
    if ($('openDesigner')) $('openDesigner').textContent = dict.openDesigner;
    if ($('btnHomePerfis')) $('btnHomePerfis').textContent = dict.manageProfiles;
    if ($('btnNewProfile')) $('btnNewProfile').textContent = dict.createProfile;
    if ($('profileName')) $('profileName').placeholder = dict.placeholderNewProfile;
    if ($('btnCaptureForeground')) $('btnCaptureForeground').textContent = dict.captureForeground;
    if ($('btnSaveProfile')) $('btnSaveProfile').textContent = dict.saveAssociation;
    if ($('btnNativeStatus')) $('btnNativeStatus').textContent = dict.refreshStatus;

    if ($('lblOptLanguage')) $('lblOptLanguage').textContent = dict.lblLanguage;
    if ($('descOptLanguage')) $('descOptLanguage').textContent = dict.descLanguage;
    if ($('lblOptSounds')) $('lblOptSounds').textContent = dict.lblSounds;
    if ($('descOptSounds')) $('descOptSounds').textContent = dict.descSounds;
    if ($('lblOnlyInGame')) $('lblOnlyInGame').textContent = dict.lblOnlyInGame;
    if ($('descOnlyInGame')) $('descOnlyInGame').textContent = dict.descOnlyInGame;
    if ($('btnResetSettings')) $('btnResetSettings').textContent = dict.resetDefaults;
    if ($('savedEmpty')) $('savedEmpty').textContent = dict.emptySaved;

    if (state) applyToDom(state);
    renderKeybinds();
  }

  const ACCENT = '#2F6BFF';
  function previewColor(value, fallback) {
    return typeof value === 'string' && /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d.,%+\-\s]+\))$/i.test(value) ? escapeHtml(value) : fallback;
  }
  let layersApi;
  function loadLayersApi() {
    if (window.CQLayers) return Promise.resolve(window.CQLayers);
    if (!layersApi) layersApi = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '../shared/layers.js';
      script.onload = () => resolve(window.CQLayers);
      script.onerror = () => { layersApi = null; reject(new Error('validador indisponível')); };
      document.head.appendChild(script);
    });
    return layersApi;
  }
  function modelSvg(model, scale) {
    const m = model || {};
    const mm = {
      gap: Number(m.gap ?? 4), armLen: Number(m.armLen ?? 8), armThick: Number(m.armThick ?? 2),
      rotation: Number(m.rotation ?? 0), color: previewColor(m.color, '#ffffff'),
      dot: { enabled: m.dot ? m.dot.enabled !== false : true, size: Number(m.dot?.size ?? 2), shape: m.dot?.shape === 'square' ? 'square' : 'circle' },
      outline: { enabled: m.outline?.enabled === true, width: Number(m.outline?.width ?? 1), color: previewColor(m.outline?.color, '#000000') },
    };
    const s = Number(scale) || 7;
    if (typeof CQGeometry !== 'undefined') {
      const spec = CQGeometry.buildSpec(mm, s);
      const extent = Math.max(18, (mm.gap + mm.armLen) * s + 24);
      const stroke = mm.outline.enabled ? ` stroke="${mm.outline.color}" stroke-width="${mm.outline.width}"` : '';
      const opacity = m.opacity === undefined ? 1 : Number(m.opacity);
      let svg = `<svg viewBox="${-extent} ${-extent} ${extent * 2} ${extent * 2}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g opacity="${opacity}">`;
      for (const a of spec.arms) {
        if (a.w <= 0 || a.h <= 0) continue;
        svg += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${mm.color}" transform="rotate(${a.rot} ${a.x + a.w / 2} ${a.y + a.h / 2})"${stroke}/>`;
      }
      if (spec.dot) {
        svg += spec.dot.shape === 'rect'
          ? `<rect x="${-spec.dot.r}" y="${-spec.dot.r}" width="${spec.dot.r * 2}" height="${spec.dot.r * 2}" fill="${mm.color}"${stroke}/>`
          : `<circle cx="0" cy="0" r="${spec.dot.r}" fill="${mm.color}"${stroke}/>`;
      }
      return svg + '</g></svg>';
    }
    const extent = Math.max(18, (mm.gap + mm.armLen) * s + 24);
    const color = mm.color;
    const stroke = mm.outline.enabled ? `stroke="${mm.outline.color}" stroke-width="${mm.outline.width}"` : '';
    const opacity = m.opacity === undefined ? 1 : Number(m.opacity);
    const arm = mm.armLen * s;
    const thick = Math.max(1, mm.armThick * s / 2);
    const gap = mm.gap * s;
    const dotR = mm.dot.enabled ? Math.max(1, mm.dot.size * s / 2) : 0;
    const rotAttr = mm.rotation ? ` transform="rotate(${mm.rotation})"` : '';
    let svg = `<svg viewBox="${-extent} ${-extent} ${extent * 2} ${extent * 2}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g opacity="${opacity}"${rotAttr}>`;
    const drawArm = (x, y, w, h, rot) => {
      svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" ${stroke} transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"/>`;
    };
    if (mm.armLen > 0) {
      drawArm(gap, -thick / 2, arm, thick, 0);
      drawArm(-gap - arm, -thick / 2, arm, thick, 0);
      drawArm(-thick / 2, gap, thick, arm, 0);
      drawArm(-thick / 2, -gap - arm, thick, arm, 0);
    }
    if (dotR) svg += `<circle cx="0" cy="0" r="${dotR}" fill="${color}" ${stroke}/>`;
    return svg + '</g></svg>';
  }
  function crosshairSvg(payload, scale) {
    const layers = payload?.layers;
    const hasLayers = Array.isArray(layers) && (layers.length > 0 || payload?.drawing != null);
    const hasEmptyDrawing = Array.isArray(layers) && layers.length === 0 && payload?.drawing != null;

    if (hasLayers) {
      if (layers.length === 0) return '';
      const L = (typeof window !== 'undefined' && window.CQLayers) || (typeof globalThis !== 'undefined' && globalThis.CQLayers);
      if (!L || typeof L.renderLayers !== 'function') return '';
      try {
        const body = L.renderLayers(layers);
        if (!body) return '';
        // ponytail: viewBox fixo do contrato overlay (-128..128 unidades). Geometria
        // fora desse teto é recortada, igual à sobreposição; auto-fit de documento
        // arbitrário não é prometido. Se a biblioteca crescer teto dinâmico, trocar aqui.
        return `<svg viewBox="-128 -128 256 256" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>`;
      } catch (error) {
        console.error('[crosshair preview]', error);
        return '';
      }
    }

    if (hasEmptyDrawing) return '';

    const model = payload?.model ?? (payload && !Array.isArray(payload.layers) ? payload : null);
    if (!model || (typeof model === 'object' && !['gap', 'armLen', 'armThick', 'color', 'dot', 'outline'].some(k => Object.hasOwn(model, k)))) {
      return '';
    }
    const L2 = (typeof window !== 'undefined' && window.CQLayers) || (typeof globalThis !== 'undefined' && globalThis.CQLayers);
    if (L2 && typeof L2.crosshairLayers === 'function' && typeof L2.renderLayers === 'function') {
      try {
        const cLayers = L2.crosshairLayers(model);
        if (cLayers && cLayers.length > 0) {
          const body = L2.renderLayers(cLayers);
          if (body) {
            return `<svg viewBox="-128 -128 256 256" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>`;
          }
        }
      } catch { /* fallback to modelSvg */ }
    }
    return modelSvg(model, scale);
  }
  let paintIdCounter = 0;

  function measurePaintBounds(svg) {
    if (!svg || typeof svg.querySelector !== 'function') return null;
    try {
      const target = svg.querySelector('g') || svg;
      if (typeof target.getBBox === 'function') {
        let bbox;
        try {
          bbox = target.getBBox({ stroke: true });
        } catch {
          bbox = target.getBBox();
        }
        if (bbox && (bbox.width > 0 || bbox.height > 0)) {
          let maxStroke = 0;
          const stroked = typeof svg.querySelectorAll === 'function' ? svg.querySelectorAll('[stroke]') : [];
          for (const el of stroked) {
            const sw = parseFloat(el.getAttribute?.('stroke-width') || '1');
            if (sw > maxStroke) maxStroke = sw;
          }
          const pad = maxStroke / 2;
          return {
            x: bbox.x - pad,
            y: bbox.y - pad,
            width: bbox.width + pad * 2,
            height: bbox.height + pad * 2,
          };
        }
      }
    } catch {}
    return null;
  }

  function autoFitThumbnail(host) {
    if (!host || typeof host.querySelector !== 'function' || typeof document === 'undefined') return;
    const svg = host.querySelector('svg');
    if (!svg || typeof svg.setAttribute !== 'function') return;
    const currentId = ++paintIdCounter;
    host._paintId = currentId;

    const applyFit = () => {
      if (host._paintId !== currentId) return;
      const bounds = measurePaintBounds(svg);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const side = Math.max(bounds.width, bounds.height, 6);
      const padding = Math.max(1, side / 8);
      const size = side + padding * 2;
      const vx = bounds.x + bounds.width / 2 - size / 2;
      const vy = bounds.y + bounds.height / 2 - size / 2;
      svg.setAttribute('viewBox', `${vx.toFixed(2)} ${vy.toFixed(2)} ${size.toFixed(2)} ${size.toFixed(2)}`);
    };

    applyFit();

    const hasText = typeof svg.querySelector === 'function' && svg.querySelector('text') != null;
    const images = typeof svg.querySelectorAll === 'function' ? [...svg.querySelectorAll('image')] : [];
    if (hasText || images.length > 0) {
      const waitables = [];
      if (hasText && typeof document.fonts?.ready?.then === 'function') {
        waitables.push(document.fonts.ready);
      }
      for (const img of images) {
        if (typeof img.decode === 'function') {
          waitables.push(img.decode().catch(() => {}));
        }
      }
      if (waitables.length > 0) {
        Promise.all(waitables).then(() => {
          if (host._paintId === currentId) applyFit();
        }).catch(() => {});
      }
    }
  }

  function paint(host, payload, scale, autoFit = false) {
    if (!host) return;
    host.innerHTML = crosshairSvg(payload, scale || 7);
    if (autoFit) autoFitThumbnail(host);
  }

  function fillRange(el, value, min, max) {
    if (!el) return;
    const mn = min !== undefined ? min : Number(el.min ?? 0);
    const mx = max !== undefined ? max : Number(el.max ?? 100);
    const pct = Math.max(0, Math.min(100, ((Number(value) - mn) / (mx - mn)) * 100));
    if (el.style && typeof el.style.setProperty === 'function') el.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  const SAVED_IDS = 'cq.savedCrosshairs';
  const SAVED_CUSTOM = 'cq.savedCustomCrosshairs';
  const POSITIONS = 'cq.savedPositions';
  const POS_PREFS = 'cq.positionPrefs';
  const CUSTOM_KEYBINDS = 'cq.customKeybinds';

  const savedIds = () => loadJson(SAVED_IDS, []).filter(id => typeof id === 'string');

  function sanitizeCustomEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return {
      ...raw,
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 100) : 'custom-' + Math.random().toString(36).slice(2, 9),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : 'Mira',
      creator: typeof raw.creator === 'string' ? raw.creator.slice(0, 120) : 'Comunidade',
      model: raw.model && typeof raw.model === 'object' ? raw.model : {},
      layers: Array.isArray(raw.layers) ? raw.layers : [],
      drawing: raw.drawing ?? null,
    };
  }

  const savedCustom = () => loadJson(SAVED_CUSTOM, []).map(sanitizeCustomEntry).filter(Boolean);
  function isSaved(id) { return savedIds().includes(id); }
  function savedItems() { return SAMPLES_saved_source().filter((s) => isSaved(s.id)).concat(savedCustom().map((c) => ({ ...c, custom: true }))); }
  function allCrosshairIds() { return new Set(SAMPLES.map((s) => s.id).concat(savedIds(), savedCustom().map((c) => c.id))); }
  function uniqueCrosshairId(prefix) {
    const taken = allCrosshairIds();
    let n = Date.now().toString(36);
    while (taken.has(`${prefix}-${n}`)) n = (parseInt(n, 36) + 1).toString(36);
    return `${prefix}-${n}`;
  }

  // SAMPLES live here because ui.js owns the catalog identifiers.
  const SAMPLES = [
    { id: 'sample-classic', name: 'Cruz clássica', creator: 'Equipe Q', model: { gap: 5, armLen: 8, armThick: 2, rotation: 0, color: '#ffffff', opacity: 1, dot: { enabled: true, size: 2, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-dot', name: 'Ponto verde', creator: 'Comunidade Q', model: { gap: 0, armLen: 0, armThick: 2, rotation: 0, color: '#2fc787', opacity: 1, dot: { enabled: true, size: 5, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-sniper', name: 'Sniper fina', creator: 'Comunidade Q', model: { gap: 3, armLen: 14, armThick: 1, rotation: 0, color: '#e9e9e9', opacity: 1, dot: { enabled: true, size: 1, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-long', name: 'Traço longo', creator: 'Equipe Q', model: { gap: 4, armLen: 18, armThick: 2, rotation: 0, color: '#67c1f5', opacity: 1, dot: { enabled: false, size: 2, shape: 'circle' }, outline: { enabled: false, width: 1, color: '#000000' } } },
    { id: 'sample-compact', name: 'Compacta', creator: 'Comunidade Q', model: { gap: 2, armLen: 3, armThick: 3, rotation: 0, color: '#ffffff', opacity: 1, dot: { enabled: true, size: 3, shape: 'square' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-wide', name: 'Vão aberto', creator: 'Comunidade Q', model: { gap: 12, armLen: 6, armThick: 2, rotation: 0, color: '#f5d020', opacity: 1, dot: { enabled: true, size: 2, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-x', name: 'Diagonal', creator: 'Equipe Q', model: { gap: 6, armLen: 8, armThick: 2, rotation: 45, color: '#d8b4fe', opacity: 1, dot: { enabled: true, size: 2, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
    { id: 'sample-orange', name: 'Laranja curta', creator: 'Comunidade Q', model: { gap: 4, armLen: 5, armThick: 2, rotation: 0, color: '#ff8000', opacity: 1, dot: { enabled: true, size: 2, shape: 'circle' }, outline: { enabled: true, width: 1, color: '#000000' } } },
  ];
  function SAMPLES_saved_source() { return SAMPLES; }

  // ---------- Store -> DOM ----------
  function applyToDom(s) {
    state = s || {};
    const m = currentModel();
    if ($('visible')) $('visible').checked = !!s.visible;
    if ($('limitSize')) $('limitSize').checked = !!s.limitSize;
    if ($('showSecondary')) $('showSecondary').checked = !!s.showSecondary;
    if ($('profileDetectionEnabled')) $('profileDetectionEnabled').checked = s.profileDetectionEnabled !== false;

    const optTray = $('optionMinimizeToTray');
    const statusTray = $('trayStatus');
    const minimizeToTray = s.minimizeToTray !== false;
    const trayAvail = s.trayStatus ? s.trayStatus.available !== false : true;
    if (optTray) {
      optTray.checked = minimizeToTray;
      optTray.disabled = !trayAvail;
    }
    if (statusTray) {
      if (s.trayStatus && s.trayStatus.available === false) {
        statusTray.textContent = `Bandeja do sistema indisponível. ${s.trayStatus.error || 'A janela minimizará para a barra de tarefas.'}`;
      } else if (!minimizeToTray) {
        statusTray.textContent = 'Minimizar para a barra de tarefas.';
      } else {
        statusTray.textContent = 'Minimizar para a área de notificação (bandeja).';
      }
    }

    if ($('color')) $('color').value = m.color || '#ffffff';
    if ($('armLen')) { $('armLen').value = m.armLen ?? 8; $('armLenV').textContent = m.armLen ?? 8; fillRange($('armLen'), m.armLen ?? 8, 0, 40); }
    if ($('armThick')) { $('armThick').value = m.armThick ?? 2; $('armThickV').textContent = m.armThick ?? 2; fillRange($('armThick'), m.armThick ?? 2, 1, 20); }
    if ($('gap')) { $('gap').value = m.gap ?? 4; $('gapV').textContent = m.gap ?? 4; fillRange($('gap'), m.gap ?? 4, 0, 30); }
    if ($('rotation')) { $('rotation').value = m.rotation ?? 0; $('rotationV').textContent = m.rotation ?? 0; fillRange($('rotation'), m.rotation ?? 0, 0, 90); }
    if ($('dotEnabled')) $('dotEnabled').checked = !!m.dot?.enabled;
    if ($('dotSize')) { $('dotSize').value = m.dot?.size ?? 2; $('dotSizeV').textContent = m.dot?.size ?? 2; fillRange($('dotSize'), m.dot?.size ?? 2, 0, 20); }
    if ($('dotShape')) $('dotShape').value = m.dot?.shape === 'square' ? 'square' : 'circle';
    const ol = m.outline || {};
    if ($('outlineEnabled')) $('outlineEnabled').checked = ol.enabled === true;
    if ($('outlineWidth')) { $('outlineWidth').value = ol.width ?? 1; $('outlineWidthV').textContent = ol.width ?? 1; fillRange($('outlineWidth'), ol.width ?? 1, 0, 6); }
    if ($('outlineColor')) $('outlineColor').value = ol.color || '#000000';

    const scale = s.scale ?? 1;
    if ($('scale')) $('scale').value = scale;
    if ($('scaleRange')) { $('scaleRange').value = scale; fillRange($('scaleRange'), scale, 0.01, 10); }
    const ox = s.offsetX ?? 0;
    const oy = s.offsetY ?? 0;
    if ($('offsetX')) $('offsetX').value = ox;
    if ($('offsetXRange')) { $('offsetXRange').value = ox; fillRange($('offsetXRange'), ox, -2000, 2000); }
    if ($('offsetY')) $('offsetY').value = oy;
    if ($('offsetYRange')) { $('offsetYRange').value = oy; fillRange($('offsetYRange'), oy, -2000, 2000); }

    if ($('optionOnlyInGame')) $('optionOnlyInGame').checked = s.onlyInGame === true;
    if ($('onlyInGameProcessPath') && document.activeElement !== $('onlyInGameProcessPath')) {
      $('onlyInGameProcessPath').value = s.onlyInGameProcessPath || '';
    }
    if ($('optionStartMinimized')) $('optionStartMinimized').checked = s.startMinimized === true;
    const onlyInGameEl = $('onlyInGameStatus');
    if (onlyInGameEl) {
      const isHidden = s.hidden === true || s.visible === false;
      if (isHidden) {
        onlyInGameEl.textContent = I18N[currentLang]?.statusOnlyInGameHidden || 'Mira oculta nas configurações.';
      } else if (s.onlyInGame) {
        if (s.gameInFocus === true) {
          onlyInGameEl.textContent = I18N[currentLang]?.statusOnlyInGameActive || 'Jogo em foco detectado: a mira está ativa.';
        } else {
          onlyInGameEl.textContent = I18N[currentLang]?.statusOnlyInGameWaiting || 'Aguardando jogo em foco; mira oculta na área de trabalho.';
        }
      } else {
        onlyInGameEl.textContent = I18N[currentLang]?.statusOnlyInGameDisabled || 'Mira visível em todas as janelas.';
      }
    }
    if ($('optionCrosshairSizeV')) $('optionCrosshairSizeV').textContent = Number(s.crosshairSize ?? 1).toFixed(1);
    const co = s.crosshairOffset || { x: 0, y: 0 };
    if ($('optionOffsetXV')) $('optionOffsetXV').textContent = co.x ?? 0;
    if ($('optionOffsetYV')) $('optionOffsetYV').textContent = co.y ?? 0;

    updateHome();
    renderSaved();
  }

  function profileLabel(p, fallback = 'Padrão') {
    if (!p) return fallback;
    if (p.id === 'default' && (!p.name || p.name === 'default')) return 'Padrão';
    return p.name || p.id || fallback;
  }

  // ---------- Library ----------
  function toggleSaved(id) {
    const ids = savedIds();
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat(id);
    if (!saveJson(SAVED_IDS, next)) { if (!corruptStorageKeys.has(SAVED_IDS)) toast('Não foi possível atualizar favoritos: armazenamento local indisponível.'); return; }
    renderLibrary();
    toast(next.includes(id) ? 'Mira salva nos favoritos.' : 'Mira removida dos favoritos.');
  }
  function toggleCustomSaved(id, name) {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const msg = name ? `Deseja realmente excluir a mira "${name}"?` : 'Deseja realmente excluir esta mira dos salvos?';
      if (!window.confirm(msg)) return;
    }
    if (!saveJson(SAVED_CUSTOM, savedCustom().filter((c) => c.id !== id))) { if (!corruptStorageKeys.has(SAVED_CUSTOM)) toast('Não foi possível remover favorito: armazenamento local indisponível.'); return; }
    renderLibrary();
    toast('Mira removida dos favoritos.');
  }
  function applyCrosshairItem(item) {
    const L = (typeof window !== 'undefined' && window.CQLayers) || (typeof globalThis !== 'undefined' && globalThis.CQLayers);
    const layers = Array.isArray(item.layers) ? item.layers : [];
    const drawing = layers.length && L ? L.renderLayers(layers) : (item.custom ? item.drawing ?? null : null);
    set({ model: item.model || {}, drawing, layers });
    playSfx('click');
    toast(`Mira aplicada: ${item.name}`);
  }
  function renderModCard(item) {
    const card = document.createElement('div');
    card.className = 'mod-card';
    card.title = `${item.name} — ${item.creator || 'OpenCrosshairQ'}`;
    const media = document.createElement('div');
    media.className = 'mod-card-media';
    media.innerHTML = `<div class="mod-card-preview">${crosshairSvg(item, 5.5)}</div>`;
    autoFitThumbnail(media);
    media.addEventListener('click', () => {
      applyCrosshairItem(item);
    });
    const save = document.createElement('button');
    save.className = 'mod-card-save' + (item.custom ? '' : (isSaved(item.id) ? ' on' : ''));
    save.title = item.custom ? 'Remover dos favoritos' : 'Salvar nos favoritos';
    save.setAttribute('aria-label', save.title);
    save.innerHTML = '<svg class="ico"><use href="#i-bookmark"/></svg>';
    save.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      playSfx('toggle');
      if (item.custom) toggleCustomSaved(item.id, item.name); else toggleSaved(item.id);
    });
    // ponytail: duplicate button inside media keeps compatibility with ui.test.mjs
    if (item.custom) {
      const dup = document.createElement('button');
      dup.className = 'mod-card-save';
      dup.title = 'Duplicar mira salva';
      dup.setAttribute('aria-label', dup.title);
      dup.style.left = '7px';
      dup.style.right = 'auto';
      dup.innerHTML = '<svg class="ico"><use href="#i-plus"/></svg>';
      dup.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        const copy = { ...item, id: uniqueCrosshairId('custom'), name: `${item.name} (cópia)` };
        if (!saveJson(SAVED_CUSTOM, savedCustom().concat(copy))) { if (!corruptStorageKeys.has(SAVED_CUSTOM)) toast('Não foi possível duplicar: armazenamento local indisponível.'); return; }
        renderLibrary();
        playSfx('click');
        toast('Mira duplicada nos favoritos.');
      });
      media.appendChild(dup);
    }
    media.appendChild(save);

    const strip = document.createElement('div');
    strip.className = 'mod-card-strip';
    strip.innerHTML = `<svg class="ico"><use href="#i-chat"/></svg><span class="mod-card-name">${escapeHtml(item.name)}</span>`;

    const actions = document.createElement('div');
    actions.className = 'mod-card-actions';

    const btnApply = document.createElement('button');
    btnApply.type = 'button';
    btnApply.className = 'icon-btn';
    btnApply.title = 'Aplicar mira';
    btnApply.setAttribute('aria-label', 'Aplicar mira');
    btnApply.innerHTML = '<svg class="ico"><use href="#i-play"/></svg>';
    btnApply.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      applyCrosshairItem(item);
    });

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'icon-btn';
    btnEdit.title = 'Editar no Criador';
    btnEdit.setAttribute('aria-label', 'Editar no Criador');
    btnEdit.innerHTML = '<svg class="ico"><use href="#i-edit"/></svg>';
    btnEdit.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      applyCrosshairItem(item);
      showPage('designer');
    });

    const btnShare = document.createElement('button');
    btnShare.type = 'button';
    btnShare.className = 'icon-btn';
    btnShare.title = 'Compartilhar mira';
    btnShare.setAttribute('aria-label', 'Compartilhar mira');
    btnShare.innerHTML = '<svg class="ico"><use href="#i-share"/></svg>';
    btnShare.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      openShareModal(item);
    });

    actions.append(btnApply, btnEdit, btnShare);

    if (item.custom) {
      const btnRename = document.createElement('button');
      btnRename.type = 'button';
      btnRename.className = 'icon-btn';
      btnRename.title = 'Renomear mira';
      btnRename.setAttribute('aria-label', 'Renomear mira');
      btnRename.innerHTML = '<svg class="ico"><use href="#i-chat"/></svg>';
      btnRename.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        openRenameModal(item);
      });

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'icon-btn danger';
      btnDelete.title = 'Excluir mira';
      btnDelete.setAttribute('aria-label', 'Excluir mira');
      btnDelete.innerHTML = '<svg class="ico"><use href="#i-x"/></svg>';
      btnDelete.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        toggleCustomSaved(item.id, item.name);
      });

      actions.append(btnRename, btnDelete);
    }

    card.append(media, strip, actions);
    return card;
  }
  function paintGrid(host, items) {
    if (!host) return;
    host.innerHTML = '';
    for (const item of items) host.appendChild(renderModCard(item));
  }
  function renderSaved() {
    const host = $('savedGrid');
    const empty = $('savedEmpty');
    const count = $('savedCount');
    if (!host) return;
    const items = savedItems();
    paintGrid(host, items);
    if (empty) empty.hidden = items.length > 0;
    if (count) count.textContent = items.length ? String(items.length) : '';
  }
  function renderLibrary() {
    if ($('creatorCards')) paintGrid($('creatorCards'), SAMPLES.slice(0, 2));
    if ($('browseGrid')) paintGrid($('browseGrid'), SAMPLES);
    if ($('navegarGrid')) paintGrid($('navegarGrid'), SAMPLES.slice().reverse());
    renderSaved();
  }

  const SLIDES = [
    { title: 'Bem-vindo ao OpenCrosshairQ', text: 'Biblioteca local, edição por camadas e favoritos no seu computador.' },
    { title: 'Crie a mira do seu jeito', text: 'Abra o Criador e combine camadas, formas, texto e imagens.' },
    { title: 'Ajuste fino de posição', text: 'Centralize a mira e salve ajustes na página Posições.' },
    { title: 'Seus atalhos, do seu jeito', text: 'Consulte as teclas registradas em Atalhos de Teclas.' },
    { title: 'Leve e fora do caminho', text: 'Uma sobreposição por janela, sem injeção no processo do jogo.' },
  ];
  let slideIndex = 0;
  function setSlide(i) {
    slideIndex = ((i % SLIDES.length) + SLIDES.length) % SLIDES.length;
    const s = SLIDES[slideIndex];
    if ($('xHeroTitle')) $('xHeroTitle').textContent = s.title;
    if ($('xHeroText')) $('xHeroText').textContent = s.text;
    for (const dot of document.querySelectorAll('#xHeroDots .x-dot')) {
      const on = Number(dot.dataset.slide) === slideIndex;
      dot.classList[on ? 'add' : 'remove']('active');
    }
  }

  const X_PANELS = { descobrir: 'xPanelDescobrir', navegar: 'xPanelNavegar', salvos: 'xPanelSalvos', workshop: 'xPanelWorkshop' };
  function switchXTab(name) {
    if (!X_PANELS[name]) name = 'descobrir';
    currentXTab = name;
    for (const key of Object.keys(X_PANELS)) {
      const panel = $(X_PANELS[key]);
      if (panel) panel.hidden = key !== name;
    }
    for (const b of document.querySelectorAll('[data-xtab]')) {
      const on = b.dataset.xtab === name;
      b.classList[on ? 'add' : 'remove']('active');
    }
    if (name === 'salvos') renderSaved();
  }
  for (const b of document.querySelectorAll('[data-xtab]')) b.addEventListener('click', () => switchXTab(b.dataset.xtab));

  // ---------- Designer iframe ----------
  let designerFrame = null;
  function bootDesignerFrame(iframe) {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body || doc.getElementById('designerBridgeScript')) return;
    const win = iframe.contentWindow;
    if (win && !win.cq) {
      win.cq = {
        getState: () => window.cq.getState(),
        getDisplays: () => window.cq.getDisplays(),
        set: (patch) => window.cq.set(patch),
        onState: (fn) => window.cq.onState(fn),
        closeDesigner: () => showPage('crosshairs'),
      };
    }
    const script = doc.createElement('script');
    script.id = 'designerBridgeScript';
    script.src = '../designer/designer.js';
    doc.body.appendChild(script);
  }
  function ensureDesignerFrame() {
    if (designerFrame) return designerFrame;
    let iframe = $('designerFrame');
    if (!iframe) {
      const host = $('page-designer');
      if (!host) return null;
      iframe = document.createElement('iframe');
      iframe.id = 'designerFrame';
      iframe.src = '../designer/designer.html';
      iframe.title = 'Criador';
      host.appendChild(iframe);
    }
    designerFrame = iframe;
    const boot = () => bootDesignerFrame(iframe);
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') boot();
    else iframe.addEventListener('load', boot);
    return iframe;
  }
  function postToDesigner(message) {
    const el = designerFrame || $('designerFrame');
    const frame = el && el.contentWindow;
    if (!frame) return;
    try { frame.postMessage(message, '*'); } catch { /* loading */ }
  }
  function forwardDesignerState(s) { postToDesigner({ source: 'cq-parent', type: 'cq:state', payload: s }); }
  function replyState(id, attempt = 0) {
    window.cq.getState().then((s) => {
      postToDesigner({ source: 'cq-parent', type: 'cq:state', id, payload: s });
    }).catch((error) => {
      if (attempt < 20) return void setTimeout(() => replyState(id, attempt + 1), 150);
      postToDesigner({ source: 'cq-parent', type: 'cq:error', id, message: error?.message || 'Falha ao ler o estado.' });
    });
  }
  function handleDesignerMessage(event) {
    const frameWin = designerFrame ? designerFrame.contentWindow : ($('designerFrame') || {}).contentWindow;
    if (!frameWin || event.source !== frameWin) return;
    const data = event.data;
    if (!data || data.source !== 'cq-designer') return;
    if (data.type === 'cq:getState') replyState(data.id);
    else if (data.type === 'cq:onState') { window.cq.getState().then((s) => postToDesigner({ source: 'cq-parent', type: 'cq:state', payload: s })).catch(() => {}); }
    else if (data.type === 'cq:set') { if (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)) set(data.payload); }
    else if (data.type === 'cq:close') showPage('crosshairs');
  }
  if (isApp) window.addEventListener('message', handleDesignerMessage);
  ensureDesignerFrame();

  // ---------- Navigation ----------
  const ROUTES = ['crosshairs', 'designer', 'positions', 'keybinds', 'startup'];
  function showPage(name) {
    if (!ROUTES.includes(name)) name = 'crosshairs';
    currentRoute = name;
    for (const section of document.querySelectorAll('.page')) {
      section.classList.remove('on');
      section.style.display = 'none';
    }
    const target = $('page-' + name);
    if (target) { target.classList.add('on'); target.style.display = ''; }
    for (const b of document.querySelectorAll('[data-route]')) {
      const on = b.dataset.route === name;
      b.classList[on ? 'add' : 'remove']('active');
    }
    const content = $('content'); if (content && typeof content.scrollTo === 'function') content.scrollTo(0, 0);
    if (name === 'designer') ensureDesignerFrame();
    if (name === 'positions') renderSavedPositions();
    if (name === 'keybinds') renderKeybinds();
    if (name === 'startup') { fillDisplays(); syncStartupStatus(); }
    if (name === 'crosshairs') switchXTab(currentXTab);
    if (isApp && window.location && window.location.hash !== '#' + name) window.location.hash = '#' + name;
  }
  for (const b of document.querySelectorAll('[data-route]')) b.addEventListener('click', () => showPage(b.dataset.route));
  for (const b of document.querySelectorAll('[data-open-designer]')) b.addEventListener('click', () => showPage('designer'));

  // ---------- Shell ----------
  if ($('btnWinMin')) $('btnWinMin').addEventListener('click', () => { if (window.cq && window.cq.windowControl) window.cq.windowControl('minimize'); });
  if ($('btnWinMax')) $('btnWinMax').addEventListener('click', () => { if (window.cq && window.cq.windowControl) window.cq.windowControl('maximize'); });
  if ($('btnWinClose')) $('btnWinClose').addEventListener('click', () => { if (window.cq && window.cq.windowControl) window.cq.windowControl('close'); });
  if ($('btnMenu')) $('btnMenu').addEventListener('click', () => {
    if (!document.body) return;
    const on = document.body.classList.contains('menu-collapsed');
    document.body.classList[on ? 'remove' : 'add']('menu-collapsed');
  });
  if ($('profileChip')) $('profileChip').addEventListener('click', () => { openModal(); showTab('perfis'); });
  if ($('profileModalClose')) $('profileModalClose').addEventListener('click', () => closeModal());
  if ($('profileModal')) $('profileModal').addEventListener('click', (e) => { if (e.target === $('profileModal')) closeModal(); });
  function isProfilePanelOpen() {
    const modal = $('profileModal');
    const panel = $('panelPerfis');
    if (!panel || panel.style.display === 'none') return false;
    if (modal && typeof modal.classList?.contains === 'function') {
      return modal.classList.contains('on');
    }
    return true;
  }
  let lastFocusProfileModal = null;
  function openModal() {
    const m = $('profileModal');
    if (!m) return;
    lastFocusProfileModal = document.activeElement;
    m.classList.add('on');
    if (isProfilePanelOpen()) renderProfiles();
    const closeBtn = $('profileModalClose');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }
  function closeModal() {
    const m = $('profileModal');
    if (m) m.classList.remove('on');
    if (lastFocusProfileModal && typeof lastFocusProfileModal.focus === 'function') {
      lastFocusProfileModal.focus();
    }
    lastFocusProfileModal = null;
  }

  // ---------- Crosshairs actions ----------
  if ($('btnQuickNavegar')) $('btnQuickNavegar').addEventListener('click', () => switchXTab('navegar'));
  if ($('btnQuickCriador')) $('btnQuickCriador').addEventListener('click', () => showPage('designer'));
  if ($('btnXGear')) $('btnXGear').addEventListener('click', () => showPage('startup'));

  // Hide marketing gift control; it is out of scope for this open-source build.
  const giftBtn = $('btnQuickGift');
  if (giftBtn) { giftBtn.hidden = true; giftBtn.style.display = 'none'; }

  let renamingTarget = null;
  let lastFocusRenameModal = null;
  function openRenameModal(item) {
    lastFocusRenameModal = document.activeElement;
    renamingTarget = item;
    const modal = $('renameModal');
    if (!modal) return;
    const isProfile = item?.isProfile === true;
    if ($('renameModalTitle')) {
      $('renameModalTitle').textContent = isProfile
        ? (I18N[currentLang]?.renameProfileModalTitle || 'Renomear Perfil')
        : (I18N[currentLang]?.renameModalTitle || 'Renomear Mira');
    }
    if ($('renameInput')) {
      $('renameInput').value = item?.name || '';
      $('renameInput').placeholder = isProfile
        ? (I18N[currentLang]?.placeholderRenameProfile || 'Nome do perfil')
        : (I18N[currentLang]?.placeholderRename || 'Nome da mira');
    }
    modal.classList.add('on');
    playSfx('click');
    if ($('renameInput') && typeof $('renameInput').focus === 'function') $('renameInput').focus();
  }
  function closeRenameModal() {
    const modal = $('renameModal');
    if (modal) modal.classList.remove('on');
    renamingTarget = null;
    if ($('renameModalTitle')) $('renameModalTitle').textContent = I18N[currentLang]?.renameModalTitle || 'Renomear Mira';
    if ($('renameInput')) $('renameInput').placeholder = I18N[currentLang]?.placeholderRename || 'Nome da mira';
    if (lastFocusRenameModal && typeof lastFocusRenameModal.focus === 'function') {
      lastFocusRenameModal.focus();
    }
    lastFocusRenameModal = null;
  }

  const MAX_SHARE_CODE_LEN = 2 * 1024 * 1024;

  function cleanPayload(item) {
    const isPreset = item && !Array.isArray(item.layers) && item.drawing === undefined;
    const model = item?.model || (item ? {} : currentModel());
    const layers = Array.isArray(item?.layers) ? item.layers : (isPreset ? [] : (state?.layers || []));
    const payload = {
      format: 'CQ1',
      id: item?.id || uniqueCrosshairId('share'),
      name: item?.name || 'Mira compartilhada',
      model,
      layers,
    };
    const drawing = item?.drawing !== undefined ? item.drawing : (!item ? state?.drawing : undefined);
    if (!layers.length && drawing != null) {
      payload.drawing = drawing;
    }
    return payload;
  }

  function openShareModal(item) {
    const modal = $('shareModal');
    if (!modal) return;
    const ta = $('shareCodeText');
    try {
      const code = buildShareCode(item);
      if (ta) ta.value = code;
    } catch (err) {
      if (ta) ta.value = '';
      toast(err?.message || 'Documento excede o limite de 2 MiB.');
      return;
    }
    modal.classList.add('on');
    playSfx('click');
    if (ta && typeof ta.focus === 'function') ta.focus();
  }
  function closeShareModal() {
    const modal = $('shareModal');
    if (modal) modal.classList.remove('on');
  }

  function openImportModal() {
    const modal = $('importModal');
    if (!modal) return;
    if ($('importCodeText')) $('importCodeText').value = '';
    if ($('importStatus')) $('importStatus').textContent = '';
    modal.classList.add('on');
    playSfx('click');
    if ($('importCodeText') && typeof $('importCodeText').focus === 'function') $('importCodeText').focus();
  }
  function closeImportModal() {
    const modal = $('importModal');
    if (modal) modal.classList.remove('on');
  }

  async function applyImportPayload(parsed) {
    if (!parsed || typeof parsed !== 'object') throw new Error('Documento inválido.');
    if (parsed.format && parsed.format !== 'CQ1') throw new Error('Versão de documento não suportada.');
    const api = await loadLayersApi();
    const validated = api && typeof api.validateCrosshair === 'function' ? api.validateCrosshair(parsed) : parsed;
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 200) : 'Mira importada';
    const creator = typeof parsed.creator === 'string' && parsed.creator.trim() ? parsed.creator.trim().slice(0, 120) : 'Importada';
    const entry = {
      id: uniqueCrosshairId('custom'),
      name,
      creator,
      model: validated.model || {},
      layers: validated.layers || [],
      drawing: validated.drawing ?? null,
      savedAt: Date.now(),
    };
    if (!saveJson(SAVED_CUSTOM, savedCustom().concat(entry))) {
      if (!corruptStorageKeys.has(SAVED_CUSTOM)) toast('Falha ao salvar no armazenamento local.');
      return false;
    }
    set(validated);
    renderLibrary();
    playSfx('success');
    toast(I18N[currentLang]?.importSuccess || 'Mira importada com sucesso.');
    return true;
  }

  function buildShareCode(item) {
    const payload = cleanPayload(item);
    const json = JSON.stringify(payload);
    const code = 'CQ1:' + encodeBase64(json);
    if (utf8ByteLength(code) > MAX_SHARE_CODE_LEN) {
      throw new Error('Código excede o tamanho máximo de 2 MiB.');
    }
    return code;
  }

  function parseShareCode(raw) {
    const str = String(raw || '').trim();
    if (!str) throw new Error('Código vazio.');
    if (str.length > MAX_SHARE_CODE_LEN) throw new Error('Código excede o tamanho máximo de 2 MiB.');
    let parsed;
    if (str.startsWith('CQ1:')) {
      parsed = JSON.parse(decodeBase64(str.slice(4).trim()));
    } else if (str.startsWith('CQ')) {
      throw new Error('Versão de código CQ não suportada.');
    } else if (str.startsWith('data:application/json;base64,')) {
      parsed = JSON.parse(decodeBase64(str.split(',')[1].trim()));
    } else if (str.startsWith('{')) {
      parsed = JSON.parse(str);
    } else {
      throw new Error('Formato não reconhecido. Use CQ1:... ou JSON.');
    }
    if (parsed && typeof parsed === 'object' && parsed.format && parsed.format !== 'CQ1') {
      throw new Error('Versão de documento não suportada.');
    }
    return parsed;
  }

  async function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
    }
    return false;
  }
  function crosshairPayload() {
    return cleanPayload();
  }

  if ($('btnShare')) $('btnShare').addEventListener('click', () => {
    openShareModal({ model: currentModel(), layers: state?.layers || [], drawing: state?.drawing ?? null });
  });
  if ($('shareModalClose')) $('shareModalClose').addEventListener('click', closeShareModal);
  if ($('shareModal')) $('shareModal').addEventListener('click', (e) => { if (e.target === $('shareModal')) closeShareModal(); });
  if ($('btnCopyShareCode')) $('btnCopyShareCode').addEventListener('click', async () => {
    const code = $('shareCodeText')?.value || '';
    if (await copyText(code)) {
      toast(I18N[currentLang]?.codeCopied || 'Código copiado.');
      playSfx('click');
    } else {
      $('shareCodeText')?.select();
      if (typeof document !== 'undefined' && document.execCommand) {
        try { document.execCommand('copy'); toast(I18N[currentLang]?.codeCopied || 'Código copiado.'); } catch { /* ignore */ }
      }
    }
  });
  if ($('btnExportShareFile')) $('btnExportShareFile').addEventListener('click', () => {
    try {
      const code = $('shareCodeText')?.value || '';
      let payload;
      try { payload = parseShareCode(code); } catch { payload = crosshairPayload(); }
      const json = JSON.stringify(payload, null, 2);
      if (utf8ByteLength(json) > MAX_SHARE_CODE_LEN) {
        toast('Documento excede o tamanho máximo de 2 MiB.');
        return;
      }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'crosshairq-mira.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(I18N[currentLang]?.fileExported || 'Arquivo exportado.');
      playSfx('click');
    } catch { toast('Não foi possível exportar a mira.'); }
  });

  if ($('btnImport')) $('btnImport').addEventListener('click', openImportModal);
  if ($('importModalClose')) $('importModalClose').addEventListener('click', closeImportModal);
  if ($('importModal')) $('importModal').addEventListener('click', (e) => { if (e.target === $('importModal')) closeImportModal(); });
  if ($('btnApplyImportCode')) $('btnApplyImportCode').addEventListener('click', async () => {
    const raw = ($('importCodeText')?.value || '').trim();
    if (!raw) {
      if ($('importStatus')) $('importStatus').textContent = 'Cole o código ou escolha um arquivo.';
      return;
    }
    try {
      const parsed = parseShareCode(raw);
      const ok = await applyImportPayload(parsed);
      if (ok) closeImportModal();
    } catch (err) {
      if ($('importStatus')) $('importStatus').textContent = `Erro: ${err?.message || 'Código inválido'}`;
    }
  });
  if ($('btnImportFileSelect')) $('btnImportFileSelect').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        if (file.size > MAX_SHARE_CODE_LEN) throw new Error('Arquivo excede o tamanho máximo de 2 MiB.');
        const raw = await file.text();
        if (raw.length > MAX_SHARE_CODE_LEN) throw new Error('Arquivo excede o tamanho máximo de 2 MiB.');
        const parsed = JSON.parse(raw);
        const ok = await applyImportPayload(parsed);
        if (ok) closeImportModal();
      } catch (error) {
        if ($('importStatus')) $('importStatus').textContent = `Arquivo inválido: ${error?.message || 'JSON malformado'}.`;
      } finally {
        input.remove();
      }
    });
    document.body.appendChild(input);
    input.click();
  });

  if ($('renameModalClose')) $('renameModalClose').addEventListener('click', closeRenameModal);
  if ($('btnRenameCancel')) $('btnRenameCancel').addEventListener('click', closeRenameModal);
  if ($('renameModal')) $('renameModal').addEventListener('click', (e) => { if (e.target === $('renameModal')) closeRenameModal(); });
  if ($('btnRenameSave')) $('btnRenameSave').addEventListener('click', () => {
    if (!renamingTarget) return;
    const name = ($('renameInput')?.value || '').trim();
    if (!name) { toast('Nome vazio.'); return; }
    if (renamingTarget.isProfile) {
      if (window.cq?.renameProfile) {
        window.cq.renameProfile(renamingTarget.id, name.slice(0, 200));
      }
      closeRenameModal();
      playSfx('click');
      setTimeout(renderProfiles, 60);
      return;
    }
    const list = savedCustom();
    const idx = list.findIndex(c => c.id === renamingTarget.id);
    let ok = false;
    if (idx >= 0) {
      list[idx].name = name.slice(0, 200);
      ok = saveJson(SAVED_CUSTOM, list);
    } else {
      const copy = { ...renamingTarget, id: uniqueCrosshairId('custom'), name: name.slice(0, 200) };
      ok = saveJson(SAVED_CUSTOM, list.concat(copy));
    }
    if (!ok) {
      if (!corruptStorageKeys.has(SAVED_CUSTOM)) toast('Falha ao salvar no armazenamento local.');
      return;
    }
    renderLibrary();
    closeRenameModal();
    playSfx('click');
    toast('Mira renomeada.');
  });

  if ($('contDownload')) $('contDownload').addEventListener('click', () => {
    try {
      const obj = crosshairPayload();
      const json = JSON.stringify(obj, null, 2);
      if (utf8ByteLength(json) > MAX_SHARE_CODE_LEN) {
        toast('Documento excede o tamanho máximo de 2 MiB.');
        return;
      }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'crosshairq-mira.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Mira exportada.');
    } catch { toast('Não foi possível exportar a mira.'); }
  });
  if ($('contSave')) $('contSave').addEventListener('click', () => {
    const model = currentModel();
    if (!model || typeof model !== 'object') return;
    const map = state?.profiles?.profiles;
    const current = map && state.profiles?.currentProfileId ? map[state.profiles.currentProfileId] : null;
    const name = profileLabel(current, 'Mira atual') + ' (cópia)';
    const entry = { id: 'custom-' + Date.now().toString(36), name, creator: 'Meu perfil', model: { ...model }, layers: state?.layers || [], drawing: state?.drawing ?? null };
    if (!saveJson(SAVED_CUSTOM, savedCustom().concat(entry))) {
      if (!corruptStorageKeys.has(SAVED_CUSTOM)) {
        toast('Não foi possível salvar: armazenamento local indisponível ou cheio. A mira atual foi mantida.');
      }
      return;
    }
    renderLibrary();
    toast('Mira atual salva nos favoritos.');
  });

  // ---------- Positions ----------
  let posPrefs = loadJson(POS_PREFS, { scale: 'off', position: 'off' });
  function setScale(value) {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) return;
    const v = Math.max(0.01, Math.min(10, Math.round(Number(value) * 100) / 100));
    set({ scale: v });
    if ($('scale')) $('scale').value = v;
    if ($('scaleRange')) { $('scaleRange').value = v; fillRange($('scaleRange'), v, 0.01, 10); }
  }
  function setOffset(axis, value) {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) return;
    const v = Math.max(-2000, Math.min(2000, Math.round(Number(value))));
    if (axis === 'x') { set({ offsetX: v }); if ($('offsetX')) $('offsetX').value = v; if ($('offsetXRange')) { $('offsetXRange').value = v; fillRange($('offsetXRange'), v, -2000, 2000); } }
    else { set({ offsetY: v }); if ($('offsetY')) $('offsetY').value = v; if ($('offsetYRange')) { $('offsetYRange').value = v; fillRange($('offsetYRange'), v, -2000, 2000); } }
  }
  if ($('scale')) $('scale').addEventListener('change', (e) => setScale(e.target.value));
  if ($('scaleRange')) $('scaleRange').addEventListener('input', (e) => setScale(e.target.value));
  if ($('scaleMinus')) $('scaleMinus').addEventListener('click', () => setScale((Number(state?.scale ?? 1) - 0.01)));
  if ($('scalePlus')) $('scalePlus').addEventListener('click', () => setScale((Number(state?.scale ?? 1) + 0.01)));
  if ($('scaleReset')) $('scaleReset').addEventListener('click', () => setScale(1));
  if ($('offsetX')) $('offsetX').addEventListener('change', (e) => setOffset('x', e.target.value));
  if ($('offsetXRange')) $('offsetXRange').addEventListener('input', (e) => setOffset('x', e.target.value));
  if ($('offsetY')) $('offsetY').addEventListener('change', (e) => setOffset('y', e.target.value));
  if ($('offsetYRange')) $('offsetYRange').addEventListener('input', (e) => setOffset('y', e.target.value));
  if ($('dpadLeft')) $('dpadLeft').addEventListener('click', () => setOffset('x', Number(state?.offsetX ?? 0) - 1));
  if ($('dpadRight')) $('dpadRight').addEventListener('click', () => setOffset('x', Number(state?.offsetX ?? 0) + 1));
  if ($('dpadUp')) $('dpadUp').addEventListener('click', () => setOffset('y', Number(state?.offsetY ?? 0) + 1));
  if ($('dpadDown')) $('dpadDown').addEventListener('click', () => setOffset('y', Number(state?.offsetY ?? 0) - 1));

  function syncPosPrefs() {
    for (const b of document.querySelectorAll('#scaleShortcut [data-scale-shortcut]')) {
      const on = b.dataset.scaleShortcut === posPrefs.scale;
      b.classList[on ? 'add' : 'remove']('active');
    }
    for (const b of document.querySelectorAll('#posShortcut [data-pos-shortcut]')) {
      const on = b.dataset.posShortcut === posPrefs.position;
      b.classList[on ? 'add' : 'remove']('active');
    }
    const status = $('posShortcutStatus');
    if (status) {
      if (posPrefs.position === 'off') status.textContent = 'Atalhos de posição desligados.';
      else status.textContent = `Atalhos de posição: ${posPrefs.position === 'wasd' ? 'WASD' : 'setas'} (Alt+Shift).`;
    }
  }
  for (const b of document.querySelectorAll('#scaleShortcut [data-scale-shortcut]')) {
    b.addEventListener('click', () => { posPrefs = { ...posPrefs, scale: b.dataset.scaleShortcut }; saveJson(POS_PREFS, posPrefs); syncPosPrefs(); toast(posPrefs.scale === 'off' ? 'Atalho de escala desligado.' : 'Atalho de escala ligado (Alt+Shift + / -).'); });
  }
  for (const b of document.querySelectorAll('#posShortcut [data-pos-shortcut]')) {
    b.addEventListener('click', () => { posPrefs = { ...posPrefs, position: b.dataset.posShortcut }; saveJson(POS_PREFS, posPrefs); syncPosPrefs(); });
  }
  syncPosPrefs();

  function renderSavedPositions() {
    const host = $('savedPositions');
    if (!host) return;
    host.innerHTML = '';
    const items = loadJson(POSITIONS, []);
    items.forEach((p, index) => {
      const row = document.createElement('div');
      row.className = 'saved-item';
      const name = document.createElement('span'); name.className = 'grow'; name.textContent = p.name;
      const meta = document.createElement('span'); meta.className = 'muted'; meta.textContent = `${Number(p.scale).toFixed(1)}× · ${p.x}, ${p.y}`;
      const apply = document.createElement('button'); apply.textContent = 'Aplicar'; apply.title = 'Aplicar esta posição';
      apply.addEventListener('click', () => {
        set({ scale: p.scale, offsetX: p.x, offsetY: p.y });
        if ($('positionsStatus')) $('positionsStatus').textContent = `Posição "${p.name}" aplicada.`;
        toast('Posição aplicada.');
      });
      const del = document.createElement('button'); del.innerHTML = '&#10005;'; del.title = 'Excluir';
      del.addEventListener('click', () => {
        const next = loadJson(POSITIONS, []).filter((_, i) => i !== index);
        if (!saveJson(POSITIONS, next)) { toast('Não foi possível excluir a posição.'); return; }
        renderSavedPositions();
        if ($('positionsStatus')) $('positionsStatus').textContent = 'Posição excluída.';
      });
      row.append(name, meta, apply, del);
      host.appendChild(row);
    });
  }
  if ($('btnSavePos')) $('btnSavePos').addEventListener('click', () => {
    const input = $('posName');
    const items = loadJson(POSITIONS, []);
    const name = (input?.value || '').trim() || `Posição ${items.length + 1}`;
    items.push({ name: name.slice(0, 120), scale: Number(state?.scale ?? 1), x: Number(state?.offsetX ?? 0), y: Number(state?.offsetY ?? 0) });
    if (!saveJson(POSITIONS, items)) { toast('Não foi possível salvar a posição.'); return; }
    if (input) input.value = '';
    renderSavedPositions();
    if ($('positionsStatus')) $('positionsStatus').textContent = 'Posição salva.';
    toast('Posição salva.');
  });
  renderSavedPositions();

  // Crosshair advanced controls.
  function bumpSize(delta) {
    const v = Math.max(0.1, Math.min(10, Math.round((Number(state?.crosshairSize ?? 1) + delta) * 10) / 10));
    set({ crosshairSize: v });
  }
  if ($('optionCrosshairSizeMinus')) $('optionCrosshairSizeMinus').addEventListener('click', () => bumpSize(-0.1));
  if ($('optionCrosshairSizePlus')) $('optionCrosshairSizePlus').addEventListener('click', () => bumpSize(0.1));
  if ($('optionCrosshairSizeReset')) $('optionCrosshairSizeReset').addEventListener('click', () => set({ crosshairSize: 1 }));
  function bumpOffset(axis, delta) {
    const co = state?.crosshairOffset || { x: 0, y: 0 };
    const v = Math.max(-500, Math.min(500, Number(co[axis] || 0) + delta));
    set({ crosshairOffset: { ...co, [axis]: v } });
  }
  if ($('optionOffsetXMinus')) $('optionOffsetXMinus').addEventListener('click', () => bumpOffset('x', -1));
  if ($('optionOffsetXPlus')) $('optionOffsetXPlus').addEventListener('click', () => bumpOffset('x', 1));
  if ($('optionOffsetXReset')) $('optionOffsetXReset').addEventListener('click', () => set({ crosshairOffset: { ...(state?.crosshairOffset || {}), x: 0 } }));
  if ($('optionOffsetYMinus')) $('optionOffsetYMinus').addEventListener('click', () => bumpOffset('y', -1));
  if ($('optionOffsetYPlus')) $('optionOffsetYPlus').addEventListener('click', () => bumpOffset('y', 1));
  if ($('optionOffsetYReset')) $('optionOffsetYReset').addEventListener('click', () => set({ crosshairOffset: { ...(state?.crosshairOffset || {}), y: 0 } }));

  // ---------- Keybinds ----------
  const CTRL_KEYS = { leftTrigger: 'LT', rightTrigger: 'RT', faceWest: 'X', faceSouth: 'A', faceNorth: 'Y', faceEast: 'B' };
  function formatPc(keyData) {
    const pc = keyData?.pc;
    if (!pc?.key) return '';
    const mods = Array.isArray(pc.modifiers) ? pc.modifiers : [];
    return [...mods, pc.key];
  }
  function formatController(keyData) {
    const key = keyData?.controller?.key;
    if (!key) return '';
    return [CTRL_KEYS[key] || key];
  }
  function kbdHtml(parts) {
    return parts.map((p, i) => `${i ? '<span class="kb-plus">+</span>' : ''}<kbd class="keycap">${escapeHtml(p)}</kbd>`).join('');
  }
  function patchKeybind(action, pc) {
    const kb = state?.keybinds || {};
    const current = kb[action] || {};
    const nextPc = current.pc && typeof current.pc === 'object'
      ? { ...current.pc, modifiers: pc.modifiers, key: pc.key }
      : { modifiers: pc.modifiers, key: pc.key, platform: 'PC' };
    const next = { ...kb, [action]: { ...current, pc: nextPc } };
    set({ keybinds: next });
  }
  function setKeybindEnabled(action, enabled) {
    const kb = state?.keybinds || {};
    const current = kb[action] || {};
    const next = { ...kb, [action]: { ...current, enabled: !!enabled } };
    set({ keybinds: next });
  }

  let capturingAction = null;
  let captureBackup = null;
  let captureAttempt = null;
  const LABELS = { globalShortcut: 'Alternar Global', aim: 'Mirar', fire: 'Atirar', reload: 'Recarregar' };
  const GLOBAL_KEY_RE = /^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|[+\-=,.;/\[\]\\'`])$/;

  function shortcutAccelerator(pc) {
    const aliases = { Ctrl: 'Control', Meta: 'Super' };
    const modifiers = [...new Set((pc?.modifiers || []).map((m) => aliases[m] || m))];
    const key = pc?.key === '+' ? 'Plus' : String(pc?.key || '').replace(/^Arrow/, '');
    return [...modifiers, key].join('+');
  }

  function makeToggle(checked, onToggle) {
    const dict = I18N[currentLang] || I18N['pt-BR'];
    const wrap = document.createElement('span');
    wrap.className = 'kb-toggle';
    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = dict.kbOff || 'DESLIGADO';
    off.setAttribute('aria-pressed', String(!checked));
    off.className = !checked ? 'on is-active' : 'is-inactive';

    const on = document.createElement('button');
    on.type = 'button';
    on.textContent = dict.kbOn || 'LIGADO';
    on.setAttribute('aria-pressed', String(!!checked));
    on.className = checked ? 'on is-active' : 'is-inactive';

    off.addEventListener('click', () => { playSfx('toggle'); onToggle(false); });
    on.addEventListener('click', () => { playSfx('toggle'); onToggle(true); });
    wrap.append(off, on);
    return wrap;
  }
  function beginCapture(action) {
    if (action !== 'globalShortcut') return;
    captureBackup = state?.keybinds?.globalShortcut ? JSON.parse(JSON.stringify(state.keybinds.globalShortcut)) : null;
    captureAttempt = null;
    capturingAction = action;
    toast(`Pressione a nova combinação para ${LABELS[action] || action}.`);
    renderKeybinds();
  }
  function renderKeybinds() {
    const host = $('keybindList');
    if (!host || !state?.keybinds) return;
    host.innerHTML = '';
    const dict = I18N[currentLang] || I18N['pt-BR'];
    const kb = state.keybinds;
    function addRow(action, label, icon, pill) {
      const tr = document.createElement('tr');
      const pcParts = formatPc(kb[action] || {});
      const ctlParts = formatController(kb[action] || {});
      const pcContent = pcParts.length ? kbdHtml(pcParts) : '<span class="kb-pad">Clique para capturar</span>';
      const pcBtn = document.createElement('button');
      pcBtn.type = 'button';
      pcBtn.style.cssText = 'background:transparent;border:0;padding:0;cursor:pointer;';
      pcBtn.innerHTML = pcContent;
      pcBtn.disabled = action !== 'globalShortcut';
      pcBtn.title = action === 'globalShortcut' ? 'Clique e pressione a nova combinação' : 'Somente leitura: entrada fixa; remapeamento indisponível';
      pcBtn.addEventListener('click', () => beginCapture(action));
      const ctl = ctlParts.length ? kbdHtml(ctlParts) : `<span class="kb-pad">${dict.kbUnassigned || 'Não atribuído'}</span>`;
      const aimOff = kb.aim?.enabled === false;
      const aimPress = (kb.aim?.pressType === 'toggle') ? 'toggle' : 'hold';
      const sub = action === 'aim'
        ? `<select class="kb-sub" title="${currentLang === 'en-US' ? 'Aiming activation type' : 'Tipo de ativação ao mirar'}"><option value="off"${aimOff ? ' selected' : ''}>${dict.kbAimOff || 'Desligado'}</option><option value="hold"${!aimOff && aimPress === 'hold' ? ' selected' : ''}>${dict.kbAimHold || 'Ocultar Mira (Segurar)'}</option><option value="toggle"${!aimOff && aimPress === 'toggle' ? ' selected' : ''}>${dict.kbAimToggle || 'Alternar Mira'}</option></select>`
        : '';
      tr.innerHTML = `<td><div class="kb-action"><span class="kb-name"><svg class="ico"><use href="#${icon}"/></svg>${escapeHtml(label)}</span>${sub}</div></td>`;
      const select = tr.querySelector('.kb-sub');
      if (select) {
        select.addEventListener('change', (e) => {
          const val = e.target.value;
          const currentAim = state?.keybinds?.aim || {};
          const priorPress = (currentAim.pressType === 'toggle' || currentAim.pressType === 'hold')
            ? currentAim.pressType
            : 'hold';
          if (val === 'off') {
            set({ keybinds: { ...state?.keybinds, aim: { ...currentAim, enabled: false, pressType: priorPress } } });
          } else {
            set({ keybinds: { ...state?.keybinds, aim: { ...currentAim, enabled: true, pressType: val } } });
          }
        });
      }
      const pcTd = document.createElement('td'); pcTd.className = 'c';
      const pcCell = document.createElement('span'); pcCell.className = 'kb-cell';
      const dev = document.createElement('svg'); dev.className = 'ico kb-dev'; dev.innerHTML = '<use href="#i-keyboard"/>';
      pcCell.appendChild(dev); pcCell.appendChild(pcBtn);
      pcTd.appendChild(pcCell);
      const ctlTd = document.createElement('td'); ctlTd.className = 'c';
      const ctlCell = document.createElement('span'); ctlCell.className = 'kb-cell';
      const pad = document.createElement('svg'); pad.className = 'ico kb-dev'; pad.innerHTML = '<use href="#i-gamepad"/>';
      ctlCell.appendChild(pad);
      const span = document.createElement('span'); span.className = 'kb-keys'; span.innerHTML = ctl; ctlCell.appendChild(span);
      ctlTd.appendChild(ctlCell);
      tr.appendChild(pcTd); tr.appendChild(ctlTd);
      if (pill) tr.appendChild(pill);
      host.appendChild(tr);
    }
    const globalEnabled = kb.globalShortcut?.enabled !== false;
    addRow('globalShortcut', dict.kbGlobalToggle || 'Alternar Global', 'i-keyboard', null);
    // Keep the toggle in the global row's action cell.
    const globalRow = host.lastChild;
    if (globalRow) {
      const actionCell = globalRow.querySelector('td');
      if (actionCell) {
        const slot = document.createElement('span'); slot.style.marginLeft = 'auto';
        slot.appendChild(makeToggle(globalEnabled, (enabled) => setKeybindEnabled('globalShortcut', enabled)));
        const actionDiv = actionCell.querySelector('.kb-action');
        if (actionDiv) actionDiv.appendChild(slot);
      }
    }

    const actionIcons = { aim: 'i-crosshair', fire: 'i-target', reload: 'i-reset' };
    const labels = {
      aim: dict.kbAim || 'Mirar',
      fire: dict.kbFire || 'Atirar',
      reload: dict.kbReload || 'Recarregar',
    };
    for (const key of ['aim', 'fire', 'reload']) {
      addRow(key, labels[key], actionIcons[key], null);
      if (key === 'fire' || key === 'reload') {
        const row = host.lastChild;
        if (row) {
          const actionCell = row.querySelector?.('td');
          if (actionCell) {
            const slot = document.createElement('span'); slot.style.marginLeft = 'auto';
            const isEnabled = kb[key]?.enabled !== false;
            slot.appendChild(makeToggle(isEnabled, (enabled) => setKeybindEnabled(key, enabled)));
            const actionDiv = actionCell.querySelector?.('.kb-action');
            if (actionDiv) actionDiv.appendChild(slot);
          }
        }
      }
    }

    // Custom keybinds stored locally.
    const customs = loadJson(CUSTOM_KEYBINDS, []);
    for (const [idx, item] of (Array.isArray(customs) ? customs : []).entries()) {
      const tr = document.createElement('tr');
      const pc = Array.isArray(item.pc?.modifiers) ? item.pc.modifiers.concat(item.pc.key) : (item.pc?.key ? [item.pc.key] : []);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger'; delBtn.textContent = 'Remover'; delBtn.style.marginLeft = '8px';
      delBtn.addEventListener('click', () => {
        const list = loadJson(CUSTOM_KEYBINDS, []);
        const next = Array.isArray(list) ? list.filter((_, i) => i !== idx) : [];
        saveJson(CUSTOM_KEYBINDS, next);
        renderKeybinds();
        toast('Atalho removido.');
      });
      tr.innerHTML = `<td><div class="kb-action"><span class="kb-name"><svg class="ico"><use href="#i-keyboard"/></svg>${escapeHtml(item.name || 'Atalho')} (inativo; sem executor)</span></div></td>`;
      const pcTd = document.createElement('td'); pcTd.className = 'c'; pcTd.innerHTML = pc.length ? kbdHtml(pc) : '<span class="kb-pad">—</span>';
      const ctlTd = document.createElement('td'); ctlTd.className = 'c'; ctlTd.innerHTML = `<span class="kb-pad">${dict.kbUnassigned || 'Não atribuído'}</span>`;
      tr.append(pcTd, ctlTd);
      const actionCell = tr.querySelector('td');
      if (actionCell?.querySelector('.kb-action')) actionCell.querySelector('.kb-action').appendChild(delBtn);
      host.appendChild(tr);
    }

    // Legacy custom entries stay removable; no new non-executable bindings.
    const status = state.shortcutStatus;
    const globalStatusText = status?.error ? `Alternar global: ${status.error}` : status?.registered ? `Alternar global ativo: ${status.accelerator}.` : 'Alternar global desligado.';
    const fireStatusText = kb.fire?.enabled !== false ? 'Atirar: monitor nativo ativo.' : 'Atirar: desativado.';
    const reloadStatusText = 'Recarregar: execução backend pendente (sem hook global no SO).';
    if ($('keybindStatus')) $('keybindStatus').textContent = `${globalStatusText} Mirar: entrada fixa do monitor nativo, sem remapeamento. ${fireStatusText} ${reloadStatusText} Atalhos personalizados: sem executor.`;
  }

  if ($('btnNewKeybind')) {
    $('btnNewKeybind').disabled = true;
    $('btnNewKeybind').title = 'Atalhos personalizados indisponíveis: sem executor';
  }

  try {
    const kbNote = document.querySelector && document.querySelector('.kb-note');
    if (kbNote) kbNote.textContent = 'Alternar Global usa a combinação e o estado LIGADO/DESLIGADO deste perfil. Confira abaixo se o sistema aceitou o registro. Mirar/atirar têm entradas fixas do monitor nativo; remapeamento, recarregar, controle global e atalhos personalizados indisponíveis.';
  } catch { /* test harness lacks querySelector */ }

  // ---------- Settings ----------
  function showOptTab(name) {
    const panels = { geral: $('optPanelGeral'), display: $('optPanelDisplay'), stream: $('optPanelStream') };
    for (const [key, panel] of Object.entries(panels)) if (panel) panel.style.display = key === name ? '' : 'none';
    const tabs = { geral: $('optTabGeral'), display: $('optTabDisplay'), stream: $('optTabStream') };
    for (const [key, tab] of Object.entries(tabs)) if (tab) tab.classList[key === name ? 'add' : 'remove']('active');
    if (name === 'display') fillDisplays();
  }
  if ($('optTabGeral')) $('optTabGeral').addEventListener('click', () => showOptTab('geral'));
  if ($('optTabDisplay')) $('optTabDisplay').addEventListener('click', () => showOptTab('display'));
  if ($('optTabStream')) $('optTabStream').addEventListener('click', () => showOptTab('stream'));

  function filterSettings(cat) {
    for (const b of document.querySelectorAll('#optCats [data-optcat]')) b.classList[b.dataset.optcat === cat ? 'add' : 'remove']('active');
    for (const el of document.querySelectorAll('#optPanelGeral [data-cat]')) el.classList[cat === 'all' || el.dataset.cat === cat ? 'add' : 'remove']('on');
  }
  for (const b of document.querySelectorAll('#optCats [data-optcat]')) b.addEventListener('click', () => filterSettings(b.dataset.optcat));

  function fillDisplays() {
    const sel = $('display');
    if (!sel) return;
    if (!displaysCache.length) return;
    sel.innerHTML = '';
    for (const d of displaysCache) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label || `Monitor ${d.id} (${d.bounds?.width || '?'}x${d.bounds?.height || '?'})`;
      sel.appendChild(opt);
    }
    const current = state?.displayId ?? displaysCache[0]?.id;
    sel.value = String(current);
    const info = $('displaysInfo');
    if (info) info.textContent = displaysCache.map((d) => `${d.label || 'Monitor ' + d.id} — ${d.bounds?.width || '?'}×${d.bounds?.height || '?'}`).join(' · ');
  }
  if ($('display')) $('display').addEventListener('change', (e) => set({ displayId: Number(e.target.value) }));

  // general switches
  if ($('visible')) $('visible').addEventListener('change', (e) => set({ visible: e.target.checked }));
  if ($('limitSize')) $('limitSize').addEventListener('change', (e) => set({ limitSize: e.target.checked }));
  if ($('showSecondary')) $('showSecondary').addEventListener('change', (e) => set({ showSecondary: e.target.checked }));
  if ($('profileDetectionEnabled')) $('profileDetectionEnabled').addEventListener('change', (e) => set({ profileDetectionEnabled: e.target.checked }));
  if ($('optionOnlyInGame')) {
    $('optionOnlyInGame').addEventListener('change', (e) => {
      const currentPath = (state?.onlyInGameProcessPath || $('onlyInGameProcessPath')?.value || '').trim();
      if (e.target.checked && !currentPath) {
        e.target.checked = false;
        toast('Configure ou selecione um executável .exe antes de ativar.');
        return;
      }
      set({ onlyInGame: e.target.checked });
    });
  }
  if ($('onlyInGameProcessPath')) {
    $('onlyInGameProcessPath').addEventListener('change', (e) => {
      const val = e.target.value.trim();
      if (!val) {
        set({ onlyInGameProcessPath: '', onlyInGame: false });
        if ($('optionOnlyInGame')) $('optionOnlyInGame').checked = false;
        return;
      }
      if (validProcessPath(val)) {
        set({ onlyInGameProcessPath: val });
      } else {
        toast('Caminho inválido (deve ser um arquivo .exe completo).');
        e.target.value = state?.onlyInGameProcessPath || '';
      }
    });
  }
  if ($('btnBrowseGameExecutable')) {
    $('btnBrowseGameExecutable').addEventListener('click', async () => {
      try {
        if (!window.cq?.browseGameExecutable) return;
        const res = await window.cq.browseGameExecutable();
        const path = typeof res === 'string' ? res : res?.path;
        if (!path || res?.canceled) return;
        if (validProcessPath(path)) {
          set({ onlyInGameProcessPath: path });
          if ($('onlyInGameProcessPath')) $('onlyInGameProcessPath').value = path;
          toast('Executável selecionado: ' + path);
        } else {
          toast('Caminho de executável inválido.');
        }
      } catch (err) {
        console.error('[browseGameExecutable]', err);
      }
    });
  }
  if ($('btnCaptureOnlyInGame')) {
    $('btnCaptureOnlyInGame').addEventListener('click', async () => {
      try {
        if (!window.cq?.getNativeStatus) return;
        const res = await window.cq.getNativeStatus();
        const fg = res?.foreground;
        if (!fg || !fg.executablePath) {
          toast('Nenhuma janela em primeiro plano capturada.');
          return;
        }
        if (validProcessPath(fg.executablePath)) {
          set({ onlyInGameProcessPath: fg.executablePath });
          if ($('onlyInGameProcessPath')) $('onlyInGameProcessPath').value = fg.executablePath;
          toast('Executável capturado: ' + (fg.executableName || fg.executablePath));
        } else {
          toast('Aplicativo em primeiro plano não tem caminho .exe válido.');
        }
      } catch (err) {
        console.error('[captureOnlyInGame]', err);
      }
    });
  }
  if ($('btnClearOnlyInGameProcess')) {
    $('btnClearOnlyInGameProcess').addEventListener('click', () => {
      set({ onlyInGameProcessPath: '', onlyInGame: false });
      if ($('onlyInGameProcessPath')) $('onlyInGameProcessPath').value = '';
      if ($('optionOnlyInGame')) $('optionOnlyInGame').checked = false;
      toast('Executável desvinculado.');
    });
  }
  if ($('optionStartMinimized')) {
    $('optionStartMinimized').disabled = false;
    $('optionStartMinimized').addEventListener('change', (e) => set({ startMinimized: e.target.checked }));
  }
  if ($('optionMinimizeToTray')) $('optionMinimizeToTray').addEventListener('change', (e) => set({ minimizeToTray: e.target.checked }));
  if ($('optionLanguage')) {
    $('optionLanguage').value = currentLang;
    $('optionLanguage').addEventListener('change', (e) => {
      applyLanguage(e.target.value);
      playSfx('click');
      toast(e.target.value === 'en-US' ? 'Language set to English.' : 'Idioma definido para Português.');
    });
  }
  if ($('optionSounds')) {
    $('optionSounds').checked = loadJson('cq.soundEffects', false) === true;
    $('optionSounds').addEventListener('change', (e) => {
      saveJson('cq.soundEffects', e.target.checked);
      if (e.target.checked) playSfx('toggle');
    });
  }

  // model controls
  if ($('color')) $('color').addEventListener('input', (e) => setModel({ color: e.target.value }));
  for (const id of ['armLen', 'armThick', 'gap', 'rotation']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', (e) => {
      const n = Number(e.target.value);
      const v = $(id + 'V'); if (v) v.textContent = n;
      fillRange(el, n);
      setModel({ [id]: n });
    });
  }
  if ($('dotEnabled')) $('dotEnabled').addEventListener('change', (e) => setModel({ dot: { ...(currentModel().dot || {}), enabled: e.target.checked } }));
  if ($('dotSize')) $('dotSize').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    if ($('dotSizeV')) $('dotSizeV').textContent = n;
    fillRange($('dotSize'), n);
    setModel({ dot: { ...(currentModel().dot || {}), size: n } });
  });
  if ($('dotShape')) $('dotShape').addEventListener('change', (e) => setModel({ dot: { ...(currentModel().dot || {}), shape: e.target.value } }));
  if ($('outlineEnabled')) $('outlineEnabled').addEventListener('change', (e) => setModel({ outline: { ...(currentModel().outline || {}), enabled: e.target.checked } }));
  if ($('outlineWidth')) $('outlineWidth').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    if ($('outlineWidthV')) $('outlineWidthV').textContent = n;
    fillRange($('outlineWidth'), n);
    setModel({ outline: { ...(currentModel().outline || {}), width: n } });
  });
  if ($('outlineColor')) $('outlineColor').addEventListener('input', (e) => setModel({ outline: { ...(currentModel().outline || {}), color: e.target.value } }));

  if ($('btnOpenKeybinds')) $('btnOpenKeybinds').addEventListener('click', () => showPage('keybinds'));

  if ($('btnResetSettings')) $('btnResetSettings').addEventListener('click', async () => {
    set({ visible: true, scale: 1, offsetX: 0, offsetY: 0, limitSize: false, showSecondary: false, onlyInGame: false, onlyInGameProcessPath: '', crosshairSize: 1, crosshairOffset: { x: 0, y: 0 }, minimizeToTray: true, startMinimized: false });
    posPrefs = { scale: 'off', position: 'off' };
    saveJson(POS_PREFS, posPrefs);
    syncPosPrefs();
    if (streamerRunning === true) {
      try { await window.cq.stopStreamer(); } catch { /* ignore */ }
      syncStreamer();
    }
    if ($('positionsStatus')) $('positionsStatus').textContent = 'Configurações restauradas.';
    toast('Configurações restauradas.');
  });

  // ---------- Startup (Início automático) ----------
  let startupSeq = 0;
  let startupStatus = null;
  let isSettingStartup = false;
  const optStartWithWindows = $('optionStartWithWindows');
  const startupStatusEl = $('startupStatus');

  function renderStartupStatus(st, isPending = false) {
    if (!optStartWithWindows) return;
    if (isPending) {
      optStartWithWindows.disabled = true;
      if (startupStatusEl) startupStatusEl.textContent = 'Atualizando início automático…';
      return;
    }
    if (!st) {
      optStartWithWindows.disabled = true;
      optStartWithWindows.checked = false;
      optStartWithWindows.indeterminate = true;
      if (startupStatusEl) startupStatusEl.textContent = 'Consultando início automático…';
      return;
    }
    if (st.supported === false) {
      optStartWithWindows.disabled = true;
      optStartWithWindows.checked = false;
      optStartWithWindows.indeterminate = false;
      if (startupStatusEl) startupStatusEl.textContent = st.error || 'Início automático é suportado apenas no Windows.';
      return;
    }
    if (st.available === false) {
      optStartWithWindows.disabled = true;
      optStartWithWindows.checked = false;
      optStartWithWindows.indeterminate = false;
      if (startupStatusEl) startupStatusEl.textContent = st.error || 'Indisponível neste ambiente.';
      return;
    }

    optStartWithWindows.disabled = false;
    if (st.enabled === true) {
      optStartWithWindows.checked = true;
      optStartWithWindows.indeterminate = false;
      let msg = 'Ativado. O aplicativo inicia com o Windows.';
      if (st.error) msg += ` (${st.error})`;
      if (startupStatusEl) startupStatusEl.textContent = msg;
    } else if (st.enabled === false) {
      optStartWithWindows.checked = false;
      optStartWithWindows.indeterminate = false;
      let msg = 'Desativado.';
      if (st.configured === true && st.approved === false) {
        msg = 'Desativado no Gerenciador de Tarefas do Windows.';
      }
      if (st.error) msg += ` (${st.error})`;
      if (startupStatusEl) startupStatusEl.textContent = msg;
    } else {
      optStartWithWindows.checked = false;
      optStartWithWindows.indeterminate = true;
      let msg = 'Desconhecido.';
      if (st.error) msg += ` ${st.error}`;
      else msg += ' Não foi possível confirmar o status no sistema.';
      if (startupStatusEl) startupStatusEl.textContent = msg;
    }
  }

  async function syncStartupStatus() {
    if (isSettingStartup) return;
    if (!window.cq || typeof window.cq.getStartupStatus !== 'function') return;
    const seq = ++startupSeq;
    if (!startupStatus && optStartWithWindows) {
      optStartWithWindows.disabled = true;
      if (startupStatusEl) startupStatusEl.textContent = 'Consultando início automático…';
    }
    try {
      const res = await window.cq.getStartupStatus();
      if (seq !== startupSeq) return;
      startupStatus = res;
      renderStartupStatus(res, false);
    } catch (err) {
      if (seq !== startupSeq) return;
      startupStatus = {
        supported: startupStatus?.supported ?? null,
        available: startupStatus?.available ?? null,
        configured: null,
        approved: null,
        enabled: null,
        error: `Não foi possível consultar início automático. ${err?.message || 'Falha de comunicação.'}`,
      };
      renderStartupStatus(startupStatus, false);
    }
  }

  async function handleStartupToggle(e) {
    if (isSettingStartup) return;
    if (!window.cq || typeof window.cq.setStartup !== 'function') return;
    const want = e.target.checked;
    const seq = ++startupSeq;
    renderStartupStatus(startupStatus, true);
    let res;
    try {
      isSettingStartup = true;
      res = await window.cq.setStartup(want);
    } catch (err) {
      isSettingStartup = false;
      if (seq !== startupSeq) return;
      const writeErr = `Falha ao alterar início automático: ${err?.message || 'Erro de comunicação.'}`;
      try {
        if (typeof window.cq.getStartupStatus === 'function') {
          const fresh = await window.cq.getStartupStatus();
          if (seq !== startupSeq) return;
          const queryErr = fresh?.error;
          const errText = !queryErr || queryErr === writeErr || queryErr === err?.message
            ? writeErr
            : `${writeErr} (Consulta: ${queryErr})`;
          startupStatus = fresh ? {
            ...fresh,
            error: errText,
          } : {
            supported: startupStatus?.supported ?? null,
            available: startupStatus?.available ?? null,
            configured: null,
            approved: null,
            enabled: null,
            error: errText,
          };
          renderStartupStatus(startupStatus, false);
          return;
        }
      } catch { /* ignore secondary failure */ }
      if (seq !== startupSeq) return;
      startupStatus = {
        supported: startupStatus?.supported ?? null,
        available: startupStatus?.available ?? null,
        configured: null,
        approved: null,
        enabled: null,
        error: writeErr,
      };
      renderStartupStatus(startupStatus, false);
      return;
    } finally {
      isSettingStartup = false;
    }
    if (seq !== startupSeq) return;
    startupStatus = {
      supported: startupStatus?.supported ?? (res.ok === true ? true : null),
      available: startupStatus?.available ?? (res.ok === true ? true : null),
      configured: res.configured,
      approved: res.approved,
      enabled: res.enabled,
      error: res.error,
    };
    renderStartupStatus(startupStatus, false);
  }

  if (optStartWithWindows) {
    optStartWithWindows.addEventListener('change', handleStartupToggle);
  }
  syncStartupStatus();
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => { syncStartupStatus(); });
  }

  // ---------- Streamer ----------
  let streamerRunning = null;
  let streamerPending = false;
  const btnStreamer = $('btnStreamer');
  const streamerStatus = $('streamerStatus');
  function updateStreamerBtn() {
    if (!btnStreamer) return;
    btnStreamer.textContent = streamerRunning === null ? 'Consultar' : streamerRunning ? 'Parar' : 'Iniciar';
    btnStreamer.className = streamerRunning ? 'btn primary' : 'btn';
    btnStreamer.disabled = streamerPending;
  }
  function paintStreamerDot(running) {
    const dot = $('streamerDot');
    if (dot) dot.classList[running ? 'add' : 'remove']('on');
  }
  async function syncStreamer(action) {
    if (streamerPending) return;
    if (!window.cq) return;
    streamerPending = true;
    updateStreamerBtn();
    if (streamerStatus) streamerStatus.textContent = action ? 'Alterando servidor HTTP local…' : 'Consultando servidor HTTP local…';
    try {
      if (action) await action();
      const st = await window.cq.getStreaming();
      if (typeof st?.running !== 'boolean') throw new Error('Resposta de status inválida.');
      streamerRunning = st.running;
      if (streamerStatus) streamerStatus.textContent = st.running ? 'Servidor HTTP local em execução.' : 'Servidor HTTP local parado.';
      paintStreamerDot(st.running);
    } catch (error) {
      streamerRunning = null;
      if (streamerStatus) streamerStatus.textContent = `Não foi possível confirmar o servidor HTTP local. ${error?.message || 'Falha de comunicação.'} Clique em Consultar para tentar novamente.`;
      paintStreamerDot(null);
    } finally {
      streamerPending = false;
      updateStreamerBtn();
    }
  }
  if (btnStreamer) btnStreamer.addEventListener('click', () => syncStreamer(streamerRunning === null ? null :
    streamerRunning ? () => window.cq.stopStreamer() : () => window.cq.startStreamer(24164)));
  syncStreamer();

  // ---------- Profiles ----------
  const panelConfig = $('panelConfig');
  const panelPerfis = $('panelPerfis');
  function showTab(name) {
    if (panelConfig && panelPerfis) {
      if (name === 'config') {
        panelConfig.style.display = ''; panelPerfis.style.display = 'none';
        if ($('tabConfig')) $('tabConfig').classList.add('active');
        if ($('tabPerfis')) $('tabPerfis').classList.remove('active');
      } else {
        panelConfig.style.display = 'none'; panelPerfis.style.display = '';
        if ($('tabConfig')) $('tabConfig').classList.remove('active');
        if ($('tabPerfis')) $('tabPerfis').classList.add('active');
        renderProfiles(); readForeground();
      }
    }
  }
  if ($('tabConfig')) $('tabConfig').addEventListener('click', () => showTab('config'));
  if ($('tabPerfis')) $('tabPerfis').addEventListener('click', () => showTab('perfis'));
  if ($('btnHomePerfis')) $('btnHomePerfis').addEventListener('click', () => { openModal(); showTab('perfis'); });
  if ($('openDesigner')) $('openDesigner').addEventListener('click', () => { closeModal(); showPage('designer'); });

  const nativeStatus = $('nativeStatus');
  let nativePending = false;
  let profilePending = false;
  let editedProfileId = null;
  async function readForeground(capture = false) {
    if (nativePending || (capture && (profilePending || !editedProfileId || editedProfileId === 'default'))) return;
    nativePending = true;
    if ($('btnNativeStatus')) $('btnNativeStatus').disabled = true;
    updateProfileControls();
    if (nativeStatus) nativeStatus.textContent = 'Consultando fonte foreground nativa…';
    try {
      const status = await window.cq.getNativeStatus();
      if (typeof status?.available !== 'boolean') throw new Error('Resposta nativa inválida.');
      if (!status.available || status.error) throw new Error(status.error || 'Fonte nativa indisponível.');
      const foreground = status.foreground;
      if (!foreground?.executablePath || foreground.errorCode) {
        throw new Error(`Aplicativo em foco sem caminho acessível${foreground?.errorCode ? ` (código ${foreground.errorCode})` : ''}.`);
      }
      if (nativeStatus) nativeStatus.textContent = `Fonte foreground nativa disponível. PID ${foreground.pid}: ${foreground.executablePath}`;
      if (capture) {
        if (!validProcessPath(foreground.executablePath)) throw new Error('O aplicativo em foco não tem caminho .exe válido.');
        if ($('profileProcessPath')) $('profileProcessPath').value = foreground.executablePath;
        if ($('profileStatus')) $('profileStatus').textContent = 'Caminho capturado. Confira e clique em Salvar associação.';
      }
    } catch (error) {
      if (nativeStatus) nativeStatus.textContent = `Não foi possível consultar a fonte foreground. ${error?.message || 'Falha de comunicação.'} Tente atualizar o status.`;
      if (capture && $('profileStatus')) $('profileStatus').textContent = 'Captura não realizada. Digite o caminho manualmente ou tente novamente.';
    } finally {
      nativePending = false;
      if ($('btnNativeStatus')) $('btnNativeStatus').disabled = false;
      updateProfileControls();
    }
  }
  if ($('btnNativeStatus')) $('btnNativeStatus').addEventListener('click', () => readForeground());
  if ($('btnCaptureForeground')) $('btnCaptureForeground').addEventListener('click', () => readForeground(true));

  function validProcessPath(path) {
    return !/[<>"|?*\x00-\x1f]/.test(path) && /^(?:[a-z]:\\|\\\\[^\\/:]+\\[^\\/:]+\\)(?:[^\\/:]+\\)*[^\\/:]+\.exe$/i.test(path);
  }
  function updateProfileControls() {
    const disabled = profilePending || !editedProfileId || editedProfileId === 'default';
    if ($('profileProcessPath')) $('profileProcessPath').disabled = disabled;
    if ($('profileHideCrosshairWhenUnfocused')) $('profileHideCrosshairWhenUnfocused').disabled = disabled;
    if ($('btnSaveProfile')) $('btnSaveProfile').disabled = disabled || nativePending;
    if ($('btnCaptureForeground')) $('btnCaptureForeground').disabled = disabled || nativePending;
  }
  if ($('btnSaveProfile')) $('btnSaveProfile').addEventListener('click', async () => {
    if (profilePending || nativePending || !editedProfileId || editedProfileId === 'default') return;
    const processPath = ($('profileProcessPath')?.value || '').trim();
    if (processPath && !validProcessPath(processPath)) {
      if ($('profileStatus')) $('profileStatus').textContent = 'Informe um caminho absoluto Windows terminado em .exe, ou deixe vazio para desvincular.';
      $('profileProcessPath')?.focus();
      return;
    }
    profilePending = true;
    updateProfileControls();
    if ($('profileStatus')) $('profileStatus').textContent = 'Salvando associação…';
    try {
      const saved = await window.cq.configureProfile({
        id: editedProfileId, processPath: processPath || null,
        hideCrosshairWhenUnfocused: !!processPath && !!$('profileHideCrosshairWhenUnfocused')?.checked,
      });
      if ($('profileProcessPath')) $('profileProcessPath').value = saved.process?.path || '';
      if ($('profileHideCrosshairWhenUnfocused')) $('profileHideCrosshairWhenUnfocused').checked = !!saved.hideCrosshairWhenUnfocused;
      if ($('profileStatus')) $('profileStatus').textContent = 'Associação salva.';
      await renderProfiles();
    } catch (error) {
      if ($('profileStatus')) $('profileStatus').textContent = `Não foi possível salvar a associação. ${error?.message || 'Tente novamente.'}`;
    } finally {
      profilePending = false;
      updateProfileControls();
    }
  });

  async function renderProfiles() {
    const list = $('profileList');
    if (!list || !isProfilePanelOpen()) return;
    try {
      const profiles = await window.cq.getProfiles();
      if (editedProfileId && !profiles.some((p) => p.id === editedProfileId)) {
        editedProfileId = null;
        if ($('profileAssociation')) $('profileAssociation').hidden = true;
        updateProfileControls();
      }
      list.innerHTML = '';
      const cur = state ? state.profiles?.currentProfileId : null;
      for (const p of profiles.sort((a, b) => a.name.localeCompare(b.name))) {
        const li = document.createElement('li');
        li.className = 'profile-entry' + (cur === p.id ? ' is-active' : '');
        li.innerHTML = `<div style="font-weight:600">${escapeHtml(profileLabel(p, p.id))}${cur === p.id ? ' <span class="profile-badge-active">ATIVO</span>' : ''}</div><div>${escapeHtml(p.id)}${p.process ? ` · ${escapeHtml(p.process.path || p.process.name)}${p.hideCrosshairWhenUnfocused ? ' · Ocultar sem foco' : ''}` : ' · Sem aplicativo vinculado'}</div>`;
        const actions = document.createElement('div');
        actions.className = 'profile-actions';
        const sw = document.createElement('button');
        sw.textContent = cur === p.id ? 'Ativo' : 'Usar';
        sw.className = 'btn' + (cur === p.id ? ' primary active' : '');
        sw.addEventListener('click', () => { window.cq.setProfile(p.id); renderProfiles(); });
        const d = document.createElement('button');
        d.textContent = 'Apagar'; d.className = 'btn danger';
        d.disabled = p.id === 'default';
        d.addEventListener('click', () => {
          if (p.id === 'default') return;
          const ok = typeof window.confirm === 'function' ? window.confirm(`Excluir o perfil "${profileLabel(p, p.id)}"?`) : false;
          if (!ok) return;
          window.cq.deleteProfile(p.id);
          setTimeout(renderProfiles, 60);
        });
        const rn = document.createElement('button');
        rn.textContent = 'Renomear'; rn.className = 'btn';
        rn.addEventListener('click', () => {
          openRenameModal({ isProfile: true, id: p.id, name: p.name || '' });
        });
        const configure = document.createElement('button');
        configure.textContent = 'Aplicativo'; configure.className = 'btn';
        configure.disabled = p.id === 'default';
        configure.setAttribute('aria-label', `Configurar aplicativo de ${profileLabel(p, p.id)}`);
        configure.addEventListener('click', () => {
          if (p.id === 'default' || profilePending || nativePending) return;
          editedProfileId = p.id;
          if ($('profileAssociation')) $('profileAssociation').hidden = false;
          if ($('profileAssociationTitle')) $('profileAssociationTitle').textContent = `Aplicativo do perfil: ${profileLabel(p, p.id)}`;
          if ($('profileProcessPath')) $('profileProcessPath').value = p.process?.path || '';
          if ($('profileHideCrosshairWhenUnfocused')) $('profileHideCrosshairWhenUnfocused').checked = !!p.hideCrosshairWhenUnfocused;
          if ($('profileStatus')) $('profileStatus').textContent = '';
          updateProfileControls();
          $('profileProcessPath')?.focus();
        });
        actions.append(sw, d, rn, configure);
        li.appendChild(actions);
        list.appendChild(li);
      }
    } catch (error) {
      if ($('profileStatus')) $('profileStatus').textContent = `Não foi possível atualizar os perfis. ${error?.message || 'Tente novamente.'}`;
    }
  }
  if ($('btnNewProfile')) $('btnNewProfile').addEventListener('click', () => {
    const n = ($('profileName')?.value || '').trim();
    if ($('profileName')) $('profileName').value = '';
    if (!n) return;
    window.cq.createProfile(n);
    setTimeout(renderProfiles, 60);
    if ($('profileStatus')) $('profileStatus').textContent = 'Perfil criado.';
  });
  updateProfileControls();

  // ---------- Topbar / updateHome ----------
  function updateHome() {
    if (!state) return;
    const map = state.profiles?.profiles;
    const current = map && state.profiles?.currentProfileId ? map[state.profiles.currentProfileId] : null;
    const chip = $('profileChipName');
    if (chip) chip.textContent = profileLabel(current, state.profiles?.currentProfileId || 'Padrão');
    const list = map ? Object.values(map) : [];
    const sp = $('statProfiles'); if (sp) sp.textContent = list.length ? String(list.length) : '–';
    const sl = $('statLinked'); if (sl) sl.textContent = String(list.filter((p) => p.process?.path).length);
    const hp = $('homeProfileName'); if (hp) hp.textContent = profileLabel(current, state.profiles?.currentProfileId || '–');
    const hpath = $('homeProfilePath'); if (hpath) hpath.textContent = current?.process?.path ? current.process.path : 'Sem app vinculado';
    const hms = $('homeModelSpec');
    if (hms) {
      const m = currentModel();
      hms.textContent = `cor ${m.color || '–'} · braços ${m.armLen ?? '–'} · ponto ${m.dot?.enabled ? (m.dot.size ?? '–') : 'off'}`;
    }
    const sv = $('statVersion'); if (sv) sv.textContent = '0.1.0';
    const cn = $('continueName'); if (cn) cn.textContent = profileLabel(current, 'Mira atual');
    const cs = $('continueSub'); if (cs) cs.textContent = current ? 'Perfil atual' : 'Comunidade local';
    paint($('modelPreview'), state, 8);
    paint($('visPreview'), state, 3.2, true);
    paint($('continuePreview'), state, 4.2, true);
    renderContinueDots();
    renderKeybinds();
  }
  function renderContinueDots() {
    const host = $('contDots');
    if (!host) return;
    host.innerHTML = '';
    const map = state?.profiles?.profiles;
    if (!map) return;
    const entries = Object.entries(map).slice(0, 5);
    for (const [id, profile] of entries) {
      const dot = document.createElement('i');
      if (id === state.profiles.currentProfileId) dot.className = 'on';
      dot.title = profile?.name || id;
      dot.addEventListener('click', () => { window.cq.setProfile(id); });
      host.appendChild(dot);
    }
  }

  // ---------- Live state from main ----------
  if (window.cq && typeof window.cq.onState === 'function') {
    window.cq.onState((s) => {
      if (s.validationError) toast(s.validationError);
      if (captureAttempt && s?.shortcutStatus?.error) {
        const attempted = shortcutAccelerator({ modifiers: captureAttempt.mods, key: captureAttempt.key });
        if (s.shortcutStatus.accelerator === attempted || !s.shortcutStatus.accelerator) {
          if (captureBackup && s.keybinds) set({ keybinds: { ...s.keybinds, globalShortcut: captureBackup } });
          toast(`Combinação indisponível (${s.shortcutStatus.error}); combinação anterior restaurada.`);
          captureAttempt = null;
          captureBackup = null;
        }
      }
      try { applyToDom(s); } catch (err) { console.error('[ui:applyToDom]', err); }
      try { renderProfiles(); } catch (err) { console.error('[ui:renderProfiles]', err); }
      try { forwardDesignerState(s); } catch (err) { console.error('[ui:forwardDesignerState]', err); }
    });
  }

  // ---------- Keyboard shortcuts ----------
  if (isApp) {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (capturingAction) {
        if (e.key === 'Escape') {
          capturingAction = null;
          toast('Captura cancelada.');
          renderKeybinds();
          return;
        }
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (e.metaKey) mods.push('Meta');
        const key = e.key === ' ' ? 'Space' : e.key;
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return;
        if (!GLOBAL_KEY_RE.test(key)) {
          toast(`Tecla não suportada: ${key}.`);
          capturingAction = null;
          renderKeybinds();
          return;
        }
        e.preventDefault();
        patchKeybind(capturingAction, { modifiers: mods, key });
        captureAttempt = { mods, key, backup: captureBackup };
        toast('Combinação enviada; confira o estado do registro global.');
        capturingAction = null;
        renderKeybinds();
        return;
      }
      if (e.key === 'Tab') {
        const modal = [$('renameModal'), $('importModal'), $('shareModal'), $('profileModal')]
          .find(m => m && typeof m.classList?.contains === 'function' && m.classList.contains('on'));
        if (modal && typeof modal.querySelectorAll === 'function') {
          const focusables = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter(el => !el.hidden && el.style?.display !== 'none');
          if (focusables.length > 0) {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      }
      if (e.key === 'Escape') {
        if ($('shareModal') && typeof $('shareModal').classList?.contains === 'function' && $('shareModal').classList.contains('on')) { closeShareModal(); return; }
        if ($('importModal') && typeof $('importModal').classList?.contains === 'function' && $('importModal').classList.contains('on')) { closeImportModal(); return; }
        if ($('renameModal') && typeof $('renameModal').classList?.contains === 'function' && $('renameModal').classList.contains('on')) { closeRenameModal(); return; }
        closeModal();
        return;
      }
      if (typing) return;
      if (currentRoute !== 'positions') return;
      if (posPrefs.scale !== 'off' && e.altKey && e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault();
        setScale(Number(state?.scale ?? 1) + (e.key === '-' ? -0.01 : 0.01));
        return;
      }
      if (posPrefs.position !== 'off' && e.altKey && e.shiftKey) {
        const map = posPrefs.position === 'wasd'
          ? { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' }
          : { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
        const dir = map[e.code];
        if (!dir) return;
        e.preventDefault();
        if (dir === 'left') setOffset('x', Number(state?.offsetX ?? 0) - 1);
        if (dir === 'right') setOffset('x', Number(state?.offsetX ?? 0) + 1);
        if (dir === 'up') setOffset('y', Number(state?.offsetY ?? 0) + 1);
        if (dir === 'down') setOffset('y', Number(state?.offsetY ?? 0) - 1);
      }
    }, true);
  }

  // ---------- Boot ----------
  applyLanguage(currentLang);
  setSlide(0);
  if (isApp) {
    const hash = String(window.location?.hash || '').replace(/^#\/?/, '');
    showPage(ROUTES.includes(hash) ? hash : 'crosshairs');
    window.addEventListener('hashchange', () => {
      const next = String(window.location?.hash || '').replace(/^#\/?/, '');
      showPage(ROUTES.includes(next) ? next : 'crosshairs');
    });
    renderLibrary();
    window.cq.getState().then((s) => {
      applyToDom(s);
      window.cq.getDisplays().then((displays) => {
        displaysCache = Array.isArray(displays) ? displays : [];
        fillDisplays();
      }).catch((error) => {
        if ($('profileStatus')) $('profileStatus').textContent = `Não foi possível carregar os monitores. ${error?.message || 'Reabra a janela para tentar novamente.'}`;
      });
      renderProfiles();
    }).catch((error) => {
      if ($('profileStatus')) $('profileStatus').textContent = `Não foi possível carregar a configuração. ${error?.message || 'Reabra a janela para tentar novamente.'}`;
    });
  } else {
    switchXTab('descobrir');
    renderLibrary();
  }
})();
