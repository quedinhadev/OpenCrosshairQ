const { isBindingDown, bindingDownCount, modifiersDown } = require('./keymap');
const ACTIONS = ['aim', 'fire', 'reload'];
const BUTTONS = { dpadUp: 0x1, dpadDown: 0x2, dpadLeft: 0x4, dpadRight: 0x8, start: 0x10, back: 0x20, leftThumb: 0x40, rightThumb: 0x80, leftShoulder: 0x100, rightShoulder: 0x200, faceSouth: 0x1000, faceEast: 0x2000, faceWest: 0x4000, faceNorth: 0x8000 };
const CONTROLLER_KEYS = [...Object.keys(BUTTONS), 'leftTrigger', 'rightTrigger'];
const sourceAvailable = (input, source) => input[source] ?? (input.available === true && !input.error);
function controllerDown(key, controllers) {
  return CONTROLLER_KEYS.includes(key) && (controllers || []).some(pad => pad.connected && (key === 'leftTrigger' || key === 'rightTrigger' ? pad[key] > 0 : !!(pad.buttons & BUTTONS[key])));
}
function createKeybindDispatcher(getBindings, send) {
  let keyboard = { keys: {} }, input = {}, capturing = false;
  let keyboardSeen = false, inputSeen = false;
  const previous = {};
  function sample(binding) {
    const keys = keyboard.running ? keyboard.keys : {};
    const side = { LeftClick: 'left', RightClick: 'right', MiddleClick: 'middle' }[binding?.pc?.key];
    const mouse = sourceAvailable(input, 'mouseAvailable') ? input.mouse?.[side] : null;
    const modifiers = modifiersDown(binding, keys);
    const pcHeld = side ? !!mouse?.pressed : isBindingDown({ pc: { key: binding?.pc?.key } }, keys);
    const pad = !!(sourceAvailable(input, 'controllersAvailable') && controllerDown(binding?.controller?.key, input.controllers));
    return {
      down: !!binding && binding.enabled !== false && (pcHeld && modifiers || pad),
      held: pcHeld || pad, pcHeld, pad,
      count: side ? mouse?.downCount || 0 : bindingDownCount(binding, keys),
      modifiers,
    };
  }
  function dispatch(recovered = false, recoveredSources = {}) {
    for (const action of ACTIONS) {
      const binding = getBindings()?.[action];
      const current = sample(binding);
      const prior = previous[action] || { down: false, count: 0, blocked: false, pad: false };
      // A single provider can recover while the other stays live; baseline its
      // counters/held toggle without interrupting the healthy source.
      const actionRecovered = recovered
        || recoveredSources.mouse && ['LeftClick', 'RightClick', 'MiddleClick'].includes(binding?.pc?.key) && !prior.pad && !current.pad
        || recoveredSources.controllers && current.pad && !prior.pcHeld && !current.pcHeld;
      // Capture/profile changes block physical holds, even if their modifier is not down yet.
      const freshPress = !actionRecovered && current.count > prior.count && current.modifiers;
      const blocked = capturing || prior.blocked && current.held && !freshPress
        || actionRecovered && binding?.pressType !== 'hold' && current.held;
      const taps = binding && binding.enabled !== false && current.modifiers && !prior.pad && !current.pad && !actionRecovered
        ? Math.max(0, current.count - prior.count) : 0;
      const presses = taps || Number(current.down && !prior.down);
      previous[action] = { ...current, blocked };
      if (blocked) continue;
      if (presses) {
        if (prior.down && action !== 'reload') send({ action, pressed: false });
        for (let n = 0; n < presses; n++) {
          send({ action, pressed: true });
          if (action !== 'reload' && (!current.down || binding?.pressType === 'press' || n < presses - 1)) send({ action, pressed: false });
        }
      } else if (prior.down && !prior.blocked && !current.down && action !== 'reload') send({ action, pressed: false });
    }
  }
  function reset() {
    send({ action: 'reset', pressed: false });
    for (const action of ACTIONS) {
      const current = sample(getBindings()?.[action]);
      previous[action] = { ...current, down: false, blocked: current.held };
    }
  }
  function unavailable() {
    send({ action: 'reset', pressed: false });
    for (const action of ACTIONS) {
      const current = sample(getBindings()?.[action]);
      previous[action] = { ...current, down: false, blocked: capturing || !!previous[action]?.blocked };
    }
  }
  return {
    keyboard(status) {
      const recovered = !keyboardSeen || !keyboard.running && !!status.running;
      const lost = !!keyboard.running && !status.running;
      keyboardSeen = true; keyboard = status;
      if (lost) unavailable();
      dispatch(recovered || lost);
    },
    input(status) {
      const valid = value => sourceAvailable(value, 'mouseAvailable') || sourceAvailable(value, 'controllersAvailable');
      const recovered = !inputSeen || !valid(input) && valid(status);
      const lost = valid(input) && !valid(status);
      const recoveredSources = {
        mouse: !sourceAvailable(input, 'mouseAvailable') && sourceAvailable(status, 'mouseAvailable'),
        controllers: !sourceAvailable(input, 'controllersAvailable') && sourceAvailable(status, 'controllersAvailable'),
      };
      inputSeen = true; input = status;
      if (lost) unavailable();
      dispatch(recovered || lost, recoveredSources);
    },
    reset,
    capture(value) { if (capturing === value) return; capturing = value; reset(); },
  };
}
module.exports = { createKeybindDispatcher, controllerDown, CONTROLLER_KEYS };
