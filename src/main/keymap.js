// Maps user-configured accelerators to Windows virtual-key codes so the passive
// keyboard hook can report whether a binding is held. Observation only: nothing
// is synthesized or suppressed.
const KEY_CODES = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde, '+': 0xbb,
  Control: 0x11, Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Meta: 0x5b, Super: 0x5b,
};

// Returns 0 for keys the keyboard hook cannot observe (mouse buttons, unknown names).
function keyCode(name) {
  if (typeof name !== 'string' || !name) return 0;
  if (Object.hasOwn(KEY_CODES, name)) return KEY_CODES[name];
  if (/^[A-Za-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return 0x30 + Number(name);
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(name);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  return 0;
}

const MODIFIER_CODES = { Ctrl: [0x11, 0xa2, 0xa3], Control: [0x11, 0xa2, 0xa3], Alt: [0x12, 0xa4, 0xa5], Shift: [0x10, 0xa0, 0xa1], Meta: [0x5b, 0x5c], Super: [0x5b, 0x5c] };
function keyCodes(name) { return MODIFIER_CODES[name] || [keyCode(name)].filter(Boolean); }
function isKeyDown(name, keys) { return keyCodes(name).some(code => keys?.[code]?.pressed === true); }
function bindingDownCount(binding, keys) {
  return keyCodes(binding?.pc?.key).reduce((count, code) => count + (keys?.[code]?.downCount || 0), 0);
}
function modifiersDown(binding, keys) {
  return (Array.isArray(binding?.pc?.modifiers) ? binding.pc.modifiers : []).every(name => isKeyDown(name, keys));
}

// keys: { [vk]: { pressed, downCount, upCount } } from getKeyboardSnapshot().
function isBindingDown(binding, keys) {
  return isKeyDown(binding?.pc?.key, keys) && modifiersDown(binding, keys);
}

module.exports = { keyCode, isBindingDown, bindingDownCount, modifiersDown };
