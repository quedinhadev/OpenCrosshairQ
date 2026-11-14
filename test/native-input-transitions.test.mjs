// Source contract only: real Win32 hook behavior is covered by keybind-live
// after rebuilding the addon. This check never compiles or loads native code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../native/crosshairq.c', import.meta.url), 'utf8');
const keyboard = source.slice(source.indexOf('static LRESULT CALLBACK keyboard_proc('), source.indexOf('static DWORD WINAPI keyboard_thread('));
assert.match(keyboard, /if\s*\(!InterlockedExchange\(&key->pressed,\s*1\)\)\s*keyboard_count\(&key->down_count\);/, 'keyboard DOWN increments only when previous pressed was false');
assert.match(keyboard, /return CallNextHookEx\(NULL, code, wparam, lparam\);/, 'keyboard remains passive');
const mouse = source.slice(source.indexOf('static LRESULT CALLBACK mouse_window_proc('), source.indexOf('static DWORD WINAPI mouse_thread('));
assert.match(mouse, /if\s*\(\(raw\.data\.mouse\.usButtonFlags & down\[i\]\) && !button->pressed\)\s*\{\s*button->pressed = TRUE;\s*if \(button->down_count < 9007199254740991ULL\) \+\+button->down_count;/, 'mouse duplicate DOWN cannot manufacture a fresh press');
assert.match(mouse, /if \(raw\.data\.mouse\.usButtonFlags & up\[i\]\)\s*\{\s*button->pressed = FALSE;/, 'mouse UP clears held state for the next physical press');
console.log('PASS: native source guards repeated DOWN; counters and passive hook preserved (runtime awaits rebuild)');
