// Assert-only runtime checks: no Electron, browser, timers or dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const source = fs.readFileSync('src/overlay/overlay.js', 'utf8');
function runtime(options = {}) {
  let now = 0, nextId = 0, writes = 0;
  const frames = new Map(), elements = new Map(), listeners = {};
  const unsubscribes = { state: 0, input: 0 };
  function node(id) {
    const n = { style: {}, attributes: {}, children: [], isConnected: true,
      set innerHTML(value) { this.html = value; this.children = []; writes++; },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] ?? null; },
      appendChild(c) { this.children.push(c); },
      getBoundingClientRect() { return { left: .2, top: .3, width: 256, height: 256 }; },
    };
    if (id) elements.set(id, n);
    return n;
  }
  const primary = node('primary'), secondary = node('secondary');
  primary.firstElementChild = node(); secondary.firstElementChild = node();
  const mq = { matches: false, addEventListener(_, fn) { this.change = fn; }, removeEventListener() { this.change = null; } };
  const requestAnimationFrame = (cb) => { frames.set(++nextId, cb); return nextId; };
  const cancelAnimationFrame = (id) => frames.delete(id);
  const viewport = { width: 961, height: 541, ...options.viewport };
  const document = { documentElement: { getBoundingClientRect: () => viewport }, createElementNS: () => node(), getElementById: (id) => elements.get(id) || null };
  const window = { devicePixelRatio: options.dpr || 1, performance: { now: () => now }, matchMedia: () => mq,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    removeEventListener: (name, fn) => { if (listeners[name] === fn) delete listeners[name]; },
    CQGeometry: { defaultModel: () => ({}), buildSpec: (_, scale) => ({ arms: [{ x: 4 * scale, y: -scale, w: 8 * scale, h: 2 * scale, rot: 0 }] }) },
    CQGameState: createRequire(import.meta.url)('../src/shared/game-state.js'),
    cq: { onState(fn) { this.state = fn; return () => { unsubscribes.state++; this.state = null; }; }, onInput(fn) { this.input = fn; return () => { unsubscribes.input++; this.input = null; }; } },
  };
  vm.runInNewContext(source, { window, document, requestAnimationFrame, cancelAnimationFrame });
  const state = (layers, extra = {}) => window.cq.state({ visible: true, scale: 1, offsetX: 0, offsetY: 0, layers, ...extra });
  const layer = (fo, id = 'a') => { node('layer-' + id); return { id, firingOptions: fo }; };
  const input = (pressed, downCount, extra = {}) => window.cq.input({ available: true, left: { pressed, downCount }, right: { pressed: false, downCount: 0 }, ...extra });
  function tick(ms) { now += ms; const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now)); }
  const transform = (id = 'a') => elements.get('layer-' + id)?.style.transform || '';
  const scale = () => Number(transform().match(/^scale\(([^)]+)\)$/)?.[1] || 1);
  const styles = (id = 'a') => elements.get('layer-' + id)?.style || {};
  return { state, layer, input, tick, transform, scale, styles, frames, window, mq, primary, secondary, listeners, unsubscribes, viewport, writes: () => writes,
    attribute: (key, value) => elements.get('layer-a').setAttribute(key, value),
    remove: (id) => { const node = elements.get('layer-' + id); if (node) node.isConnected = false; return elements.delete('layer-' + id); } };
}
function near(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`); }

// No state.animations producer: layers alone enable runtime. Explicit false gate is ignored too.
for (const animations of [undefined, { active: false }]) {
  const r = runtime();
  r.state([r.layer({ trigger: 'autoplay', duration: 100, easing: 'linear' })], { animations });
  r.tick(50); near(r.scale(), 1.2, 'autoplay without global gate');
  r.tick(50); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0, 'loop false stops autoplay');
  r.state(undefined); // layers absent also safe
  r.window.cq.state(undefined); assert.equal(r.frames.size, 0);
}

// Short click survives coalescing, one-shot survives release, no reopening during long hold.
{
  const r = runtime(); r.state([r.layer({ trigger: 'left', duration: 100, easing: 'linear' })]);
  r.input(false, 1); r.tick(50); near(r.scale(), 1.2, 'downCount triggers short click even pressed false');
  r.tick(50); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0);
  r.input(true, 2); r.tick(25); r.input(false, 2); r.tick(25); near(r.scale(), 1.2, 'release does not cancel implicit one-shot');
  r.tick(50); r.input(true, 3); r.tick(100); assert.equal(r.frames.size, 0);
  r.input(true, 3); r.tick(100); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0, 'pressed snapshot never retriggers');
  r.input(true, 2); assert.equal(r.frames.size, 0, 'stale count never retriggers');
  r.input(true, 4); r.tick(50); near(r.scale(), 1.2, 'new downCount restarts');
  const before = r.writes(); r.input(false, 4); r.tick(10); assert.equal(r.writes(), before, 'input never rebuilds SVG');
}

// Regression (RUN-1): layers that passed CQLayers.validateLayers must not lose the
// coalesced-click one-shot. Raw layers above only covered the unvalidated path.
{
  const CQLayers = createRequire(import.meta.url)('../src/shared/layers.js');
  const validate = (fo) => CQLayers.validateLayers([{ id: 'a', type: 'model', firingOptions: fo }])[0];
  const press = validate({ trigger: 'left', duration: 100, easing: 'linear' });
  assert.equal(press.firingOptions.pressType, 'press', 'validated default pressType is press');
  assert.equal(press.firingOptions.releaseBehavior, undefined, 'validated press leaves releaseBehavior implicit');
  const r = runtime(); r.layer({}); // cria o nó layer-a (mesmo efeito do ensureNode do harness)
  r.state([press]);
  r.input(false, 1); r.tick(50); near(r.scale(), 1.2, 'validated press one-shot survives coalesced click');
  r.tick(50); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0);
  const hold = validate({ trigger: 'left', pressType: 'hold', duration: 100, easing: 'linear' });
  assert.equal(hold.firingOptions.releaseBehavior, 'reset', 'validated hold defaults to reset');
  const h = runtime(); h.layer({}); // nó layer-a
  h.state([hold]);
  h.input(true, 1); h.tick(50); near(h.scale(), 1.2, 'validated hold animates while pressed');
  h.input(false, 1); assert.equal(h.transform(), '', 'validated hold resets on release');
  h.input(false, 2); h.tick(50); assert.equal(h.transform(), '', 'coalesced click never starts hold');
  const explicit = runtime(); explicit.layer({});
  explicit.state([validate({ trigger: 'left', pressType: 'press', releaseBehavior: 'reset', duration: 100 })]);
  explicit.input(false, 1); explicit.tick(50);
  assert.equal(explicit.transform(), '', 'explicit press reset still cancels coalesced click');
  assert.equal(explicit.frames.size, 0);
}

// Delays + sequential stages execute in ms, easing per segment, whole timeline reversed.
{
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', startDelay: 20, duration: 100, easing: 'linear',
    stages: [{ delay: 30, duration: 200, easing: 'linear', effects: [] }] })]);
  r.tick(10); near(r.scale(), 1, 'start delay');
  r.tick(60); near(r.scale(), 1.2, 'base midpoint');
  r.tick(60); near(r.scale(), 1, 'stage delay');
  r.tick(120); near(r.scale(), 1.2, 'stage midpoint');
  r.tick(100); assert.equal(r.frames.size, 0, 'total = 20+100+30+200');
  const reverse = runtime(); reverse.state([reverse.layer({ trigger: 'autoplay', direction: 'reverse', startDelay: 20, duration: 100, easing: 'linear',
    stages: [{ delay: 30, duration: 200, easing: 'linear' }] })]);
  reverse.tick(100); near(reverse.scale(), 1.2, 'reverse starts with last stage');
  reverse.tick(120); near(reverse.scale(), 1, 'reverse traverses stage delay');
}
for (const easing of ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']) {
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', duration: 100, easing })]); r.tick(25);
  assert.ok(Number.isFinite(r.scale()));
  if (easing === 'linear') near(r.scale(), 1 + .2 * Math.sin(Math.PI / 4), 'linear progress');
  if (easing === 'ease-in') assert.ok(r.scale() < 1 + .2 * Math.sin(Math.PI / 4), 'ease-in accelerates');
  if (easing === 'ease-out') assert.ok(r.scale() > 1 + .2 * Math.sin(Math.PI / 4), 'ease-out decelerates');
}

// Explicit release reset/pause/reverse applies to press and hold; pause resumes hold.
for (const pressType of ['press', 'hold']) {
  for (const releaseBehavior of ['reset', 'pause', 'reverse']) {
    const r = runtime(); r.layer({});
    const CQLayers = createRequire(import.meta.url)('../src/shared/layers.js');
    r.state(CQLayers.validateLayers([{ id: 'a', type: 'model', firingOptions: { trigger: 'left', pressType, releaseBehavior, duration: 100, easing: 'linear' } }]));
    r.input(true, 1); r.tick(25); const quarter = r.scale(); r.input(false, 1);
    if (releaseBehavior === 'reset') { assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0, 'reset cancels animation'); }
    if (releaseBehavior === 'pause') {
      r.tick(20); near(r.scale(), quarter, 'paused release retains frame'); assert.equal(r.frames.size, 0);
      if (pressType === 'hold') { r.input(true, 2); r.tick(25); near(r.scale(), 1.2, 'hold resumes paused time'); }
    }
    if (releaseBehavior === 'reverse') { r.tick(10); assert.ok(r.scale() < quarter, 'reverse moves toward initial frame'); r.tick(15); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0); }
  }
}
{
  const r = runtime(); r.state([r.layer({ trigger: 'left', pressType: 'hold', duration: 100 })]);
  r.input(true, 1); r.tick(25); r.input(false, 1); r.tick(0); assert.equal(r.transform(), '', 'hold defaults to reset');
}

// Right button is independent; missing/hidden/disabled layers and malformed input cannot animate.
{
  const r = runtime(); const layers = [r.layer({ trigger: 'right', duration: 100, easing: 'linear' })];
  r.state(layers); r.input(true, 1); r.tick(25); assert.equal(r.transform(), '');
  r.window.cq.input({ available: true, left: { pressed: false, downCount: 1 }, right: { pressed: false, downCount: 1 } });
  r.tick(50); near(r.scale(), 1.2, 'right short click');
  r.state([{ ...layers[0], visible: false }]); r.tick(0); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0);
  r.state([r.layer({ trigger: 'none' })]); r.tick(0); assert.equal(r.frames.size, 0);
  r.state([r.layer({ trigger: 'left', duration: 0, startDelay: -10 })]);
  r.input(true, NaN); r.tick(0); assert.equal(r.transform(), '', 'malformed count ignored');
  r.input(false, 2); r.tick(1); assert.equal(r.frames.size, 0, 'zero duration bounded to 1ms');
  r.state([r.layer({ trigger: 'autoplay', loop: true })]); r.tick(25); r.remove('a'); r.tick(25); assert.equal(r.frames.size, 0, 'missing DOM layer clears loop');
}
// Stage easing changes its pulse, release reverse can rewind a completed timeline.
{
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', duration: 100, easing: 'linear', stages: [{ duration: 100, easing: 'ease-in' }] })]);
  r.tick(125); assert.ok(r.scale() < 1 + .2 * Math.sin(Math.PI / 4), 'stage easing applied');
  const hold = runtime(); hold.state([hold.layer({ trigger: 'left', pressType: 'hold', releaseBehavior: 'reverse', duration: 100, easing: 'linear' })]);
  hold.input(true, 1); hold.tick(100); assert.equal(hold.frames.size, 0);
  hold.input(false, 1); hold.tick(50); near(hold.scale(), 1.2, 'reverse after complete rewinds');
  hold.tick(50); assert.equal(hold.frames.size, 0);
}

// loop repeats only explicitly; repeated state and completed press never implicitly restart.
{
  const r = runtime(); const layers = [r.layer({ trigger: 'autoplay', loop: true, duration: 100, easing: 'linear' })];
  r.state(layers); r.tick(50); near(r.scale(), 1.2, 'loop first cycle');
  r.state(layers); r.tick(100); near(r.scale(), 1.2, 'state update preserves timeline'); assert.ok(r.frames.size);
  r.state([]); r.tick(0); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0);
  r.state([r.layer({ trigger: 'left', loop: true, duration: 100, easing: 'linear' })]);
  r.input(false, 1); r.tick(250); near(r.scale(), 1.2, 'press loop continues after implicit release');
}

// Stage overrides: cumulative typed effects run with the stage easing,
// hold through later segments and restore the base at the end of the timeline.
{
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', duration: 100, easing: 'linear',
    stages: [
      { duration: 100, easing: 'linear', effects: [{ property: 'scale', to: 2 }, { property: 'opacity', to: 0 }] },
      { delay: 50, duration: 100, easing: 'linear', effects: [{ property: 'x', to: 10 }, { property: 'y', to: -20 }, { property: 'rotation', to: 90 }] },
    ] })]);
  r.tick(100); assert.equal(r.transform(), '', 'pulse end of base segment');
  r.tick(50); near(r.scale(), 1.5, 'scale override interpolates toward to');
  assert.equal(r.styles().opacity, '0.5', 'opacity override multiplies layer base');
  r.tick(50); near(r.scale(), 2, 'completed stage holds final override');
  assert.equal(r.styles().opacity, '0', 'opacity holds final override');
  r.tick(25); near(r.scale(), 2, 'override survives stage delay');
  assert.equal(r.styles().opacity, '0', 'opacity survives stage delay');
  r.tick(50);
  assert.equal(r.transform(), 'translate(2.5px, 5px) rotate(22.5deg) scale(2)', 'x/y/rotation compose cumulatively');
  r.tick(75); assert.equal(r.transform(), '', 'timeline end restores base transform');
  assert.equal(r.styles().opacity, '', 'timeline end restores base opacity');
}
// Animated opacity multiplies layer opacity, including a fully transparent base.
for (const base of [0, .4, 1]) {
  const r = runtime();
  r.state([r.layer({ trigger: 'autoplay', duration: 1, stages: [{ duration: 100, easing: 'linear', effects: [{ property: 'opacity', to: 0 }] }] })]);
  r.attribute('opacity', base);
  r.tick(1); r.tick(50);
  near(Number(r.styles().opacity), base * .5, 'animated opacity respects base');
}

// Out-of-range `to` values are clamped to the contract bounds; empty effects keep the pulse.
{
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', duration: 0, easing: 'linear',
    stages: [{ duration: 100, easing: 'linear', effects: [{ property: 'scale', to: 99 }, { property: 'opacity', to: -1 }] }] })]);
  r.tick(1); r.tick(50);
  near(r.scale(), 1 + .5 * (8 - 1), 'scale to clamped to 8');
  assert.equal(r.styles().opacity, '0.5', 'opacity to clamped to 0');
}
{
  const r = runtime(); r.state([r.layer({ trigger: 'autoplay', duration: 100, easing: 'linear',
    stages: [{ duration: 100, easing: 'linear', effects: [] }] })]);
  r.tick(150); near(r.scale(), 1.2, 'empty effects keep the scale pulse');
  r.tick(50); assert.equal(r.transform(), '', 'pulse stage restores base');
}

// Reduced motion, disabled/removed layers, disconnect, unload cancel runtime and clean styles.
{
  const r = runtime(); const layers = [r.layer({ trigger: 'left', duration: 100, loop: true })];
  r.state(layers); r.input(true, 1); r.tick(25);
  r.input(false, 1, { available: false, error: 'disconnected' }); r.tick(0);
  assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0, 'disconnect cancels even one-shot');
  r.input(false, 2); r.tick(25); r.mq.matches = true; r.mq.change();
  assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0); assert.equal(r.primary.style.display, 'block');
  r.input(false, 3); r.mq.matches = false; r.mq.change(); r.tick(0); assert.equal(r.transform(), '', 'reduced input not replayed');
  r.state([r.layer({ trigger: 'autoplay', loop: true })]); r.tick(25);
  const stateCallback = r.window.cq.state, inputCallback = r.window.cq.input;
  r.listeners.pagehide(); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0); assert.equal(r.window.cq.input, null); assert.equal(r.mq.change, null);
  r.listeners.beforeunload(); r.listeners.pagehide();
  stateCallback({ layers }); inputCallback({ available: true, left: { pressed: true, downCount: 4 } });
  assert.equal(r.frames.size, 0, 'dispose is idempotent and ignores late IPC');
}
// Rebuilding SVG with the same layer id must not retain a connected stale node.
{
  const r = runtime(); const fo = { trigger: 'autoplay', loop: true, duration: 100, easing: 'linear' };
  r.state([r.layer(fo)]); r.tick(25); const previous = r.styles();
  r.state([r.layer(fo)]); r.tick(25);
  assert.notEqual(r.styles(), previous); near(r.scale(), 1.2, 'new SVG node receives ongoing animation');
  assert.notEqual(r.styles().transform, previous.transform, 'cached previous SVG node is not painted');
  r.listeners.beforeunload(); assert.equal(r.transform(), ''); assert.equal(r.frames.size, 0);
}

// Dispose before the first frame cancels pending snap and animation exactly once.
for (const event of ['pagehide', 'beforeunload']) {
  const r = runtime();
  r.state([r.layer({ trigger: 'autoplay', loop: true })]);
  assert.equal(r.frames.size, 2, 'snap and animation pending before first tick');
  r.listeners[event]();
  assert.equal(r.frames.size, 0, 'pending snap and animation cancelled');
  assert.equal(r.window.cq.state, null); assert.equal(r.window.cq.input, null);
  r.listeners.pagehide(); r.listeners.beforeunload();
  assert.deepEqual(r.unsubscribes, { state: 1, input: 1 }, 'subscriptions removed exactly once');
}

// Scale once, both models + drawing. Preserve exact fractional viewport center;
// no pixel-grid nudge and no offset scaling, including hidden secondary.
for (const dpr of [1, 1.25, 1.5, 2]) {
  const r = runtime({ dpr }); r.state([], { scale: 2, crosshairSize: 1.5, offsetX: 7, offsetY: -4, crosshairOffset: { x: 2, y: 1 }, model: { outline: { enabled: true, color: '#000', width: 2 } } });
  r.tick(0);
  assert.equal(r.primary.firstElementChild.children[0].children[0].attributes.width, 8, 'geometry unscaled');
  assert.equal(r.primary.firstElementChild.children[0].children[0].attributes['stroke-width'], 2, 'outline unscaled');
  assert.equal(r.secondary.firstElementChild.children[0].children[0].attributes.width, 8, 'secondary unscaled');
  assert.equal(r.primary.style.transform, 'translate(361.5px, 145.5px) scale(3)', 'exact odd viewport center; offsets added once');
  assert.equal(r.secondary.style.transform, r.primary.style.transform);
  assert.equal(r.primary.style.left, '0px'); assert.equal(r.primary.style.top, '0px');
  r.state([], { drawing: '<g id="drawing"/>', scale: 2 }); r.tick(0);
  assert.equal(r.primary.firstElementChild.html, '<g id="drawing"/>'); assert.ok(r.primary.style.transform.endsWith('scale(2)'));
}
// Resize/zoom may change fractional CSS viewport without any state broadcast.
{
  const r = runtime(); r.state([], { scale: .5 }); r.tick(0);
  r.viewport.width = 768.796875; r.viewport.height = 432.796875;
  r.listeners.resize(); r.listeners.resize();
  assert.equal(r.frames.size, 1, 'resize coalesces pending position frame');
  r.tick(0);
  assert.equal(r.primary.style.transform, 'translate(256.3984375px, 88.3984375px) scale(0.5)');
  r.window.cq.state(undefined); r.listeners.resize(); assert.equal(r.frames.size, 0, 'no-state resize safe');
  const resize = r.listeners.resize;
  r.listeners.pagehide(); assert.equal(r.listeners.resize, undefined, 'resize listener removed on dispose');
  resize(); assert.equal(r.frames.size, 0, 'late resize after dispose ignored');
}
// Aim uses the existing fixed right input, never canonical visibility or animation frames.
const aimBinding = createRequire(import.meta.url)('../src/main/state.js').DEFAULTS.keybinds.aim;
function aiming(pressType = 'hold', baseline = true) {
  const r = runtime();
  let extra = { keybinds: { aim: { ...aimBinding, enabled: true, pressType } }, profiles: { currentProfileId: 'default' } };
  const render = (patch = {}) => { extra = { ...extra, ...patch }; r.state([], extra); };
  render();
  if (baseline) r.input(false, 0);
  return { ...r, render, right: (pressed, downCount, status = {}) => r.input(false, 0, { right: { pressed, downCount }, ...status }) };
}
for (const pressType of ['hold', 'toggle']) {
  const r = aiming(pressType);
  r.right(true, 1); assert.equal(r.primary.style.display, 'none', `${pressType} down hides immediately`);
  r.right(true, 1); assert.equal(r.primary.style.display, 'none', 'same pressed snapshot never toggles again');
  r.render(); assert.equal(r.primary.style.display, 'none', 'unrelated state keeps aim');
  r.right(false, 1); assert.equal(r.primary.style.display, pressType === 'hold' ? 'block' : 'none', `${pressType} release`);
  r.right(true, 2); assert.equal(r.primary.style.display, pressType === 'hold' ? 'none' : 'block', `${pressType} second down`);
  r.right(false, 2);
  const before = r.writes();
  r.right(false, 3); assert.equal(r.primary.style.display, pressType === 'hold' ? 'block' : 'none', 'click between frames');
  r.right(false, 5); assert.equal(r.primary.style.display, pressType === 'hold' ? 'block' : 'none', 'two coalesced downs preserve parity');
  assert.equal(r.writes(), before, 'aim input never rebuilds SVG');
  r.right(false, 6); assert.equal(r.primary.style.display, 'block', 'next short click restores toggle');
  r.mq.matches = true; r.mq.change();
  r.right(true, 7); assert.equal(r.primary.style.display, 'none', 'reduced motion does not disable aim');
  r.right(false, 7);
  r.render({ showSecondary: true });
  r.right(true, 8); r.right(false, 8);
  assert.equal(r.primary.style.display, 'none', 'secondary selection preserved');
  assert.equal(r.secondary.style.display, 'block');
  r.right(true, 9); assert.equal(r.secondary.style.display, 'none', 'aim hides secondary too');
  r.render({ profiles: { currentProfileId: 'other' } });
  assert.equal(r.secondary.style.display, 'block', 'profile change clears hold/latch');
  r.right(false, 9); r.right(true, 10);
  r.render({ keybinds: { aim: { ...aimBinding, pressType, enabled: false } } });
  assert.equal(r.secondary.style.display, 'block', 'disabling aim clears hold/latch');
  r.right(false, 10); r.right(true, 11); assert.equal(r.secondary.style.display, 'block', 'disabled aim ignores right input');
  r.render({ keybinds: { aim: { ...aimBinding, pressType } } });
  assert.equal(r.secondary.style.display, 'block', 'enabling aim does not restore old hold/latch');
}
for (const status of [{ available: false }, { error: 'input failed' }]) {
  for (const pressType of ['hold', 'toggle']) {
    const r = aiming(pressType);
    r.right(true, 1); r.right(false, 4, status);
    assert.equal(r.primary.style.display, 'block', 'unavailable/error clears hold/latch');
    r.right(false, 4); assert.equal(r.primary.style.display, 'block', 'recovery does not replay missed clicks');
    r.right(true, 5); assert.equal(r.primary.style.display, 'none', 'new down after recovery works');
  }
}
for (const aim of [undefined, { ...aimBinding, pressType: 'press' }, { ...aimBinding, enabled: false }]) {
  const r = runtime(); r.state([], { keybinds: { aim } });
  r.input(false, 0, { right: { pressed: true, downCount: 1 } });
  assert.equal(r.primary.style.display, 'block', 'only an existing supported enabled aim config activates');
}
{
  const r = aiming('toggle');
  r.right(false, 1);
  r.render({ keybinds: { aim: { ...aimBinding, pressType: 'hold' } } });
  assert.equal(r.primary.style.display, 'block', 'config change clears toggle');
}
for (const gate of [{ hidden: true }, { visible: false }, { profileInFocus: false }, { onlyInGame: true, gameInFocus: false }]) {
  const r = aiming('toggle'); r.render(gate);
  r.right(false, 1); r.right(false, 2);
  assert.equal(r.primary.style.display, 'none', 'aim cannot override canonical game/profile/visibility gates');
  r.render({ hidden: false, visible: true, profileInFocus: true, onlyInGame: false });
  assert.equal(r.primary.style.display, 'block', 'canonical gates remain independent of aim');
}
{
  const r = aiming('toggle'); r.right(false, 1);
  r.render({ hidden: true }); r.right(false, 2);
  assert.equal(r.primary.style.display, 'none', 'clearing aim never clears global hidden');
  r.render({ hidden: false }); assert.equal(r.primary.style.display, 'block');
  r.right(false, 3); r.render({ hidden: true }); r.render({ hidden: false });
  assert.equal(r.primary.style.display, 'none', 'global toggle never clears aim latch');
  r.right(false, 4); assert.equal(r.primary.style.display, 'block');
}
{
  const r = aiming();
  const state = Object.freeze({ visible: true, hidden: false, scale: 1, offsetX: 0, offsetY: 0, layers: [], keybinds: { aim: aimBinding } });
  r.window.cq.state(state); r.right(true, 1); r.right(false, 1);
  assert.equal(state.hidden, false); assert.equal(state.visible, true);
}
// Exercise the actual change-only input transport, including snapshots with historical counters.
const { createInputMonitor } = createRequire(import.meta.url)('../src/main/input.js');
for (const pressType of ['hold', 'toggle']) {
  const r = aiming(pressType, false);
  let mouse = { running: true, errorCode: 0, left: { pressed: false, downCount: 0 }, right: { pressed: false, downCount: 3 } };
  let emissions = 0;
  const monitor = createInputMonitor({
    startMouseInput() {}, stopMouseInput() {}, getMouseSnapshot: () => mouse,
  }, (snapshot) => { emissions++; r.window.cq.input(snapshot); });
  monitor.start();
  try {
    assert.equal(monitor.getStatus().right.downCount, 3);
    assert.equal(r.primary.style.display, 'block', 'initial historical odd counter is only a toggle baseline');
    mouse = { ...mouse, right: { pressed: true, downCount: 4 } }; monitor.poll();
    assert.equal(r.primary.style.display, 'none', 'first new down after initial baseline hides');
    mouse = { ...mouse, running: false, errorCode: 6 }; monitor.poll();
    assert.equal(r.primary.style.display, 'block', 'input failure clears hold/latch');
    mouse = { ...mouse, running: true, errorCode: 0, right: { pressed: true, downCount: 7 } }; monitor.poll();
    const recovered = emissions;
    for (let i = 0; i < 100; i++) monitor.poll();
    assert.equal(emissions, recovered, '100 unchanged polls emit no recovery follow-up');
    assert.equal(r.primary.style.display, pressType === 'hold' ? 'none' : 'block', 'recovery uses held state but never replays toggle history');
    mouse = { ...mouse, right: { pressed: false, downCount: 7 } }; monitor.poll();
    assert.equal(r.primary.style.display, 'block', 'release after recovery');
    mouse = { ...mouse, right: { pressed: true, downCount: 8 } }; monitor.poll();
    assert.equal(r.primary.style.display, 'none', 'new down after recovery still works');
  } finally { monitor.stop(); }
}
console.log('PASS: overlay animations/geometry/cleanup; aim hold/toggle, coalesced edges, integrated input baseline/recovery + 100 unchanged polls, profile/config reset, disabled, reduced motion, canonical gates');
