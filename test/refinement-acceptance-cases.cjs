// Declarative contracts supplied by owners after freeze; no guessed production APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clone = value => JSON.parse(JSON.stringify(value));
function field(value, key) { return key.split('.').reduce((v, k) => v?.[k], value); }
function validateContract(c) {
  assert.ok(c && typeof c === 'object' && !Array.isArray(c));
  for (const key of Object.keys(c)) assert.ok(['aim', 'controls', 'process', 'clamp', 'motion', 'lifecycle'].includes(key), 'unknown contract: ' + key);
  if (c.aim) { assert.equal(typeof c.aim.selector, 'string'); assert.equal(typeof c.aim.statePath, 'string'); assert.ok(Object.hasOwn(c.aim, 'off')); }
  if (c.controls) {
    assert.ok(Array.isArray(c.controls) && c.controls.length > 0);
    assert.equal(new Set(c.controls.map(v => v.action)).size, c.controls.length);
    for (const v of c.controls) { assert.equal(typeof v.action, 'string'); assert.equal(typeof v.selector, 'string'); }
  }
  if (c.process) {
    for (const k of ['selectionPath', 'statusSelector', 'expectedStatus', 'nativeMethod']) assert.equal(typeof c.process[k], 'string');
    assert.ok(Object.hasOwn(c.process, 'expectedSelection') && (c.process.expectedSelection === null || typeof c.process.expectedSelection === 'string'));
  }
  if (c.clamp) { assert.match(c.clamp.key, /^[a-zA-Z][a-zA-Z0-9]*$/); assert.notEqual(c.clamp.key, 'minimizeToTray'); }
  if (c.lifecycle) {
    assert.match(c.lifecycle.key, /^[a-zA-Z][a-zA-Z0-9]*$/);
    assert.notEqual(c.lifecycle.key, 'minimizeToTray');
    for (const key of ['initial', 'visible', 'minimized']) assert.equal(typeof c.lifecycle[key], 'boolean');
  }
  if (c.motion) {
    for (const k of ['triggerSelector', 'targetSelector']) assert.equal(typeof c.motion[k], 'string');
    assert.ok(c.motion.durationMs >= 120 && c.motion.durationMs <= 200);
    for (const k of ['startOpacity', 'midOpacity', 'endOpacity']) assert.ok(Number.isFinite(c.motion[k]) && c.motion[k] >= 0 && c.motion[k] <= 1);
    assert.notEqual(c.motion.startOpacity, c.motion.endOpacity, 'opacity oracle must detect a missing transition');
  }
  return c;
}
function summarize(results) {
  return { results, ...Object.fromEntries(Object.entries({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP', notExecuted: 'NOT_EXECUTED' }).map(([k, v]) => [k, results.filter(r => r.verdict === v).length])) };
}
function near(actual, expected, tolerance) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Number.isFinite(tolerance) && tolerance >= 0);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}; tolerance=${tolerance}`);
}
async function runCases({ app, ui, overlay, run, get, set, wait, output, loginWrites }) {
  const contract = validateContract(JSON.parse(fs.readFileSync(path.join(output, 'contract.json'), 'utf8')));
  const results = [];
  const save = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
  async function check(id, fn) {
    const start = Date.now();
    try { const observed = await fn(); results.push({ id, verdict: 'PASS', elapsedMs: Date.now() - start, observed }); }
    catch (error) {
      const result = { id, verdict: 'FAIL', elapsedMs: Date.now() - start, error: error.stack };
      try {
        result.capture = 'failure-' + id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
        fs.writeFileSync(path.join(output, result.capture), (await ui.webContents.capturePage()).toPNG());
      } catch (captureError) { result.captureError = captureError.message; }
      results.push(result);
    }
    save('cases', summarize(results));
  }
  function pending(id, reason) { results.push({ id, verdict: 'NOT_EXECUTED', reason }); }
  const inspect = selector => run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');return {disabled:e.disabled,value:e.value,options:e.options?[...e.options].map(o=>o.value):null,pressed:e.getAttribute('aria-pressed')}})()`);
  await check('isolation', async () => {
    assert.equal(app.getPath('userData'), process.env.CQ_UX_PROFILE);
    assert.equal(app.getPath('sessionData'), process.env.CQ_REFINEMENT_SESSION);
    assert.notEqual(app.getPath('userData'), app.getPath('sessionData'));
    return { userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), executable: process.execPath, versions: process.versions, packaged: app.isPackaged, native: await run('window.cq.getNativeStatus()') };
  });
  if (contract.aim) await check('A01-default-aim-off', async () => {
    const state = await get(), control = await inspect(contract.aim.selector);
    assert.equal(field(state, contract.aim.statePath), contract.aim.off);
    assert.equal(control.disabled, false);
    assert.deepEqual(control.options, ['off', 'hold', 'toggle']);
    assert.equal(control.value, 'off'); return { control, aim: state.keybinds.aim };
  }); else pending('A01-default-aim-off', 'owner must supply aim selector and canonical off field/value');
  if (contract.controls) {
    await check('A05-action-inventory', async () => {
      const state = await get();
      const actions = Object.entries(state.keybinds).filter(([, v]) => v && !Array.isArray(v) && typeof v === 'object').map(([k]) => k).sort();
      assert.deepEqual(contract.controls.map(c => c.action).sort(), actions, 'contract must cover every configured action');
      return actions;
    });
    for (const item of contract.controls) await check('A05-control-' + item.action, async () => {
      const control = await inspect(item.selector); assert.equal(control.disabled, false);
      return control;
    });
  } else pending('A05-enabled-controls', 'owner must enumerate every action and accessible enabled control selector; execution effects not covered here');
  pending('A05-executor-effects', 'enabled DOM is not executor proof; backend/runtime own disabled/enabled effect regressions');
  if (contract.process) await check('F01-process-status-IPC-read', async () => {
    const p = contract.process;
    const observed = await run(`(async()=>{const state=await window.cq.getState();const method=window.cq[${JSON.stringify(p.nativeMethod)}];if(typeof method!=='function')throw Error('missing native status IPC');const native=await method();const e=document.querySelector(${JSON.stringify(p.statusSelector)});if(!e)throw Error('missing status');return {state,native,status:e.textContent}})()`);
    assert.equal(field(observed.state, p.selectionPath), p.expectedSelection);
    assert.equal(observed.status, p.expectedStatus);
    assert.ok(observed.native && typeof observed.native === 'object');
    return observed;
  }); else pending('F01-process-status-IPC-read', 'selection/status contract pending; no process selection injected');
  pending('F03-process-live-transition', 'requires owner contract and deterministic native boundary; read-only IPC check is not live focus proof');
  if (contract.clamp) await check('C01-clamp-tray-invariance', async () => {
    const before = clone(await get()), key = contract.clamp.key, observations = [];
    assert.equal(typeof before[key], 'boolean'); assert.equal(typeof before.minimizeToTray, 'boolean');
    try {
      for (const clamp of [false, true]) {
        await set({ [key]: clamp }); await wait(async () => (await get())[key] === clamp, 'clamp echo');
        assert.equal((await get()).minimizeToTray, before.minimizeToTray);
        for (const tray of [false, true]) {
          await set({ minimizeToTray: tray }); await wait(async () => (await get()).minimizeToTray === tray, 'tray echo');
          assert.equal((await get())[key], clamp); observations.push({ clamp, tray });
        }
        await set({ minimizeToTray: before.minimizeToTray });
        await wait(async () => (await get()).minimizeToTray === before.minimizeToTray, 'restore tray before clamp');
      }
    } finally {
      await set({ [key]: before[key], minimizeToTray: before.minimizeToTray });
      await wait(async () => { const s = await get(); return s[key] === before[key] && s.minimizeToTray === before.minimizeToTray; }, 'restore options');
    }
    return observations;
  }); else pending('C01-clamp-tray-invariance', 'canonical clamp key pending');
  if (contract.lifecycle) await check('W02-minimized-lifecycle', async () => {
    const c = contract.lifecycle;
    await wait(async () => (await get())[c.key] === c.initial, 'initial lifecycle preference');
    await wait(() => ui.isVisible() === c.visible && ui.isMinimized() === c.minimized, 'initial native lifecycle');
    const initial = { visible: ui.isVisible(), minimized: ui.isMinimized(), preference: (await get())[c.key] };
    ui.restore(); ui.show(); // Own window only; recovery API, not proof of physical tray click.
    await wait(() => ui.isVisible() && !ui.isMinimized(), 'own-window recovery');
    assert.equal((await get())[c.key], c.initial, 'recovery must not rewrite preference');
    return { initial, recovery: { visible: ui.isVisible(), minimized: ui.isMinimized() }, scope: 'native window state; no login or physical tray proof' };
  }); else pending('W02-minimized-lifecycle', 'supply owner-defined initial preference and exact native visible/minimized state; each contract runs in a separate child');
  await check('U02-responsive', async () => {
    const observations = [];
    for (const [width, height] of [[1040, 660], [1280, 820]]) {
      ui.setContentSize(width, height); await wait(() => run(`innerWidth===${width}&&innerHeight===${height}`), 'client dimensions');
      for (const route of ['crosshairs', 'designer', 'keybinds', 'positions', 'startup']) {
        await run(`(()=>{const e=document.querySelector('[data-route="${route}"]');if(!e)throw Error('missing route');e.click()})()`);
        await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const dimensions = await run('({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth})');
        fs.writeFileSync(path.join(output, `layout-${width}x${height}-${route}.png`), (await ui.webContents.capturePage()).toPNG());
        assert.equal(dimensions.scrollWidth, dimensions.width, route + ' horizontal overflow');
        observations.push({ route, ...dimensions });
      }
    }
    return observations;
  });
  if (contract.motion) {
    const m = contract.motion, debuggerApi = ui.webContents.debugger;
    await check('U04-motion-frames', async () => {
      const animations = await run(`(()=>{document.querySelector(${JSON.stringify(m.triggerSelector)}).click();const e=document.querySelector(${JSON.stringify(m.targetSelector)});if(!e)throw Error('missing motion target');const a=e.getAnimations();a.forEach(x=>x.pause());return a.map(x=>({duration:x.effect.getTiming().duration,playbackRate:x.playbackRate}))})()`);
      try {
        assert.equal(animations.length, 1, 'one animation required by supplied contract');
        assert.equal(animations[0].duration, m.durationMs); assert.equal(animations[0].playbackRate, 1);
        const frames = [];
        for (const [name, time, expected] of [['0', 0, m.startOpacity], ['mid', m.durationMs / 2, m.midOpacity], ['end', m.durationMs, m.endOpacity]]) {
          const metrics = await run(`(async()=>{const e=document.querySelector(${JSON.stringify(m.targetSelector)});for(const a of e.getAnimations())a.currentTime=${time};await new Promise(requestAnimationFrame);const s=getComputedStyle(e);return {opacity:Number(s.opacity),transform:s.transform}})()`);
          fs.writeFileSync(path.join(output, `motion-${name}.png`), (await ui.webContents.capturePage()).toPNG());
          near(metrics.opacity, expected, .02); frames.push({ name, time, ...metrics });
        }
        save('motion', frames); return frames;
      } finally { await run(`document.querySelector(${JSON.stringify(m.targetSelector)})?.getAnimations().forEach(a=>a.cancel());void 0`); }
    });
    await check('U05-reduced-motion', async () => {
      assert.equal(debuggerApi.isAttached(), false, 'do not replace another debugger');
      debuggerApi.attach('1.3');
      try {
        await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const loaded = require('node:events').once(ui.webContents, 'did-finish-load');
        ui.reload(); await loaded;
        await wait(() => run(`!!document.querySelector(${JSON.stringify(m.triggerSelector)})&&!!document.querySelector(${JSON.stringify(m.targetSelector)})`).catch(() => false), 'fresh reduced-motion controls');
        const metrics = await run(`(async()=>{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)throw Error('media not applied');document.querySelector(${JSON.stringify(m.triggerSelector)}).click();await new Promise(requestAnimationFrame);const e=document.querySelector(${JSON.stringify(m.targetSelector)}),s=getComputedStyle(e);return {opacity:Number(s.opacity),transform:s.transform,animations:e.getAnimations().filter(a=>a.playState==='running').length}})()`);
        fs.writeFileSync(path.join(output, 'motion-reduced.png'), (await ui.webContents.capturePage()).toPNG());
        assert.equal(metrics.animations, 0); near(metrics.opacity, m.endOpacity, .02); return metrics;
      } finally { try { await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } finally { debuggerApi.detach(); } }
    });
  } else { pending('U04-motion-frames', 'design must supply trigger/target, duration and independent start/mid/end opacity expectations'); pending('U05-reduced-motion', 'same motion contract pending'); }
  await check('login-writes-blocked', async () => { assert.equal(loginWrites(), 0); return { attempts: loginWrites() }; });
  save('summary', summarize(results));
  return summarize(results);
}
module.exports = { field, near, summarize, validateContract, runCases };
