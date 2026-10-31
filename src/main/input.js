// Aggregated mouse/XInput state; no input synthesis. Counters preserve brief mouse clicks.
function createInputMonitor(native, onChange) {
  let timer = null;
  let started = false;
  let mouseStarted = false;
  let error = null;
  let lastMouse = { left: 0, right: 0 };
  let lastPad = { left: false, right: false };
  let state = { available: false, error: null, left: { pressed: false, downCount: 0 }, right: { pressed: false, downCount: 0 } };
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
    const mouseAvailable = mouse?.running && mouse.errorCode === 0;
    if (mouse && !mouseAvailable) currentError = `Mouse input unavailable (${mouse.errorCode})`;
    const next = { available: !!(mouseAvailable || pads?.available), error: currentError };
    for (const key of ['left', 'right']) {
      const mouseCount = mouseAvailable ? mouse[key].downCount : lastMouse[key];
      const padPressed = !!pads?.controllers?.some(pad => pad.connected && (key === 'left' ? pad.rightTrigger : pad.leftTrigger) > 0);
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
      if (mouseStarted) { native.stopMouseInput(); mouseStarted = false; }
      lastMouse = { left: 0, right: 0 };
      lastPad = { left: false, right: false };
      emit({ ...state, available: false, left: { ...state.left, pressed: false }, right: { ...state.right, pressed: false } });
    },
  };
}
module.exports = { createInputMonitor };
