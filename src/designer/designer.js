// Designer renderer: layer editing with undo/redo + canvas navigation
// (anchored zoom, pan, select/move, resize handles) + right-panel properties.
// One file, no new deps. Regression DOM contracts (bodyLayer grid2, labels) kept.
(function () {
  'use strict';
  if (window.__cqDesignerBooted) return;
  window.__cqDesignerBooted = true;

  const L = window.CQLayers;
  const U = window.CQUndo;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
  const MAX_SHARE_CODE_LEN = 2 * 1024 * 1024;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const MODEL_DEFAULT = {
    armLength: 0, armThickness: 0, armSpacing: 14, armRotation: 0, armBlur: 0,
    armColor: '#FFFFFF', armShape: 'rect', armCount: 4, scale: 1,
  };

  // ---------- bridge: iframe dentro da janela principal ----------
  const inFrame = !!(window.parent && window.parent !== window);
  if (inFrame && !window.cq) {
    let seq = 0;
    const pending = new Map();
    const stateListeners = new Set();
    const post = (message) => window.parent.postMessage({ source: 'cq-designer', ...message }, '*');
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.source !== 'cq-parent') return;
      if (data.type === 'cq:state') {
        if (data.id !== undefined && pending.has(data.id)) {
          const entry = pending.get(data.id);
          pending.delete(data.id);
          entry.resolve(data.payload);
        } else {
          for (const fn of stateListeners) fn(data.payload);
        }
      } else if (data.type === 'cq:error' && data.id !== undefined && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        entry.reject(new Error(data.message || 'Falha na ponte com a janela principal.'));
      }
    });
    window.cq = {
      getState: () => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        post({ type: 'cq:getState', id });
      }),
      set: (patch) => post({ type: 'cq:set', payload: patch }),
      onState: (fn) => { stateListeners.add(fn); post({ type: 'cq:onState' }); },
      closeDesigner: () => { post({ type: 'cq:close' }); return true; },
    };
  }

  let layers = [];
  let selectedId = null;
  let currentProfileId;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let docReady = false;

  // ---------- own-document correlation (sem contador, sem anel) ----------
  // cq.set é fire-and-forget: a bridge não tem ack, então persist não promete
  // sucesso. Reconciliação é por igualdade de documento: broadcast igual ao
  // documento atual do renderer é no-op (eco próprio já em tela, ou externo
  // idêntico); diferente é atualização a aplicar — imediatamente, ou guardando
  // só a mais recente (broadcasts são FIFO) enquanto um gesto está ativo e
  // aplicando no fim do gesto. Mesmo eco igual substitui o anterior: igualdade
  // só se resolve no fim. Eco atrasado que difira fora do gesto é aplicado;
  // rejeição de set não deixa estado
  // pendente engolindo externos (defeito do contador anterior).
  let pendingExternal = null;
  let gestureDepth = 0;

  function deepEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  function canonicalLayers(list) { try { return L.validateLayers(list || []); } catch (e) { return null; } }
  function documentLayers(state) {
    if (!state || !Array.isArray(state.layers)) return null;
    return L.crosshairLayers(state);
  }
  function sameDocAsRenderer(state) {
    const incoming = documentLayers(state);
    return !!incoming && deepEqual(canonicalLayers(layers), canonicalLayers(normalizeAll(incoming)));
  }
  function beginGesture() { gestureDepth++; }
  function endGesture() {
    if (gestureDepth > 0) gestureDepth--;
    if (gestureDepth === 0 && pendingExternal) {
      const s = pendingExternal;
      pendingExternal = null;
      if (!sameDocAsRenderer(s)) applyState(s);
    }
  }
  function cancelGestures() {
    gestureDepth = 0;
    pendingExternal = null;
  }

  // ---------- model helpers ----------
  function persist() {
    window.cq.set({ layers, drawing: L.renderLayers(layers) });
  }
  function deepMerge(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else target[k] = v;
    }
  }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
  function setPathPatch(path, value) {
    const keys = path.split('.'); const patch = {}; let cur = patch;
    for (let i = 0; i < keys.length; i++) {
      cur[keys[i]] = i === keys.length - 1 ? value : {};
      cur = cur[keys[i]];
    }
    return patch;
  }
  function normalizeLayer(l) {
    if (!l || l.type !== 'model') return l;
    if (l.armLength === undefined) l.armLength = l.armLen ?? MODEL_DEFAULT.armLength;
    if (l.armThickness === undefined) l.armThickness = l.armThick ?? MODEL_DEFAULT.armThickness;
    if (l.armSpacing === undefined) l.armSpacing = l.gap ?? MODEL_DEFAULT.armSpacing;
    if (l.armRotation === undefined) l.armRotation = MODEL_DEFAULT.armRotation;
    if (l.armBlur === undefined) l.armBlur = MODEL_DEFAULT.armBlur;
    if (l.armColor === undefined) l.armColor = MODEL_DEFAULT.armColor;
    if (l.armShape === undefined) l.armShape = MODEL_DEFAULT.armShape;
    if (l.armCount === undefined) l.armCount = MODEL_DEFAULT.armCount;
    if (l.scale === undefined) l.scale = MODEL_DEFAULT.scale;
    if (l.dot) { if (l.dot.size === undefined) l.dot.size = 4; if (l.dot.blur === undefined) l.dot.blur = 0; if (l.dot.color === undefined) l.dot.color = '#FFFFFF'; }
    if (l.outline) { if (l.outline.width === undefined) l.outline.width = 1; if (l.outline.blur === undefined) l.outline.blur = 0; if (l.outline.color === undefined) l.outline.color = '#000000'; }
    if (!l.firingOptions) {
      l.firingOptions = { trigger: 'none', pressType: 'press', direction: 'normal', easing: 'ease-out', loop: false, startDelay: 0, duration: 300, stages: [] };
    }
    if (!Array.isArray(l.firingOptions.stages)) l.firingOptions.stages = [];
    return l;
  }
  function normalizeAll(list) { for (const l of list || []) normalizeLayer(l); return list; }

  // ---------- actions / undo ----------
  function applyAction(action) {
    switch (action.type) {
      case 'update':
        for (const [id, patch] of action.patches) {
          const l = layers.find((x) => x.id === id);
          if (l) deepMerge(l, patch);
        }
        break;
      case 'add':
        for (let i = action.items.length - 1; i >= 0; i--) layers.splice(Math.max(0, action.indices[i]), 0, action.items[i]);
        break;
      case 'delete':
        for (const item of action.items) {
          const i = layers.findIndex((l) => l.id === item.id);
          if (i !== -1) layers.splice(i, 1);
        }
        break;
      case 'reorder': {
        const [moved] = layers.splice(action.from, 1);
        layers.splice(action.to, 0, moved);
        break;
      }
    }
    persist();
    renderAll();
  }
  function doAction(action) {
    U.pushUndo(U.computeInverse(action, layers));
    applyAction(action);
  }
  function update(id, patch) { doAction({ type: 'update', patches: new Map([[id, patch]]) }); }
  function undo() {
    if (!U.canUndo()) return;
    const inverse = U.popUndo();
    const redoAction = U.computeInverse(inverse, layers);
    applyAction(inverse);
    U.pushRedo(redoAction);
  }
  function redo() {
    if (!U.canRedo()) return;
    const action = U.popRedo();
    const undoInverse = U.computeInverse(action, layers);
    applyAction(action);
    U.pushUndoFromRedo(undoInverse);
  }
  const selected = () => layers.find((x) => x.id === selectedId) || null;

  // ---------- icons ----------
  const IC = {
    length: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/></svg>',
    thick: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg>',
    gap: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 5v14M18 5v14"/></svg>',
    rot: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
    dot: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>',
    bubble: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 3C6 3 2 6.8 2 11.5c0 2.1.9 4 2.4 5.5L3 21l4.5-1.8c1.2.5 2.6.8 4 .8C17 20 21 16.2 21 11.5S17 3 11.5 3Z"/></svg>',
    w: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/></svg>',
    h: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18"/></svg>',
    text: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6V4h14v2M12 4v16m-3 0h6"/></svg>',
    size: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 9V4h5M21 9V4h-5M3 15v5h5M21 15v5h-5"/></svg>',
    blur: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/><circle cx="12" cy="12" r="3"/></svg>',
  };
  const esc = (s) => L.escapeXml?.(String(s)) ?? String(s);

  // ---------- section lookup (markup pode mudar de ids) ----------
  function secBody(id, words) {
    const byId = $(id);
    if (byId) return byId;
    try {
      for (const s of document.querySelectorAll('.sec')) {
        const title = s.querySelector('.sec-title')?.textContent?.toLowerCase() || '';
        if (words.some((w) => title.includes(w))) {
          const b = s.querySelector('.sec-body');
          if (b) return b;
        }
      }
    } catch (e) { /* markup diferente: secao sem container */ }
    return null;
  }
  const secEl = (id, words) => {
    const byId = $(id);
    if (byId) return byId;
    try {
      for (const s of document.querySelectorAll('.sec')) {
        const title = s.querySelector('.sec-title')?.textContent?.toLowerCase() || '';
        if (words.some((w) => title.includes(w))) return s;
      }
    } catch (e) {}
    return null;
  };
  const add = (body, node) => { if (body && node) body.appendChild(node); };

  // ---------- numeric field (typing + scrub) ----------
  const registeredFields = [];
  const displayOf = (v, pct) => (v === undefined || v === null ? 0 : pct ? Math.round(Number(v) * 100) : v);
  function numField(label, path, { min, max, step, icon, pct } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'frow chkrow';
    let fl = null;
    if (label !== null) {
      fl = document.createElement('label'); fl.className = 'fl'; fl.textContent = label; fl.style.cursor = 'ew-resize'; wrap.appendChild(fl);
    }
    const f = document.createElement('div'); f.className = 'nfield';
    f.innerHTML = icon ? `<span class="ic">${icon}</span><input type="number" min="${min}" max="${max}" step="${step}">` : '<input type="number">';
    const input = f.querySelector('input');
    input.setAttribute('aria-label', label ?? path.toUpperCase());
    const l0 = selected();
    if (l0) input.value = displayOf(getPath(l0, path), pct);
    registeredFields.push({ type: 'num', path, input, pct, min, max, step });
    input.addEventListener('change', () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) return;
      v = Math.min(max ?? 1e9, Math.max(min ?? -1e9, v));
      if (pct) {
        v = Math.max(0.05, Math.min(1, v / 100));
        v = Number(v.toFixed(4));
      } else if (step) {
        const decimals = (String(step).split('.')[1] || '').length;
        v = Number(v.toFixed(Math.min(decimals, 6)));
      }
      const l = selected();
      if (l) update(l.id, setPathPatch(path, v));
    });
    input.addEventListener('blur', () => {
      // blur sincroniza: rascunho não confirmado volta a refletir o documento.
      const l = selected();
      if (l) input.value = displayOf(getPath(l, path), pct);
    });
    let scrubbing = false, startX = 0, startV = 0, capturedEl = null;
    let scrubLayerId = null, scrubProfileId = null;
    const winScrubListeners = [];
    const scrubLayer = () => scrubProfileId === currentProfileId
      ? layers.find((x) => x.id === scrubLayerId) || null
      : null;
    const startScrub = (e) => {
      const l = selected();
      if (!l) return;
      scrubbing = true; startX = e.clientX;
      scrubLayerId = l.id; scrubProfileId = currentProfileId;
      const cur = getPath(l, path);
      startV = pct ? ((Number(cur ?? 1) * 100) || 0) : Number(cur ?? 0);
      input.value = startV;
      capturedEl = e.currentTarget || f;
      document.body.classList.add('dragging');
      beginGesture();
      // Listeners de janela nascem com o gesto e morrem com ele: reconstrução do
      // painel não pode acumular endScrub órfãos consultando seleção alheia.
      winScrubListeners.push(['pointerup', endScrub], ['pointercancel', endScrub], ['blur', endScrub]);
      for (const [type, fn] of winScrubListeners) window.addEventListener(type, fn);
      // lostpointercapture no elemento capturado cobre campo e label.
      capturedEl.addEventListener?.('lostpointercapture', endScrub);
      // Pointer pode ter sido solto entre down e capture; o gesto segue pelos
      // listeners de janela já registrados.
      try { capturedEl.setPointerCapture?.(e.pointerId); } catch (e2) { /* já solto */ }
      if (typeof e.preventDefault === 'function') e.preventDefault();
    };
    f.addEventListener('pointerdown', (e) => {
      if (e.target === input || e.target === fl) return; // label já iniciou/capturou este pointerdown
      startScrub(e);
    });
    if (fl) fl.addEventListener('pointerdown', startScrub);

    const onMove = (e) => {
      if (!scrubbing) return;
      const l = scrubLayer();
      if (!l) { endScrub(); return; } // camada removida ou perfil trocado: cancela
      const dx = e.clientX - startX;
      let v;
      if (pct) {
        v = Math.min(1, Math.max(0.05, startV / 100 + dx / 400));
        v = Number(v.toFixed(4));
        deepMerge(l, setPathPatch(path, v));
        input.value = Math.round(v * 100);
      } else {
        const span = (max ?? 100) - (min ?? 0);
        v = Math.max(min ?? -1e9, Math.min(max ?? 1e9, startV + dx * (Math.max(span, 10) / 400)));
        const s = step ?? 1;
        v = Math.round(v / s) * s;
        const decimals = (String(s).split('.')[1] || '').length;
        v = Number(v.toFixed(Math.min(decimals, 6)));
        const keys = path.split('.'); let t = l;
        for (let i = 0; i < keys.length - 1; i++) t = t?.[keys[i]];
        if (t) t[keys[keys.length - 1]] = v;
        input.value = v;
      }
      renderPreview(); positionSel(); persist();
    };
    f.addEventListener('pointermove', onMove);
    if (fl) fl.addEventListener('pointermove', onMove);

    const endScrub = () => {
      if (!scrubbing) return; // idempotente: pointerup/lostpointercapture/blur convergem aqui
      scrubbing = false;
      for (const [type, fn] of winScrubListeners) window.removeEventListener(type, fn);
      winScrubListeners.length = 0;
      capturedEl?.removeEventListener?.('lostpointercapture', endScrub);
      document.body.classList.remove('dragging');
      endGesture(); // aplica atualização externa diferida antes de gravar o gesto
      const layer = scrubLayer(); // lookup fresco: flush pode ter trocado os objetos
      scrubLayerId = null;
      scrubProfileId = null;
      if (!layer) return; // origem sumiu (remoção/troca de perfil): cancela sem Undo falso
      const finalV = getPath(layer, path);
      input.value = pct ? Math.round((finalV ?? 1) * 100) : finalV;
      if (finalV !== undefined) {
        const initV = pct ? startV / 100 : startV;
        if (finalV !== initV) {
          deepMerge(layer, setPathPatch(path, initV));
          U.endDebounce();
          update(layer.id, setPathPatch(path, finalV));
          U.endDebounce();
        }
      }
    };
    f.addEventListener('pointerup', endScrub);
    f.addEventListener('pointercancel', endScrub);
    if (fl) {
      fl.addEventListener('pointerup', endScrub);
      fl.addEventListener('pointercancel', endScrub);
    }
    wrap.appendChild(f);
    return wrap;
  }

  // ---------- field helpers ----------
  function rowSwitch(label, path) {
    const row = document.createElement('div'); row.className = 'frow chkrow';
    const lb = document.createElement('label'); lb.className = 'fl'; lb.textContent = label; lb.style.cursor = 'pointer'; row.appendChild(lb);
    const sw = document.createElement('label'); sw.className = 'switchm';
    sw.innerHTML = '<input type="checkbox"><span class="t"></span>';
    const input = sw.querySelector('input');
    input.addEventListener('change', () => { const l = selected(); if (l) update(l.id, setPathPatch(path, input.checked)); });
    registeredFields.push({ type: 'switch', path, input });
    row.appendChild(sw);
    return { row, input };
  }
  function colorRow(path) {
    const row = document.createElement('div'); row.className = 'crow';
    row.innerHTML = `<span class="swatch"><input type="color" aria-label="Cor"></span><input class="hex" spellcheck="false"><span class="divv"></span><input class="op" aria-label="Opacidade" spellcheck="false">`;
    const color = row.querySelector('input[type=color]'); const hex = row.querySelector('input.hex');
    hex.setAttribute('aria-label', `Cor hexadecimal: ${path}`);
    const op = row.querySelector('input.op');
    op.setAttribute('aria-label', 'Opacidade');
    op.value = '100%';
    op.addEventListener('change', () => {
      const pct = Number.parseFloat(String(op.value).replace('%', ''));
      if (!Number.isFinite(pct)) { op.value = '100%'; return; }
      const v = Math.min(1, Math.max(0.05, pct / 100));
      op.value = `${Math.round(v * 100)}%`;
      const l = selected(); if (l) update(l.id, { opacity: v });
    });
    const sync = (v) => {
      color.value = v; hex.value = (v || '#ffffff').toUpperCase();
      const l = selected(); if (l) op.value = `${Math.round((l.opacity ?? 1) * 100)}%`;
    };
    hex.addEventListener('change', () => {
      const v = hex.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) { color.value = v; apply(v); } else sync(color.value || '#ffffff');
    });
    function apply(v) { hex.value = v.toUpperCase(); const l = selected(); if (l) update(l.id, setPathPatch(path, v)); }
    color.addEventListener('input', () => apply(color.value));
    color.addEventListener('change', () => { const l = selected(); if (l) update(l.id, setPathPatch(path, color.value)); });
    registeredFields.push({ type: 'color', path, sync });
    return { row, sync };
  }
  function bigSelect(label, path, opts) {
    const wrap = document.createElement('div'); wrap.className = 'frow';
    const sel = document.createElement('select'); sel.className = 'fselNative'; sel.setAttribute('aria-label', label);
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    const l = selected();
    if (l) sel.value = String(getPath(l, path) ?? opts[0][0]);
    sel.addEventListener('change', () => { const cur = selected(); if (cur) update(cur.id, setPathPatch(path, sel.value)); });
    registeredFields.push({ type: 'select', path, sel });
    wrap.appendChild(sel);
    return wrap;
  }
  function textRow(label, path) {
    const row = document.createElement('div'); row.className = 'crow';
    row.innerHTML = `<input type="text" spellcheck="false" style="width:100%">`;
    const input = row.querySelector('input');
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => { const l = selected(); if (l) update(l.id, setPathPatch(path, input.value)); });
    input.addEventListener('blur', () => { const l = selected(); if (l) input.value = getPath(l, path) ?? ''; });
    registeredFields.push({ type: 'text', path, input });
    return { row, input };
  }
  function dimNote(body, msg) {
    const p = document.createElement('p'); p.className = 'sec-note'; p.style.padding = '0 6px'; p.textContent = msg; add(body, p);
  }

  // ---------- right panel ----------
  let renderedPropsLayerId = null;
  let renderedPropsLayerType = null;
  function syncPropsValues(l) {
    for (const f of registeredFields) {
      if (f.type === 'color') {
        const v = getPath(l, f.path);
        f.sync(v || '#ffffff');
      } else if (f.type === 'select') {
        // select/switch commitam no próprio change: não existe rascunho pendente,
        // o documento (Undo/Redo incluído) sempre vence, mesmo com foco.
        const v = getPath(l, f.path);
        if (v !== undefined) f.sel.value = String(v);
      } else if (f.type === 'switch') {
        f.input.checked = !!getPath(l, f.path);
      } else if (f.type === 'text') {
        if (f.input !== document.activeElement) {
          f.input.value = getPath(l, f.path) ?? '';
        }
      } else if (f.type === 'num') {
        if (f.input !== document.activeElement) {
          f.input.value = displayOf(getPath(l, f.path), f.pct);
        }
      }
    }
  }

  let renderingProps = false;
  function renderProps() {
    if (renderingProps) return;
    renderingProps = true;
    try {
    const l = selected();
    const title = $('layerTitleSide');
    if (title.readOnly || title.dataset.renameLayer !== l?.id || title.dataset.renameProfile !== currentProfileId) {
      title.readOnly = true;
      title.value = l?.name || l?.type || '';
    }
    syncAnimPanel(l);

    if (!l) {
      renderedPropsLayerId = null;
      renderedPropsLayerType = null;
      registeredFields.length = 0;
      const bC = secBody('bodyLayer', ['posi', 'camada']);
      const bL = secBody('bodyLinhas', ['linha']);
      const bD = secBody('bodyDot', ['ponto']);
      const bO = secBody('bodyOutline', ['contorno']);
      for (const b of [bC, bL, bD, bO]) if (b) b.innerHTML = '';
      dimNote(bC, 'Sem camada selecionada.');
      $('layerTitle').textContent = '-';
      $('layerTitleSide').value = '';
      positionSel(); return;
    }

    if (renderedPropsLayerId === l.id && renderedPropsLayerType === l.type) {
      syncPropsValues(l);
      positionSel();
      return;
    }

    renderedPropsLayerId = l.id;
    renderedPropsLayerType = l.type;
    registeredFields.length = 0;

    const bC = secBody('bodyLayer', ['posi', 'camada']);
    const bL = secBody('bodyLinhas', ['linha']);
    const bD = secBody('bodyDot', ['ponto']);
    const bO = secBody('bodyOutline', ['contorno']);
    for (const b of [bC, bL, bD, bO]) if (b) b.innerHTML = '';
    const lnNote = $('lnNote'); if (lnNote) lnNote.textContent = '';
    const olNote = $('olNote'); if (olNote) olNote.textContent = '';
    for (const id of ['secLinhas', 'secDot', 'secOutline']) { const s = $(id); if (s) s.dataset.dim = ''; }
    normalizeLayer(l);
    const typeName = ({ model: 'Mira', shape: 'Forma', text: 'Texto', image: 'Imagem', draw: 'Desenho' }[l.type] || 'Camada');
    const name = l.name || typeName;
    $('layerTitle').textContent = name;
    if (title.readOnly) title.value = name;

    // POSICAO
    const pg = document.createElement('div'); pg.className = 'grid2';
    pg.appendChild(numField(null, 'x', { min: -200, max: 200, step: 1, icon: IC.w }));
    pg.appendChild(numField(null, 'y', { min: -200, max: 200, step: 1, icon: IC.h }));
    add(bC, pg);
    add(bC, numField('Escala', 'scale', { min: 0.2, max: 8, step: 0.1, icon: IC.size }));
    if (l.type === 'shape' || l.type === 'image' || l.type === 'draw') {
      const gr = document.createElement('div'); gr.className = 'grid2';
      gr.appendChild(numField('W', 'w', { min: 1, max: 300, step: 1, icon: IC.w }));
      gr.appendChild(numField('H', 'h', { min: 1, max: 300, step: 1, icon: IC.h }));
      add(bC, gr);
      add(bC, numField('Rotação', 'rotation', { min: 0, max: 360, step: 1, icon: IC.rot }));
    }
    if (l.type === 'text') {
      const t = textRow('Texto', 'text'); t.input.value = l.text ?? ''; add(bC, t.row);
      add(bC, numField('Tamanho', 'fontSize', { min: 4, max: 120, step: 1, icon: IC.size }));
      add(bC, numField('Rotação', 'rotation', { min: 0, max: 360, step: 1, icon: IC.rot }));
    }

    // LINHAS
    if (l.type === 'model') {
      add(bL, bigSelect('Estilo', 'armShape', [['rect', 'Retângulo'], ['triangle', 'Triângulo'], ['chevron', 'Seta']]));
      const c = colorRow('armColor'); c.sync(l.armColor || '#FFFFFF'); c.row.style.width = 'calc(100% - 12px)'; c.row.style.margin = '8px 6px'; add(bL, c.row);
      const gr = document.createElement('div'); gr.className = 'grid2';
      gr.appendChild(numField('Comprimento', 'armLength', { min: 0, max: 60, step: 1, icon: IC.length }));
      gr.appendChild(numField('Espessura', 'armThickness', { min: 0, max: 20, step: 1, icon: IC.thick }));
      gr.appendChild(numField('Espaçamento', 'armSpacing', { min: 0, max: 40, step: 1, icon: IC.gap }));
      gr.appendChild(numField('Rotação', 'armRotation', { min: 0, max: 360, step: 1, icon: IC.rot }));
      add(bL, gr);
      // desfoque retirado do compilador e da UI; valores antigos preservados nos dados
    } else dimNote(bL, 'Sem linhas para este tipo.');

    // PONTO CENTRAL
    if (l.type === 'model') {
      add(bD, bigSelect('Estilo', 'dot.shape', [['circle', 'Círculo'], ['square', 'Quadrado'], ['diamond', 'Losango'], ['ring', 'Anel']]));
      const dc = colorRow('dot.color'); dc.sync(l.dot?.color || '#FFFFFF'); dc.row.style.margin = '8px 6px'; add(bD, dc.row);
      add(bD, numField('Diâmetro', 'dot.size', { min: 0, max: 20, step: 1, icon: IC.dot }));
      // desfoque retirado do compilador e da UI; valores antigos preservados nos dados
    } else { const s = secEl('secDot', ['ponto']); if (s) s.dataset.dim = '1'; dimNote(bD, 'Sem ponto para este tipo.'); }

    // CONTORNO
    if (l.type === 'model') {
      const oc = colorRow('outline.color'); oc.sync(l.outline?.color || '#000000'); oc.row.style.margin = '8px 6px'; add(bO, oc.row);
      add(bO, numField('Espessura', 'outline.width', { min: 0, max: 5, step: 0.5, icon: IC.thick }));
      // desfoque retirado do compilador e da UI; valores antigos preservados nos dados
    } else if (l.type === 'shape') {
      const sc = colorRow('stroke.color'); sc.sync(l.stroke?.color || '#000000'); sc.row.style.margin = '8px 6px'; add(bO, sc.row);
      add(bO, numField('Espessura', 'stroke.width', { min: 0, max: 5, step: 0.5, icon: IC.thick }));
    } else { const s = secEl('secOutline', ['contorno']); if (s) s.dataset.dim = '1'; dimNote(bO, 'Sem contorno para este tipo.'); }
    positionSel();
    } finally { renderingProps = false; }
  }

  // ---------- anim panel ----------
  const seconds = (ms) => (ms / 1000).toFixed(2);
  function timingMs(input) {
    if (!String(input.value).trim()) return null;
    const value = Number(String(input.value).replace(',', '.'));
    return Number.isFinite(value) ? Math.round(clamp(value, Number(input.min), Number(input.max)) * 1000) : null;
  }
  let apStagesHost = null;
  const AP_FIELDS = [
    ['apTrigger', 'firingOptions.trigger'],
    ['apPress', 'firingOptions.pressType'],
    ['apRelease', 'firingOptions.releaseBehavior'],
    ['apDir', 'firingOptions.direction'],
    ['apEase', 'firingOptions.easing'],
  ];
  function syncAnimPanel(l) {
    const disabled = !l;
    for (const [id, path] of AP_FIELDS) {
      const el = $(id); if (!el) continue;
      el.disabled = disabled;
      if (l) el.value = String(getPath(l, path) ?? (id === 'apRelease' ? '' : el.value));
    }
    const delay = $('apDelay'), dur = $('apDur'), lo = $('apLoop');
    if (delay) delay.disabled = disabled;
    if (dur) dur.disabled = disabled;
    if (lo) lo.disabled = disabled;
    if (l) {
      if (delay) delay.value = seconds(l.firingOptions?.startDelay ?? 0);
      if (dur) dur.value = seconds(l.firingOptions?.duration ?? 300);
      if (lo) lo.value = l.firingOptions?.loop ? 'on' : 'off';
      $('stageAdd').disabled = false;
      $('apMs').textContent = `${Math.round(l.firingOptions?.duration ?? 300)}ms`;
      const total = (l.firingOptions?.duration ?? 300) + (l.firingOptions?.startDelay ?? 0)
        + (l.firingOptions?.stages || []).reduce((a, s) => a + (s.duration || 0) + (s.delay || 0), 0);
      $('apTotalMs').textContent = `${Math.round(total)}ms`;
      $('apMs').style.backgroundSize = `${total ? (l.firingOptions?.duration ?? 300) / total * 100 : 0}% 100%`;
      const hasEffects = (l.firingOptions?.stages || []).some(s => s.effects?.length);
      $('apFx').textContent = hasEffects ? 'Efeitos configurados' : 'Sem efeitos';
    } else {
      $('stageAdd').disabled = true;
      $('apMs').textContent = '-'; $('apTotalMs').textContent = '-'; $('apFx').textContent = 'Sem camada';
    }
    renderStages(l);
  }
  // Overrides cumulativos por estágio: { property, to } (limites idênticos ao layers.js).
  const FX_LIMITS = { scale: [0.05, 8], opacity: [0, 1], x: [-200, 200], y: [-200, 200], rotation: [-360, 360] };
  const FX_OPTIONS = [['scale', 'Escala'], ['opacity', 'Opacidade'], ['x', 'X'], ['y', 'Y'], ['rotation', 'Rotacao']];
  function effectRow(l, list, j, stageNo) {
    const editEffect = (edit) => commitAnim(l, fo => edit(fo.stages[stageNo - 1].effects));
    const row = document.createElement('div'); row.className = 'ap-field'; row.style.marginLeft = '14px';
    const sel = document.createElement('select'); sel.className = 'fselNative'; sel.setAttribute('aria-label', `Propriedade efeito ${stageNo}.${j + 1}`);
    for (const [v, t] of FX_OPTIONS) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    sel.value = list[j].property;
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.05'; inp.setAttribute('aria-label', `Valor efeito ${stageNo}.${j + 1}`);
    const sync = () => { const [min, max] = FX_LIMITS[list[j].property]; inp.min = String(min); inp.max = String(max); inp.value = String(list[j].to); };
    sync();
    sel.addEventListener('change', () => {
      const [min, max] = FX_LIMITS[sel.value] || FX_LIMITS.scale;
      editEffect(effects => {
        effects[j].property = sel.value;
        effects[j].to = clamp(effects[j].to, min, max);
      });
    });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { sync(); return; }
      const [min, max] = FX_LIMITS[list[j].property];
      editEffect(effects => { effects[j].to = clamp(v, min, max); });
    });
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'x'; rm.setAttribute('aria-label', `Remover efeito ${stageNo}.${j + 1}`);
    rm.addEventListener('click', () => editEffect(effects => effects.splice(j, 1)));
    row.appendChild(sel); row.appendChild(inp); row.appendChild(rm);
    return row;
  }
  function renderStages(l) {
    let host = apStagesHost;
    if (!host) {
      const panel = $('animPanel');
      if (!panel) return;
      host = document.createElement('div');
      panel.appendChild(host);
      apStagesHost = host;
    }
    host.innerHTML = '';
    const stages = l?.firingOptions?.stages || [];
    stages.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'ap-field';
      const name = document.createElement('span'); name.className = 'fl'; name.textContent = `Estágio ${i + 1}`;
      row.appendChild(name);
      const badge = document.createElement('span'); badge.textContent = `${s.duration ?? 300}ms`; badge.className = 'ap-duration';
      const total = (l.firingOptions.duration ?? 300) + (l.firingOptions.startDelay ?? 0) + stages.reduce((sum, st) => sum + (st.delay || 0) + (st.duration ?? 300), 0);
      badge.style.background = 'linear-gradient(var(--green-line), var(--green-line)) no-repeat';
      badge.style.backgroundSize = `${total ? (s.duration ?? 300) / total * 100 : 0}% 100%`;
      row.appendChild(badge);
      const d = document.createElement('input'); d.type = 'number'; d.min = '0'; d.max = '60'; d.step = '0.01'; d.value = seconds(s.delay ?? 0); d.setAttribute('aria-label', `Atraso estágio ${i + 1} (s)`);
      d.addEventListener('change', () => { const value = timingMs(d); if (value === null) { d.value = seconds(s.delay ?? 0); return; } commitAnim(l, fo => { fo.stages[i].delay = value; }); });
      const dur = document.createElement('input'); dur.type = 'number'; dur.min = '0'; dur.max = '60'; dur.step = '0.01'; dur.value = seconds(s.duration ?? 300); dur.setAttribute('aria-label', `Duração estágio ${i + 1} (s)`);
      dur.addEventListener('change', () => { const value = timingMs(dur); if (value === null) { dur.value = seconds(s.duration ?? 300); return; } commitAnim(l, fo => { fo.stages[i].duration = value; }); });
      const ease = document.createElement('select'); ease.setAttribute('aria-label', `Suavizacao estágio ${i + 1}`);
      for (const v of ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']) { const o = document.createElement('option'); o.value = v; o.textContent = v; ease.appendChild(o); }
      ease.value = s.easing || 'ease-out';
      ease.addEventListener('change', () => commitAnim(l, fo => { fo.stages[i].easing = ease.value; }));
      const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'x'; rm.setAttribute('aria-label', `Remover estágio ${i + 1}`);
      rm.addEventListener('click', () => commitAnim(l, fo => fo.stages.splice(i, 1)));
      row.appendChild(d); row.appendChild(dur); row.appendChild(ease); row.appendChild(rm);
      host.appendChild(row);
      const list = Array.isArray(s.effects) ? s.effects : [];
      if (!list.length) {
        const none = document.createElement('p'); none.className = 'sec-note'; none.style.marginLeft = '14px'; none.textContent = 'Sem efeitos';
        host.appendChild(none);
      } else {
        list.forEach((fx, j) => host.appendChild(effectRow(l, list, j, i + 1)));
      }
      const addFx = document.createElement('button'); addFx.type = 'button'; addFx.textContent = '+ efeito'; addFx.title = 'Adicionar override de propriedade'; addFx.setAttribute('aria-label', `Adicionar efeito estágio ${i + 1}`);
      addFx.style.margin = '2px 6px 6px 14px';
      addFx.disabled = list.length >= 8;
      addFx.addEventListener('click', () => {
        if (list.length >= 8) return;
        commitAnim(l, fo => { (fo.stages[i].effects ??= []).push({ property: 'scale', to: 1 }); });
      });
      host.appendChild(addFx);
    });
  }
  function commitAnim(l, edit) {
    if (!l) return;
    const firingOptions = JSON.parse(JSON.stringify(l.firingOptions));
    edit(firingOptions);
    update(l.id, { firingOptions });
  }
  function bindAnimPanel() {
    const applyBy = (specEl, path) => { const l = selected(); if (l) update(l.id, setPathPatch(path, specEl.value)); };
    $('apTrigger').addEventListener('change', (e) => applyBy(e.target, 'firingOptions.trigger'));
    $('apPress').addEventListener('change', (e) => applyBy(e.target, 'firingOptions.pressType'));
    $('apRelease').addEventListener('change', (e) => { const l = selected(); if (l) update(l.id, setPathPatch('firingOptions.releaseBehavior', e.target.value || (l.firingOptions.pressType === 'hold' ? 'reset' : undefined))); });
    $('apDir').addEventListener('change', (e) => applyBy(e.target, 'firingOptions.direction'));
    $('apEase').addEventListener('change', (e) => applyBy(e.target, 'firingOptions.easing'));
    $('apLoop').addEventListener('change', (e) => { const l = selected(); if (l) update(l.id, setPathPatch('firingOptions.loop', e.target.value === 'on')); });
    for (const [id, path] of [['apDelay', 'firingOptions.startDelay'], ['apDur', 'firingOptions.duration']]) {
      $(id).addEventListener('change', (e) => {
        const n = timingMs(e.target);
        const l = selected();
        if (n === null) { if (l) e.target.value = seconds(getPath(l, path) ?? 0); return; }
        if (l) update(l.id, setPathPatch(path, n));
      });
    }
    $('stageAdd').addEventListener('click', () => {
      const l = selected();
      if (!l) return;
      commitAnim(l, fo => fo.stages.push({ delay: 0, duration: 300, easing: 'ease-out', effects: [] }));
    });
  }

  // ---------- layer list ----------
  let draggedLayerId = null;
  function focusLayer(id) { for (const row of $('layers').children) if (row.dataset.id === id) row.focus(); }
  function bindRename(input, layerId) {
    input.readOnly = true;
    input.title = 'Duplo clique ou F2 para renomear';
    input.setAttribute('aria-label', 'Nome da camada');
    let editingId = null;
    const finish = (apply) => {
      if (input.readOnly) return;
      input.readOnly = true; // Latch before update/render can dispatch blur again.
      const l = layers.find(x => x.id === editingId);
      editingId = null;
      const name = input.value.trim();
      if (apply && input.dataset.renameProfile === currentProfileId && l && name && name.length <= 200 && name !== l.name) update(l.id, { name });
      else input.value = l?.name || l?.type || '';
    };
    const begin = () => {
      editingId = layerId();
      input.dataset.renameLayer = editingId;
      input.dataset.renameProfile = currentProfileId;
      input.readOnly = false; input.focus(); input.select?.();
    };
    input.addEventListener('dblclick', (e) => { e.stopPropagation(); begin(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'F2') { e.preventDefault(); begin(); }
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(e.key === 'Enter'); input.blur(); }
    });
    input.addEventListener('blur', () => finish(true));
    return begin;
  }
  function renderLayerList() {
    const ul = $('layers'); ul.innerHTML = '';
    for (const l of [...layers].reverse()) {
      const li = document.createElement('li');
      li.dataset.id = l.id;
      if (l.id === selectedId) li.classList.add('sel');
      if (l.visible === false) li.classList.add('off');
      const thumb = document.createElement('span'); thumb.className = 'thumb';
      thumb.innerHTML = ({ model: IC.dot, shape: IC.length, text: IC.text, image: IC.w, draw: IC.thick }[l.type] || '');
      const nm = document.createElement('input'); nm.type = 'text'; nm.className = 'name'; nm.value = l.name || l.type;
      const beginRename = bindRename(nm, () => l.id);
      li.draggable = true; li.tabIndex = 0;
      li.setAttribute('aria-label', `Camada ${l.name || l.type}`);
      li.setAttribute('aria-roledescription', 'ordenável');
      li.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown F2');
      li.addEventListener('dragstart', (e) => {
        if (e.target.closest?.('input, button') || !nm.readOnly) { e.preventDefault(); return; }
        draggedLayerId = l.id;
        e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => { draggedLayerId = null; });
      li.addEventListener('dragover', (e) => { if (draggedLayerId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = layers.findIndex(x => x.id === draggedLayerId);
        const to = layers.findIndex(x => x.id === l.id);
        draggedLayerId = null;
        if (from < 0 || to < 0 || from === to) return;
        selectedId = layers[from].id;
        doAction({ type: 'reorder', from, to });
        focusLayer(selectedId);
      });
      li.addEventListener('keydown', (e) => {
        if (e.target !== li) return;
        if (e.key === 'F2') { e.preventDefault(); beginRename(); }
        else if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); selectedId = l.id;
          reorder(e.key === 'ArrowUp' ? 1 : -1); focusLayer(l.id);
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedId = l.id; renderAll(); focusLayer(l.id); }
      });
      const eye = document.createElement('button'); eye.type = 'button'; eye.className = 'lbtn eye'; eye.title = l.visible === false ? 'Mostrar camada' : 'Ocultar camada';
      eye.textContent = l.visible === false ? 'off' : 'on';
      eye.addEventListener('click', (e) => { e.stopPropagation(); update(l.id, { visible: l.visible === false }); });
      const dup = document.createElement('button'); dup.type = 'button'; dup.className = 'lbtn'; dup.textContent = 'dup'; dup.title = 'Duplicar camada';
      dup.addEventListener('click', (e) => { e.stopPropagation(); duplicateLayer(l.id); });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'lbtn'; del.textContent = 'x'; del.title = 'Apagar camada';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteLayer(l.id); });
      li.appendChild(thumb); li.appendChild(nm); li.appendChild(eye); li.appendChild(dup); li.appendChild(del);
      li.addEventListener('click', (e) => {
        if (selectedId === l.id || !nm.readOnly) return;
        selectedId = l.id;
        // Keep drawer nodes alive through both clicks of a double click.
        for (const row of ul.children) row.classList.toggle('sel', row.dataset.id === selectedId);
        renderPreview(); renderProps();
      });
      ul.appendChild(li);
    }
    $('layerCount').textContent = String(layers.length);
  }
  function duplicateLayer(id) {
    const src = layers.find((l) => l.id === id);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = L.uid ? L.uid() : 'ly_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    copy.name = (src.name || src.type) + ' copia';
    if (copy.firingOptions?.stages) copy.firingOptions.stages = copy.firingOptions.stages.map((s) => ({ ...s }));
    const idx = layers.indexOf(src);
    doAction({ type: 'add', items: [copy], indices: [idx + 1] });
    selectedId = copy.id; renderAll();
  }
  function deleteLayer(id) {
    const idx = layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    const l = layers[idx];
    doAction({ type: 'delete', items: [l], indices: [idx] });
    if (selectedId === id) selectedId = layers[idx]?.id || layers[idx - 1]?.id || null;
    renderAll();
  }
  function renderAll() {
    renderPreview();
    renderLayerList();
    renderProps();
    $('undoBtn').disabled = !U.canUndo();
    $('redoBtn').disabled = !U.canRedo();
    applyZoom();
  }
  function renderPreview() {
    stopPreview();
    $('preview').innerHTML = L.renderLayers(layers);
  }

  // ---------- bounds ----------
  function layerBounds(l) {
    if (!l) return { w: 4, h: 4 };
    if (L && typeof L.layerBounds === 'function') {
      const copy = { ...l, armLength: l.armLength ?? l.armLen, armThickness: l.armThickness ?? l.armThick, armSpacing: l.armSpacing ?? l.gap };
      try { const b = L.layerBounds(copy); if (b && b.w && b.h) return b; } catch (e) {}
    }
    if (l.type === 'model') {
      // Visual bounds wrap dot+outline and arm tips (probed live: original box is
      // 300x300px = dot 4 + 2*outlineWidth 1 for the default length-0 model).
      const len = l.armLength ?? l.armLen ?? 0;
      const thick = l.armThickness ?? l.armThick ?? 0;
      const dot = l.dot || {};
      const dotR = dot.enabled !== false && (dot.size ?? 0) > 0
        ? dot.size / 2 + (l.outline?.enabled ? (l.outline.width ?? 0) : 0)
        : 0;
      const r = Math.max(len / 2 + thick / 2, dotR);
      return { w: Math.max(r * 2, 4), h: Math.max(r * 2, 4) };
    }
    if (l.type === 'shape' || l.type === 'image' || l.type === 'draw') return { w: l.w || 4, h: l.h || 4 };
    if (l.type === 'text') {
      const fs = l.fontSize || 16; const len = String(l.text || '').length || 1;
      return { w: Math.max(8, fs * len * 0.62), h: fs * 1.4 + 4 };
    }
    return { w: 20, h: 20 };
  }

  // ---------- canvas: zoom / pan / select / move / resize ----------
  const stageWrap = $('stageWrap');
  const stage = $('stage');
  const selBox = $('selBox');
  const gridEl = (() => {
    try { return stage.querySelector('.grid') || document.querySelector('.grid'); } catch (e) { return null; }
  })();

  const PXU = 50; // px por unidade de mundo a zoom 1 — medido no original (SVG 3000×3000, viewBox 60)
  function applyZoom() {
    const pv = $('preview');
    if (pv) {
      pv.setAttribute('viewBox', '-30 -30 60 60');
      pv.style.position = 'absolute';
      pv.style.left = `calc(50% - ${30 * PXU * zoom}px)`;
      pv.style.top = `calc(50% - ${30 * PXU * zoom}px)`;
      pv.style.width = `${60 * PXU * zoom}px`;
      pv.style.height = `${60 * PXU * zoom}px`;
      pv.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
    }
    if (gridEl) {
      gridEl.style.backgroundImage = 'linear-gradient(#222 1px, transparent 1px), linear-gradient(90deg, #222 1px, transparent 1px)';
      gridEl.style.backgroundSize = `${50 * zoom}px ${50 * zoom}px`;
      gridEl.style.backgroundPosition = `calc(50% + ${panX}px) calc(50% + ${panY}px)`;
    }
    const badge = $('zoomBadge');
    if (badge) badge.textContent = `${Math.round(zoom * 100) / 100}px`;
    const range = $('zoomRange');
    if (range) { range.min = '0.2'; range.max = '8'; range.step = '0.05'; range.value = zoom; }
    const val = $('zoomVal');
    if (val) val.textContent = zoom.toFixed(1);
    positionSel();
  }
  function setZoom(z) { zoom = clamp(z, 0.2, 8); applyZoom(); }

  // badge dblclick -> inline input (1..8), Esc/reset -> 1
  let zoomInput = null;
  function openZoomInput() {
    const badge = $('zoomBadge');
    if (!badge || zoomInput) return;
    zoomInput = document.createElement('input');
    zoomInput.type = 'number'; zoomInput.min = '1'; zoomInput.max = '8'; zoomInput.step = '1';
    zoomInput.value = String(Math.round(zoom) || 1);
    zoomInput.setAttribute('aria-label', 'Zoom do canvas');
    zoomInput.style.cssText = 'position:absolute;left:16px;bottom:10px;width:56px;height:20px;background:#1e1e1e;color:#fff;border:1px solid #3b82f6;border-radius:4px;font:11px Consolas,monospace;text-align:center;z-index:9';
    badge.parentElement.appendChild(zoomInput);
    zoomInput.focus();
    zoomInput.select?.();
    const close = (apply) => {
      if (!zoomInput) return;
      const input = zoomInput;
      const v = Number(input.value);
      zoomInput = null; // Finalize before removal: detaching focused input can reenter blur.
      if (input.parentElement) input.remove();
      if (apply) setZoom(Number.isFinite(v) && v > 0 ? clamp(v, 1, 8) : 1);
    };
    zoomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); setZoom(1); }
    });
    zoomInput.addEventListener('blur', () => close(true));
  }
  $('zoomBadge').addEventListener('dblclick', openZoomInput);

  $('zoomRange').addEventListener('input', (e) => setZoom(Number(e.target.value)));
  $('realSize')?.addEventListener('click', () => {
    // Modo tamanho real 1:1 reversível
    setZoom(zoom === 1 ? 2 : 1);
  });

  stageWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stageWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    const newZoom = clamp(zoom * factor, 0.2, 8);
    // ponto sob o cursor permanece fixo: mundo = (cursor - centro - pan) / zoom
    const wx = (mx - rect.width / 2 - panX) / (zoom * PXU);
    const wy = (rect.height / 2 + panY - my) / (zoom * PXU);
    panX = mx - rect.width / 2 - wx * newZoom * PXU;
    panY = my - rect.height / 2 + wy * newZoom * PXU;
    zoom = newZoom;
    applyZoom();
  }, { passive: false });

  function toWorld(e) {
    const rect = stageWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    return {
      x: (mx - rect.width / 2 - panX) / (zoom * PXU),
      y: (rect.height / 2 + panY - my) / (zoom * PXU),
    };
  }

  let drag = null; // {kind:'pan'|'move'|'resize', ...}
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const near = e.target && e.target.closest ? e.target.closest('[id^="layer-"]') : null;
    if (near) {
      const lid = near.id.replace('layer-', '');
      if (lid !== selectedId) { selectedId = lid; renderAll(); }
      const l = selected();
      if (!l) return;
      const w = toWorld(e);
      drag = { kind: 'move', id: l.id, profile: currentProfileId, lx: l.x, ly: l.y, wx: w.x, wy: w.y };
      beginGesture();
    } else {
      drag = { kind: 'pan', px: panX, py: panY, cx: e.clientX, cy: e.clientY };
    }
    stage.setPointerCapture?.(e.pointerId);
    document.body.classList.add('dragging');
  });

  // resize handles
  if (selBox) {
    selBox.addEventListener('pointerdown', (e) => {
      const handle = e.target?.classList?.contains?.('h') ? e.target : null;
      if (!handle) return;
      const l = selected();
      if (!l) return;
      const dir = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].find((d) => handle.classList.contains(d)) || 'se';
      const b = layerBounds(l);
      drag = {
        kind: 'resize', id: l.id, profile: currentProfileId, dir,
        cx: e.clientX, cy: e.clientY,
        base: {
          x: l.x, y: l.y, w: b.w, h: b.h,
          scale: l.scale ?? 1, layerW: l.w, layerH: l.h, fontSize: l.fontSize,
        },
      };
      beginGesture();
      selBox.setPointerCapture?.(e.pointerId);
      document.body.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    });
  }

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      panX = drag.px + (e.clientX - drag.cx);
      panY = drag.py + (e.clientY - drag.cy);
      applyZoom();
      return;
    }
    if (drag.kind === 'move') {
      if (drag.profile !== currentProfileId) return; // perfil trocou: gesto cancelado
      const l = layers.find((x) => x.id === drag.id);
      if (!l) return;
      const w = toWorld(e);
      l.x = Math.round(drag.lx + (w.x - drag.wx));
      l.y = Math.round(drag.ly + (w.y - drag.wy));
      renderPreview(); positionSel(); persist();
      return;
    }
    if (drag.kind === 'resize') {
      if (drag.profile !== currentProfileId) return; // perfil trocou: gesto cancelado
      const l = layers.find((x) => x.id === drag.id);
      if (!l) return;
      const dx = (e.clientX - drag.cx) / (zoom * PXU);
      const dy = -(e.clientY - drag.cy) / (zoom * PXU);
      const d = drag.dir; const base = drag.base;
      let w = base.w, h = base.h;
      if (d.includes('e')) w = base.w + dx;
      if (d.includes('w')) w = base.w - dx;
      if (d.includes('n')) h = base.h + dy;
      if (d.includes('s')) h = base.h - dy;
      w = Math.max(2, w); h = Math.max(2, h);
      if (l.type === 'model') {
        const k = w / Math.max(base.w, 0.001);
        l.scale = Math.max(0.05, Math.round(base.scale * k * 100) / 100);
      } else if (l.type === 'shape' || l.type === 'image' || l.type === 'draw') {
        l.w = Math.max(1, Math.round(w)); l.h = Math.max(1, Math.round(h));
      } else if (l.type === 'text') {
        l.fontSize = Math.max(2, Math.round(base.fontSize * (h / Math.max(base.h, 0.001))));
      }
      renderPreview(); positionSel(); persist();
    }
  });

  // Finalização idempotente: pointerup e pointercancel convergem aqui; perfil
  // trocado cancela o gesto sem gravar Undo falso em documento alheio.
  const finishDrag = () => {
    const d = drag;
    drag = null;
    document.body.classList.remove('dragging');
    if (!d || (d.kind !== 'move' && d.kind !== 'resize')) return;
    endGesture(); // aplica externa diferida antes de gravar o gesto
    if (d.profile !== currentProfileId) return;
    const l = layers.find((x) => x.id === d.id);
    if (l) {
      const snapshot = JSON.stringify(l);
      const base = d.base || { x: d.lx, y: d.ly };
      // restaura estado inicial e reaplica via uma unica acao de undo
      const restore = d.kind === 'move'
        ? { x: d.lx, y: d.ly }
        : { scale: base.scale, w: base.layerW, h: base.layerH, fontSize: base.fontSize };
      const final = { x: l.x, y: l.y };
      const patch = d.kind === 'move' ? final : pickChanged(l, restore, snapshot);
      const changed = d.kind === 'move'
        ? (final.x !== d.lx || final.y !== d.ly)
        : Object.keys(patch).length > 0;
      if (changed) {
        Object.assign(l, restore);
        U.endDebounce();
        update(l.id, patch);
        U.endDebounce();
      }
    }
  };
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  window.addEventListener('blur', finishDrag);
  function pickChanged(l, restore, snapshot) {
    const patch = {};
    const final = JSON.parse(snapshot);
    for (const k of ['scale', 'w', 'h', 'fontSize']) {
      if (final[k] !== undefined && final[k] !== restore[k]) patch[k] = final[k];
    }
    return patch;
  }

  // ---------- selection box ----------
  function positionSel() {
    const box = selBox;
    if (!box) return;
    const l = selected();
    if (!l || l.visible === false) { box.style.display = 'none'; return; }
    const b = layerBounds(l);
    const rect = stageWrap.getBoundingClientRect();
    const cx = rect.width / 2 + panX + l.x * zoom * PXU;
    const cy = rect.height / 2 + panY - l.y * zoom * PXU;
    // Display floor keeps the box grabbable for length-0 models; the label
    // reports the raw bounds ("0 x 0 px") like the original.
    const w = Math.max(b.w * zoom * PXU, 24), h = Math.max(b.h * zoom * PXU, 24);
    box.style.display = 'block';
    box.style.left = `${cx - w / 2}px`;
    box.style.top = `${cy - h / 2}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    const name = $('selName'); const size = $('selSize');
    if (name) name.textContent = l.name || l.type;
    if (size) {
      // Original labels the default length-0 model "0 x 0 px": the label tracks
      // the arm extent while the box wraps the visible dot+outline.
      const len = l.type === 'model' ? (l.armLength ?? l.armLen ?? 0) : (b.w / PXU / zoom);
      size.textContent = l.type === 'model'
        ? `${Math.round(len * 2)} x ${Math.round(len * 2)} px`
        : `${Math.round(b.w)} x ${Math.round(b.h)} px`;
    }
  }
  window.addEventListener('resize', positionSel);

  // ---------- top buttons ----------
  function addLayer(factory, extra) {
    const l = normalizeLayer(factory());
    if (extra) Object.assign(l, extra);
    doAction({ type: 'add', items: [l], indices: [layers.length] });
    selectedId = l.id; renderAll();
  }
  $('addModel').addEventListener('click', () => {
    // "Nova Camada" abre o menu de tipos (mira/forma/texto/imagem/desenho/recorte)
    $('arqMenu').classList.toggle('open');
  });
  $('toolSelect').addEventListener('click', () => addLayer(L.newModelLayer));
  $('addShape').addEventListener('click', () => addLayer(L.newShapeLayer));
  $('addText').addEventListener('click', () => addLayer(L.newTextLayer));
  $('addImage').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    const file = $('fileInput').files[0]; $('fileInput').value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { alert('Use imagem PNG, JPEG, GIF ou WebP.'); return; }
    if (`data:${file.type};base64,`.length + 4 * Math.ceil(file.size / 3) > MAX_IMPORT_BYTES) { alert('Imagem acima de 8 MiB após codificação base64.'); return; }
    const reader = new FileReader();
    reader.onerror = () => flashStatus('Falha ao ler imagem.');
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 100; const ratio = Math.min(1, max / Math.max(img.width, img.height));
        const candidate = L.newImageLayer(reader.result, Math.round(img.width * ratio), Math.round(img.height * ratio));
        try { L.validateCrosshair({ layers: [...layers, candidate] }); }
        catch (e) { flashStatus(`Imagem não importada: ${e.message}`); return; }
        addLayer(() => candidate);
      };
      img.onerror = () => flashStatus('Imagem inválida.');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  $('lnAdd').addEventListener('click', () => addLayer(L.newModelLayer));

  const docStatus = $('docStatus');
  let statusTimer = null;
  function flashStatus(msg) { docStatus.textContent = msg; clearTimeout(statusTimer); statusTimer = setTimeout(() => { docStatus.textContent = ''; }, 4000); }

  $('btnSave').addEventListener('click', () => {
    persist();
    try {
      const key = 'cq.savedCustomCrosshairs';
      const favs = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(favs)) throw new Error('Biblioteca inválida.');
      favs.unshift({ id: L.uid(), name: $('docName').value || 'Mira', creator: 'Local', model: {}, layers: JSON.parse(JSON.stringify(layers)), drawing: L.renderLayers(layers), savedAt: Date.now() });
      localStorage.setItem(key, JSON.stringify(favs));
      flashStatus('Salvo nos favoritos do app.');
    } catch (e) {
      flashStatus('Salvo no estado do app (favoritos indisponiveis).');
    }
  });
  $('btnShare').addEventListener('click', () => {
    const payload = { format: 'CQ1', name: $('docName').value || 'Mira', layers: JSON.parse(JSON.stringify(layers)) };
    const url = JSON.stringify(payload, null, 2);
    if (url.length > MAX_SHARE_CODE_LEN || new Blob([url]).size > MAX_SHARE_CODE_LEN) {
      flashStatus('Documento excede 2 MiB; reduza imagens ou camadas antes de compartilhar.'); return;
    }
    const done = () => flashStatus('JSON da mira copiado; importe na biblioteca.');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => downloadShare(url));
    } else downloadShare(url);
  });
  function downloadShare(url) {
    try {
      const blob = new Blob([url], { type: 'application/json' });
      const a = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = 'mira-opencrosshairq.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      flashStatus('JSON exportado (download).');
    } catch (e) { flashStatus('Nao foi possivel exportar o link.'); }
  }
  $('btnArquivo').addEventListener('click', () => $('arqMenu').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    const menu = $('arqMenu'); const btn = $('btnArquivo');
    if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) menu.classList.remove('open');
  });
  const ACT = {
    model: () => addLayer(L.newModelLayer),
    shape: () => addLayer(L.newShapeLayer),
    text: () => addLayer(L.newTextLayer),
    image: () => $('addImage').click(),
    draw: () => drawOpen(),
    cut: () => cutOpen(),
  };
  for (const b of $$('#arqMenu .menu-item')) b.addEventListener('click', () => { $('arqMenu').classList.remove('open'); ACT[b.dataset.act]?.(); });
  $('btnUp').addEventListener('click', () => reorder(1));
  $('btnDown').addEventListener('click', () => reorder(-1));
  $('btnDel').addEventListener('click', () => deleteLayer(selectedId));
  $('btnClose').addEventListener('click', () => { window.cq.closeDesigner?.() ?? window.close(); });
  $('docName').addEventListener('change', () => flashStatus('Nome local.'));
  function reorder(dir) {
    const i = layers.findIndex((l) => l.id === selectedId);
    const j = i + (dir > 0 ? 1 : -1);
    if (i === -1 || j < 0 || j >= layers.length) return;
    doAction({ type: 'reorder', from: i, to: j });
  }

  // ---------- drawer & modes ----------
  $('drawerHead').addEventListener('click', () => { $('drawer').classList.toggle('closed'); });
  const titleInput = $('layerTitleSide');
  bindRename(titleInput, () => selectedId);
  for (const [id, bodyId] of [['secLayer', 'bodyLayer'], ['secLinhas', 'bodyLinhas'], ['secDot', 'bodyDot'], ['secOutline', 'bodyOutline']]) {
    const section = $(id);
    const head = section.children[0];
    if (!head) continue;
    head.setAttribute('role', 'button'); head.setAttribute('tabindex', '0');
    head.setAttribute('aria-controls', bodyId); head.setAttribute('aria-expanded', 'true');
    const toggle = () => head.setAttribute('aria-expanded', String(!section.classList.toggle('closed')));
    head.addEventListener('click', e => { if (!e.target.closest?.('.act')) toggle(); });
    head.addEventListener('keydown', e => { if (e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
  }
  for (const [id, base] of [['dotClose', 'dot.enabled'], ['olClose', 'outline.enabled']]) {
    const button = $(id);
    button.setAttribute('tabindex', '0');
    const toggle = () => {
      const l = selected(); if (!l) return;
      const path = base === 'outline.enabled' && l.type === 'shape' ? 'stroke.enabled' : base;
      update(l.id, setPathPatch(path, !getPath(l, path)));
    };
    button.addEventListener('click', toggle);
    button.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
  // Local-only preview. Never writes simulated input or trigger state to IPC/profiles.
  const previewAnimations = new Map();
  const previewTriggers = { autoplay: false, fire: false, aim: false, reload: false };
  const previewSessions = { autoplay: 0, fire: 0, aim: 0, reload: 0 };
  const previewButtons = { autoplay: 'previewAutoplay', fire: 'previewFire', aim: 'previewAim', reload: 'previewReload' };
  function stopPreview() {
    for (const { animation } of previewAnimations.values()) animation.cancel();
    previewAnimations.clear();
    for (const key of Object.keys(previewTriggers)) {
      previewTriggers[key] = false;
      previewSessions[key]++;
      $(previewButtons[key]).setAttribute('aria-pressed', 'false');
    }
  }
  function previewFrames(fo, opacity) {
    const segments = [{ delay: fo.startDelay, duration: fo.duration, easing: fo.easing }, ...(fo.stages || [])];
    const total = segments.reduce((sum, s) => sum + (s.delay || 0) + Math.max(1, s.duration ?? 300), 0);
    const cur = { scale: 1, opacity: 1, x: 0, y: 0, rotation: 0 };
    let time = 0;
    const frame = (easing = 'linear') => ({ offset: time / total, easing,
      transform: `translate(${cur.x}px, ${-cur.y}px) rotate(${cur.rotation}deg) scale(${clamp(cur.scale, .05, 8)})`, opacity: cur.opacity * opacity });
    const frames = [frame()];
    for (const s of segments) {
      time += s.delay || 0;
      frames.push(frame(s.easing || fo.easing || 'ease-out'));
      const duration = Math.max(1, s.duration ?? 300);
      if (s.effects?.length) {
        for (const e of s.effects) cur[e.property] = e.to;
      } else {
        // ponytail: empty stages keep clone's scale pulse; named original effects need schema/runtime support.
        const scale = cur.scale; cur.scale += .2; time += duration / 2;
        frames.push(frame(s.easing || fo.easing || 'ease-out'));
        cur.scale = scale; time -= duration / 2;
      }
      time += duration;
      frames.push(frame());
    }
    return { frames, total };
  }
  function togglePreview(key) {
    if (!document.body.classList.contains('mode-animar')) return;
    const session = ++previewSessions[key];
    const active = previewTriggers[key] = !previewTriggers[key];
    $(previewButtons[key]).setAttribute('aria-pressed', String(active));
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { stopPreview(); return; }
    if (key === 'reload') {
      if (active) for (const item of previewAnimations.values()) {
        if (['left', 'right'].includes(item.fo.trigger) && item.fo.releaseBehavior === 'pause') {
          item.animation.pause(); item.animation.currentTime = 0;
        }
      }
      return;
    }
    const trigger = { fire: 'left', aim: 'right', autoplay: 'autoplay' }[key];
    const hasPersistent = layers.some((l) => l.visible !== false && l.firingOptions?.trigger === trigger && (l.firingOptions.loop || l.firingOptions.pressType === 'hold') && Boolean($('layer-' + l.id)?.animate));
    let pendingOneShots = 0;
    for (const l of layers) {
      const fo = l.firingOptions;
      if (l.visible === false || fo?.trigger !== trigger) continue;
      let item = previewAnimations.get(l.id);
      if (!active) {
        const behavior = (key === 'autoplay' || fo.loop) ? (fo.releaseBehavior ?? 'reset') : (fo.releaseBehavior ?? (fo.pressType === 'hold' ? 'reset' : null));
        if (!item || !behavior) continue;
        if (behavior === 'pause' && item.animation.playState === 'running') item.animation.pause();
        else if (behavior === 'reverse' && item.animation.currentTime > 0) item.animation.reverse();
        else if (behavior === 'reset') { item.animation.cancel(); previewAnimations.delete(l.id); }
        continue;
      }
      const resume = item && fo.pressType === 'hold' && ['pause', 'reverse'].includes(fo.releaseBehavior) && item.animation.playState !== 'finished';
      if (resume) { item.animation.playbackRate = 1; item.animation.play(); continue; }
      item?.animation.cancel();
      const node = $('layer-' + l.id);
      if (!node?.animate) continue;
      const { frames, total } = previewFrames(fo, l.opacity ?? 1);
      const animation = node.animate(frames, { duration: total, iterations: fo.loop ? Infinity : 1,
        direction: fo.direction === 'reverse' ? 'reverse' : 'normal', fill: 'none' });
      previewAnimations.set(l.id, { animation, fo });
      if (!fo.loop && fo.pressType !== 'hold') {
        pendingOneShots++;
        animation.onfinish = () => {
          if (previewSessions[key] !== session || !previewTriggers[key]) return;
          pendingOneShots--;
          if (pendingOneShots <= 0 && !hasPersistent) {
            previewTriggers[key] = false;
            $(previewButtons[key]).setAttribute('aria-pressed', 'false');
          }
        };
      }
    }
    if (active && pendingOneShots === 0 && !hasPersistent) {
      previewTriggers[key] = false;
      $(previewButtons[key]).setAttribute('aria-pressed', 'false');
    }
  }
  for (const [key, id] of Object.entries(previewButtons)) $(id).addEventListener('click', () => togglePreview(key));
  window.addEventListener('pagehide', stopPreview);
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', stopPreview);
  function setMode(m) {
    stopPreview();
    const anim = m === 'animar';
    document.body.classList.toggle('mode-animar', anim);
    for (const t of $$('.mode-tab')) t.classList.toggle('active', t.dataset.mode === m);
    if (gridEl) gridEl.style.display = anim ? 'none' : '';
    positionSel();
  }
  for (const t of $$('.mode-tab')) t.addEventListener('click', () => setMode(t.dataset.mode));
  $('rpDesign').addEventListener('click', () => setMode('design'));
  $('rpAnimar').addEventListener('click', () => setMode('animar'));

  document.addEventListener('keydown', (e) => {
    const typing = e.target && e.target.matches && e.target.matches('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (modalDraw.style.display === 'flex') { e.preventDefault(); modalDraw.style.display = 'none'; return; }
      if (modalCut.style.display === 'flex') { e.preventDefault(); modalCut.style.display = 'none'; return; }
      if (!typing && selectedId) { e.preventDefault(); selectedId = null; renderAll(); return; }
    }
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault(); deleteLayer(selectedId); return;
    }
    if (!typing && e.key.toLowerCase() === 's') setMode(document.body.classList.contains('mode-animar') ? 'design' : 'animar');
    if (!typing && !e.ctrlKey && !e.altKey && !e.repeat && ['1', '2', '3', '4'].includes(e.key) && document.body.classList.contains('mode-animar')) {
      e.preventDefault(); togglePreview(['autoplay', 'fire', 'aim', 'reload'][Number(e.key) - 1]); return;
    }
    const l = selected();
    if (l && !typing) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(l, -step, 0); }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudge(l, step, 0); }
      if (e.key === 'ArrowUp') { e.preventDefault(); nudge(l, 0, step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); nudge(l, 0, -step); }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateLayer(selectedId); }
  });
  function nudge(l, dx, dy) { update(l.id, { x: l.x + dx, y: l.y + dy }); selectedId = l.id; renderAll(); }

  // ---------- draw modal ----------
  const modalDraw = $('modalDraw'); const drawCanvas = $('drawCanvas'); const drawCtx = drawCanvas.getContext('2d'); let drawActive = false;
  function drawOpen() { drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); modalDraw.style.display = 'flex'; }
  $('addDraw').addEventListener('click', drawOpen);
  $('drawClear').addEventListener('click', () => { drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); });
  $('drawCancel').addEventListener('click', () => { modalDraw.style.display = 'none'; });
  modalDraw.addEventListener('click', (e) => { if (e.target === modalDraw) modalDraw.style.display = 'none'; });
  $('drawCommit').addEventListener('click', () => {
    const src = drawCanvas.toDataURL('image/png');
    addLayer(() => L.newDrawLayer(src, drawCanvas.width, drawCanvas.height));
    modalDraw.style.display = 'none';
  });
  function drawPoint(e) { const r = drawCanvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (drawCanvas.width / r.width), y: (e.clientY - r.top) * (drawCanvas.height / r.height) }; }
  drawCanvas.addEventListener('pointerdown', (e) => {
    drawActive = true; const p = drawPoint(e);
    if ($('drawTool').value === 'eraser') drawCtx.globalCompositeOperation = 'destination-out';
    else { drawCtx.globalCompositeOperation = 'source-over'; drawCtx.strokeStyle = $('drawColor').value; }
    drawCtx.lineWidth = Number($('drawSize').value); drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
    drawCtx.beginPath(); drawCtx.moveTo(p.x, p.y);
  });
  drawCanvas.addEventListener('pointermove', (e) => { if (!drawActive) return; const p = drawPoint(e); drawCtx.lineTo(p.x, p.y); drawCtx.stroke(); });
  window.addEventListener('pointerup', () => { if (drawActive) { drawActive = false; drawCtx.globalCompositeOperation = 'source-over'; } });

  // ---------- cut modal ----------
  const modalCut = $('modalCut'); const cutCanvas = $('cutCanvas'); const cutCtx = cutCanvas.getContext('2d'); let cutImg = null;
  function cutOpen() { cutCtx.clearRect(0, 0, 700, 700); cutImg = null; modalCut.style.display = 'flex'; }
  $('cutCancel').addEventListener('click', () => { modalCut.style.display = 'none'; });
  modalCut.addEventListener('click', (e) => { if (e.target === modalCut) modalCut.style.display = 'none'; });
  $('cutFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (file.size > MAX_IMPORT_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { flashStatus('Use imagem raster de até 8 MiB.'); return; }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(objectUrl); flashStatus('Imagem inválida.'); };
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const max = 600; const ratio = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
      cutCtx.clearRect(0, 0, 700, 700); cutCtx.drawImage(img, (700 - w) / 2, (700 - h) / 2, w, h); cutImg = img;
    };
    img.src = objectUrl;
  });
  $('cutSize').addEventListener('input', (e) => { $('cutSizeV').textContent = e.target.value; });
  $('cutCommit').addEventListener('click', () => {
    if (!cutImg) return;
    const size = Number($('cutSize').value); const cx = 350, cy = 350;
    cutCtx.save(); cutCtx.globalCompositeOperation = 'destination-in'; cutCtx.fillStyle = '#000';
    if ($('cutShape').value === 'circle') { cutCtx.beginPath(); cutCtx.arc(cx, cy, size / 2, 0, Math.PI * 2); cutCtx.fill(); }
    else cutCtx.fillRect(cx - size / 2, cy - size / 2, size, size);
    cutCtx.restore();
    const src = cutCanvas.toDataURL('image/png');
    addLayer(() => L.newImageLayer(src, 700, 700));
    modalCut.style.display = 'none';
  });

  // Pilhas mudam também fora de renderAll (pushRedo pós-applyAction, fim do
  // debounce de 300ms): os botões precisam seguir o notify, senão Undo/Redo
  // ficam disabled até um renderAll posterior.
  U.subscribe(() => {
    $('undoBtn').disabled = !U.canUndo();
    $('redoBtn').disabled = !U.canRedo();
  });
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);

  // ---------- boot ----------
  function newDefaultDocument() {
    const l = normalizeLayer(L.newModelLayer());
    l.name = 'Mira 1'; l.armColor = '#FFFFFF';
    l.dot = { ...(l.dot || {}), color: '#FFFFFF', enabled: true, size: (l.dot?.size ?? 4), blur: (l.dot?.blur ?? 0) };
    l.outline = { ...(l.outline || {}), color: (l.outline?.color ?? '#000000'), enabled: l.outline?.enabled ?? true, width: (l.outline?.width ?? 1), blur: (l.outline?.blur ?? 0) };
    layers = [l]; selectedId = l.id; persist();
  }
  function applyState(state) {
    const incoming = documentLayers(state);
    if (incoming) layers = normalizeAll(incoming);
    else if (!docReady) newDefaultDocument();
    selectedId = selectedId && layers.some((l) => l.id === selectedId) ? selectedId : (layers[0]?.id ?? null);
    docReady = true;
    renderAll();
  }

  bindAnimPanel();
  window.cq.onState((state) => {
    const profileId = state.profiles?.currentProfileId;
    if (profileId !== currentProfileId) {
      currentProfileId = profileId;
      U.clearStacks();
      selectedId = state.layers?.[0]?.id ?? null;
      renderedPropsLayerId = null;
      cancelGestures(); // gestos do perfil antigo não gravam no novo
    }
    if (!Array.isArray(state.layers)) return;
    if (gestureDepth > 0) {
      // Guarda até eco igual: o último broadcast FIFO substitui o anterior.
      pendingExternal = state;
      return;
    }
    if (sameDocAsRenderer(state)) return; // eco já em tela (ou externo idêntico): no-op
    applyState(state);
  });

  function loadInitialState(attempt = 0) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800));
    Promise.race([window.cq.getState(), timeout]).then((state) => {
      if (!state || typeof state !== 'object') throw new Error('Estado invalido.');
      if (docReady) return;
      currentProfileId = state.profiles?.currentProfileId;
      applyState(state);
    }).catch(() => {
      if (docReady || attempt >= 40) return;
      setTimeout(() => loadInitialState(attempt + 1), 250 + attempt * 100);
    });
  }
  loadInitialState();
  applyZoom();
})();


