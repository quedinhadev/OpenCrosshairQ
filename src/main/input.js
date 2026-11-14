// Aggregated mouse/XInput state; no input synthesis. Counters preserve brief mouse clicks.
function createInputMonitor(native, onChange) {
  let timer = null;
  let started = false;
  let mouseStarted = false;
  let error = null;
  let lastMouse = { left: 0, right: 0 };
  let lastPad = { left: false, right: false };
  let state = { available: false, mouseAvailable: false, controllersAvailable: false, error: null, mouse: {}, controllers: [], actionsDispatched: true, left: { pressed: false, downCount: 0 }, right: { pressed: false, downCount: 0 } };
  function emit(next) {
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; onChange(structuredClone(state)); }
  }
  function poll() {
    let mouse = null;
    let pads = null;
    let currentError = error;
    try { if (mouseStarted) mouse = native.getMouseSnapshot(); }
    catch (failure) { currentError = failure.message; }
    try { pads = native?.getXInputSnapshot?.(); }
    catch (failure) { currentError = failure.message; }
    const mouseAvailable = !!(mouse?.running && mouse.errorCode === 0);
    const controllersAvailable = pads?.available === true;
    if (mouse && !mouseAvailable) currentError = `Mouse input unavailable (${mouse.errorCode})`;
    const next = { available: mouseAvailable || controllersAvailable, mouseAvailable, controllersAvailable, error: currentError,
      mouse: mouseAvailable ? { left: mouse.left, right: mouse.right, middle: mouse.middle } : {},
      controllers: controllersAvailable ? pads.controllers || [] : [], actionsDispatched: true };
    for (const key of ['left', 'right']) {
      const mouseCount = mouseAvailable ? mouse[key].downCount : lastMouse[key];
      const padPressed = !!(controllersAvailable && pads.controllers?.some(pad => pad.connected && (key === 'left' ? pad.rightTrigger : pad.leftTrigger) > 0));
      const increment = Math.max(0, mouseCount - lastMouse[key]) + Number(padPressed && !lastPad[key]);
      next[key] = {
        pressed: !!(mouseAvailable && mouse[key].pressed) || padPressed,
        downCount: Math.min(Number.MAX_SAFE_INTEGER, state[key].downCount + increment),
      };
      lastMouse[key] = mouseCount;
      lastPad[key] = padPressed;
    }
    emit(next);
  }
  return {
    poll,
    getStatus: () => structuredClone(state),
    start() {
      if (started) return;
      started = true;
      try { if (native?.startMouseInput) { native.startMouseInput(); mouseStarted = true; } }
      catch (failure) { error = failure.message; }
      poll();
      // ponytail: 8 ms polling is not a real-time guarantee; event transport if latency requires it.
      if (native) { timer = setInterval(poll, 8); timer.unref(); }
    },
    stop() {
      if (!started) return;
      clearInterval(timer); timer = null; started = false;
      if (mouseStarted) {
        try { native.stopMouseInput(); } catch (failure) { error = failure.message; }
        mouseStarted = false;
      }
      lastMouse = { left: 0, right: 0 };
      lastPad = { left: false, right: false };
      emit({ ...state, available: false, mouseAvailable: false, controllersAvailable: false, error, mouse: {}, controllers: [], left: { ...state.left, pressed: false }, right: { ...state.right, pressed: false } });
    },
  };
}

// Passive keyboard observation for user-configured shortcuts. The native hook
// only reports transitions; it never blocks or rewrites input.
function createKeyboardMonitor(native, onChange) {
  let timer = null;
  let started = false;
  let state = { running: false, error: null, keys: {} };
  function emit(next) {
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; onChange(structuredClone(state)); }
  }
  function poll() {
    let snapshot = null;
    let currentError = null;
    try { snapshot = native.getKeyboardSnapshot(); }
    catch (failure) { currentError = failure.message; }
    const next = {
      running: !!snapshot?.running,
      error: currentError,
      keys: snapshot?.keys && typeof snapshot.keys === 'object' ? snapshot.keys : {},
    };
    if (snapshot && !snapshot.running && !next.error) next.error = `Keyboard input unavailable (${snapshot.errorCode})`;
    emit(next);
  }
  return {
    poll,
    getStatus: () => structuredClone(state),
    start() {
      if (started) return;
      started = true;
      try { if (native?.startKeyboardInput) native.startKeyboardInput(); }
      catch (failure) {
        // Hook failed to install: report it and do not poll a dead monitor.
        emit({ running: false, error: failure.message, keys: {} });
        return;
      }
      poll();
      // ponytail: same 8 ms polling as the mouse monitor; switch to event transport if latency requires it.
      if (native) { timer = setInterval(poll, 8); timer.unref(); }
    },
    stop() {
      if (!started) return;
      clearInterval(timer); timer = null; started = false;
      try { native?.stopKeyboardInput?.(); } catch (error) { console.error('[keyboard]', error.message); }
      emit({ running: false, error: null, keys: {} });
    },
  };
}

module.exports = { createInputMonitor, createKeyboardMonitor };
