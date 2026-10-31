// Overlay renderer: renders the crosshair state pushed by the main process.
// Mirrors the observed original mechanism: two exclusive containers
// (primary / secondary), shared offset+scale on a .svg-target class,
// centered from the measured viewport without rounding fractional centers.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const G = window.CQGeometry;
  const primary = document.getElementById('primary');
  const secondary = document.getElementById('secondary');
  const targets = [primary, secondary];

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function renderSvg(container, state) {
    const svg = container.firstElementChild;
    svg.innerHTML = '';
    if (window.CQLayers) {
      // Same vector compiler as Creator and library. Persisted SVG is a cache,
      // never the source when an editable document is available.
      svg.innerHTML = window.CQLayers.renderCrosshair(state);
      return;
    }
    // Legacy embedders without layers.js retain their simple-model renderer.
    // Designer output (compiled layer list) takes precedence over the
    // simple arms model, like the original's drawing vs crosshairImage.
    if (state.drawing != null) {
      svg.innerHTML = state.drawing;
      return;
    }
    const model = state.model || G.defaultModel();
    const scale = 1; // Overall size is applied once, on the target CSS transform.
    const outline = model.outline || {};
    const stroke = outline.enabled ? outline.color : 'none';
    const strokeWidth = outline.enabled ? outline.width * scale : 0;

    const group = el('g', { opacity: model.opacity ?? 1 });
    const spec = G.buildSpec(model, scale);
    for (const a of spec.arms) {
      group.appendChild(el('rect', {
        x: a.x, y: a.y, width: a.w, height: a.h,
        fill: model.color, stroke, 'stroke-width': strokeWidth,
        transform: `rotate(${a.rot} ${a.x + a.w / 2} ${a.y + a.h / 2})`,
      }));
    }
    const dot = spec.dot;
    if (dot) {
      const attrs = { fill: model.color, stroke, 'stroke-width': strokeWidth };
      if (dot.shape === 'rect') Object.assign(attrs, { x: -dot.r, y: -dot.r, width: dot.r * 2, height: dot.r * 2 });
      else Object.assign(attrs, { cx: 0, cy: 0, r: dot.r });
      group.appendChild(el(dot.shape === 'rect' ? 'rect' : 'circle', attrs));
    }
    svg.appendChild(group);
  }

  // Anchor at zero: percentage layout can move the raster origin by half a
  // pixel on odd surfaces even when SVG CTM is exact. Translate once, then
  // scale around the fixed 256px SVG center; never round the requested center.
  function positionTargets(effectiveScale) {
    const viewport = document.documentElement.getBoundingClientRect();
    const x = viewport.width / 2 - 128 + state.offsetX + (state.crosshairOffset?.x ?? 0);
    const y = viewport.height / 2 - 128 - state.offsetY - (state.crosshairOffset?.y ?? 0);
    for (const t of targets) {
      t.style.transform = `translate(${x}px, ${y}px) scale(${effectiveScale})`;
    }
  }

  let positionFrame = null;
  let af = null;
  const layerNodeCache = new Map();
  function layerNode(id) {
    const cached = layerNodeCache.get(id);
    // ponytail: node cache per layer id; SVG rebuild invalidates it (see render()).
    if (cached && cached.isConnected === true) return cached;
    const node = document.getElementById('layer-' + id);
    if (node) layerNodeCache.set(id, node);
    else layerNodeCache.delete(id);
    return node;
  }
  let state = null;
  const timelines = new Map();
  let aimHidden = false;
  let aimKey = null;
  let aimInputReady = false;
  const aimMode = () => state?.keybinds?.aim?.enabled !== false && ['hold', 'toggle'].includes(state?.keybinds?.aim?.pressType)
    ? state.keybinds.aim.pressType : null;
  function updateVisibility() {
    const shown = !!state && window.CQGameState.isCrosshairVisible(state) && !aimHidden;
    primary.style.display = shown && !state.showSecondary ? 'block' : 'none';
    secondary.style.display = shown && state.showSecondary ? 'block' : 'none';
  }
  const input = {
    left: { pressed: false, downCount: 0 },
    right: { pressed: false, downCount: 0 },
  };
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = !!media?.matches;
  const clock = () => window.performance.now();
  const ms = (value, fallback) => Number.isFinite(value) ? Math.max(0, value) : fallback;

  function clear(t) {
    const node = layerNode(t.id);
    if (node) { node.style.transform = ''; node.style.opacity = ''; }
    t.mode = 'idle';
  }

  function stopAll() {
    if (af !== null) { cancelAnimationFrame(af); af = null; }
    for (const t of timelines.values()) clear(t);
    timelines.clear();
  }

  // CSS named cubic-bezier curves, solved on X before sampling Y.
  function ease(p, name) {
    const curves = { ease: [.25, .1, .25, 1], 'ease-in': [.42, 0, 1, 1], 'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1] };
    const c = curves[name];
    if (!c || p <= 0 || p >= 1) return p;
    const bezier = (v, a, b) => 3 * (1 - v) ** 2 * v * a + 3 * (1 - v) * v * v * b + v ** 3;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bezier(mid, c[0], c[2]) < p) lo = mid; else hi = mid;
    }
    return bezier((lo + hi) / 2, c[1], c[3]);
  }

  // Overrides cumulativos por estágio (mesmos limites do layers.js; entrada
  // do main pode não estar validada, então saneia/clampa aqui também).
  const FX = { scale: [.05, 8], opacity: [0, 1], x: [-200, 200], y: [-200, 200], rotation: [-360, 360] };
  const effectsOf = (list) => Array.isArray(list)
    ? list.filter((e) => e && FX[e.property] && Number.isFinite(e.to))
      .map((e) => ({ property: e.property, to: Math.min(FX[e.property][1], Math.max(FX[e.property][0], e.to)) }))
    : null;

  // Estágios sem efeitos mantêm o pulso de escala observado no original;
  // estágios com efeitos interpolem cada override do valor herdado até `to`
  // com o easing do estágio (base neutra: scale/opacity 1, x/y/rotation 0).
  // Opacity/scale são multiplicadores sobre a base da camada, com clamp.
  function paint(t) {
    const node = layerNode(t.id);
    if (!node) return;
    let time = t.fo.direction === 'reverse' ? t.total - t.time : t.time;
    const cur = { scale: 1, opacity: 1, x: 0, y: 0, rotation: 0 };
    for (const s of t.segments) {
      if (time < s.delay) break;
      time -= s.delay;
      const fx = s.effects || [];
      if (time <= s.duration) {
        const p = ease(time / s.duration, s.easing);
        if (fx.length) for (const e of fx) cur[e.property] += p * (e.to - cur[e.property]);
        else cur.scale += .2 * Math.sin(Math.PI * p);
        break;
      }
      time -= s.duration;
      for (const e of fx) cur[e.property] = e.to; // estágio concluído segura o fim
    }
    const parts = [];
    if (cur.x || cur.y) parts.push(`translate(${cur.x}px, ${-cur.y}px)`);
    if (cur.rotation) parts.push(`rotate(${cur.rotation}deg)`);
    const scale = Math.min(8, Math.max(.05, cur.scale));
    if (scale !== 1) parts.push(`scale(${scale})`);
    node.style.transform = parts.join(' ');
    const baseOpacity = Number(node.getAttribute?.('opacity') ?? 1);
    node.style.opacity = cur.opacity === 1 ? '' : String(Math.min(1, Math.max(0, cur.opacity * (Number.isFinite(baseOpacity) ? baseOpacity : 1))));
  }

  function advance(t, now) {
    if (t.mode !== 'running') return;
    t.time += Math.max(0, now - t.last) * t.rate;
    t.last = now;
    if (t.rate > 0 && t.fo.loop === true) t.time %= t.total;
    else if (t.rate > 0 && t.time >= t.total || t.rate < 0 && t.time <= 0) {
      t.time = Math.max(0, Math.min(t.total, t.time));
      clear(t);
      t.mode = 'done'; // completion stays latched until another input edge/config change
      return;
    }
    paint(t);
  }

  function start(t, now) {
    const resume = t.fo.pressType === 'hold' && ['pause', 'reverse'].includes(t.fo.releaseBehavior);
    if (!resume || t.mode === 'done') t.time = 0;
    t.rate = 1;
    t.last = now;
    t.mode = 'running';
  }

  function release(t, now) {
    // Legacy press without an explicit release policy is a complete one-shot.
    const behavior = t.fo.releaseBehavior ?? (t.fo.pressType === 'hold' ? 'reset' : null);
    if (!behavior) return;
    advance(t, now);
    if (behavior === 'reset') clear(t);
    else if (behavior === 'pause' && t.mode === 'running') t.mode = 'paused';
    else if (behavior === 'reverse' && t.time > 0) {
      t.mode = 'running'; t.rate = -1; t.last = now;
    }
  }

  function handleInput(payload) {
    const invalid = payload?.available !== true || !!payload.error;
    if (invalid) { aimHidden = false; aimInputReady = false; }
    const now = clock();
    for (const side of ['left', 'right']) {
      const previous = input[side];
      const cur = payload?.[side];
      if (!invalid && (!cur || typeof cur.pressed !== 'boolean' || !Number.isSafeInteger(cur.downCount) || cur.downCount < previous.downCount)) continue;
      const down = !invalid && (cur.downCount > previous.downCount || cur.pressed && !previous.pressed);
      const up = !invalid && !cur.pressed && (previous.pressed || down);
      if (side === 'right' && !invalid) {
        const mode = aimMode();
        if (mode === 'hold') aimHidden = cur.pressed;
        else if (aimInputReady && mode === 'toggle' && down && (Math.max(1, cur.downCount - previous.downCount) % 2)) aimHidden = !aimHidden;
        aimInputReady = true; // Initial/recovery snapshots baseline toggle; hold always uses current pressed.
      }
      if (!invalid) previous.downCount = cur.downCount;
      previous.pressed = !invalid && cur.pressed;
      for (const t of timelines.values()) {
        if (t.fo.trigger !== side) continue;
        if (invalid) clear(t);
        else if (!reducedMotion) {
          // Process edges here, not in rAF: a complete click can occur between frames.
          if (down && (t.fo.pressType !== 'hold' || cur.pressed)) start(t, now);
          if (up) release(t, now);
        }
      }
    }
    updateVisibility();
    sync();
  }

  function sync() {
    if (!state || reducedMotion) { stopAll(); return; }
    const seen = new Set();
    const now = clock();
    for (const l of state.layers || []) {
      const fo = l.firingOptions;
      if (l.visible === false || !['left', 'right', 'autoplay'].includes(fo?.trigger) || !layerNode(l.id)) continue;
      seen.add(l.id);
      const key = JSON.stringify(fo);
      let t = timelines.get(l.id);
      if (!t || t.key !== key) {
        if (t) clear(t);
        const stages = Array.isArray(fo.stages) ? fo.stages.filter((s) => s && typeof s === 'object') : [];
        const segments = [fo, ...stages].map((s, i) => ({
          delay: ms(i === 0 ? s.startDelay : s.delay, 0),
          duration: Math.max(1, ms(s.duration, 300)), easing: s.easing ?? fo.easing ?? 'ease-out',
          effects: i === 0 ? null : effectsOf(s.effects),
        }));
        t = { id: l.id, key, fo, segments, total: segments.reduce((n, s) => n + s.delay + s.duration, 0), time: 0, mode: 'idle' };
        timelines.set(l.id, t);
        if (fo.trigger === 'autoplay' || fo.pressType === 'hold' && input[fo.trigger].pressed) start(t, now);
      } else if (t.mode !== 'idle' && t.mode !== 'done') paint(t); // state may replace SVG nodes
    }
    for (const [id, t] of timelines) {
      if (!seen.has(id)) { clear(t); timelines.delete(id); }
    }
    const running = [...timelines.values()].some((t) => t.mode === 'running');
    if (!running && af !== null) { cancelAnimationFrame(af); af = null; }
    if (running && af === null) af = requestAnimationFrame(applyAnimations);
  }

  function applyAnimations(now) {
    af = null;
    for (const t of timelines.values()) advance(t, now);
    sync();
  }

  function updateReducedMotion() { reducedMotion = !!media.matches; sync(); }
  media?.addEventListener('change', updateReducedMotion);

  function schedulePosition() {
    if (disposed || !state) return;
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      positionTargets(state.scale * (state.crosshairSize ?? 1));
    });
  }

  function render(s) {
    const nextAimKey = JSON.stringify([s?.profiles?.currentProfileId, s?.keybinds?.aim]);
    if (nextAimKey !== aimKey) { aimHidden = false; aimKey = nextAimKey; }
    state = s;
    updateVisibility();
    if (!state) {
      // state undefined nunca quebra o render; para loops e limpa transforms pendentes
      stopAll();
      if (positionFrame !== null) { cancelAnimationFrame(positionFrame); positionFrame = null; }
      layerNodeCache.clear();
      return;
    }
    // Invalidate nodes after SVG rebuilds – drawings are replaced below.
    layerNodeCache.clear();
    // Aim only masks the canonical game/profile/visibility gates; never persists hidden.

    // perfil: crosshairSize = multiplicador geral (slider "Tamanho" do original);
    // crosshairOffset soma ao offset do perfil.
    const effScale = state.scale * (state.crosshairSize ?? 1);
    renderSvg(primary, { model: state.model, layers: state.layers, scale: effScale, drawing: state.drawing });
    renderSvg(secondary, { model: state.model2, scale: effScale, drawing: null });

    // +X right, +Y up (original semantics; CSS Y grows downward).
    for (const t of targets) {
      t.style.left = '0px';
      t.style.top = '0px';
    }
    schedulePosition();
    sync();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopAll();
    if (positionFrame !== null) { cancelAnimationFrame(positionFrame); positionFrame = null; }
    window.removeEventListener('resize', schedulePosition);
    media?.removeEventListener('change', updateReducedMotion);
    if (typeof offState === 'function') offState();
    if (typeof offInput === 'function') offInput();
  }
  const offState = window.cq?.onState((value) => { if (!disposed) render(value); });
  const offInput = window.cq?.onInput((value) => { if (!disposed) handleInput(value); });
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('pagehide', dispose, { once: true });
  window.addEventListener('beforeunload', dispose, { once: true });
})();
