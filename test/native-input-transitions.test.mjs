// Source contract only: real Win32 hook behavior is covered by keybind-live
// after rebuilding the addon. This check never compiles or loads native code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../native/crosshairq.c', import.meta.url), 'utf8');
const keyboard = source.slice(source.indexOf('static LRESULT CALLBACK keyboard_proc('), source.indexOf('static DWORD WINAPI keyboard_thread('));
assert.match(keyboard, /if\s*\(!InterlockedExchange\(&key->pressed,\s*1\)\)\s*keyboard_count\(&key->down_count\);/, 'keyboard DOWN increments only when previous pressed was false');
assert.match(keyboard, /return CallNextHookEx\(NULL, code, wparam, lparam\);/, 'keyboard remains passive');
const mouseHook = source.slice(source.indexOf('static void mouse_apply_down('), source.indexOf('static DWORD mouse_registration('));
assert.match(mouseHook, /if\s*\(!button->pressed\)\s*\{\s*button->pressed = TRUE;\s*if \(button->down_count < 9007199254740991ULL\) \+\+button->down_count;/, 'mouse duplicate DOWN cannot manufacture a fresh press');
assert.match(mouseHook, /static void mouse_apply_up[\s\S]*?button->pressed = FALSE;\s*if \(button->up_count < 9007199254740991ULL\) \+\+button->up_count;/, 'mouse UP clears held state and preserves short-click counters');
assert.match(mouseHook, /else if \(wparam == WM_RBUTTONDOWN\) mouse_apply_down\(input, 1\);/, 'right DOWN uses the passive low-level hook');
assert.match(mouseHook, /return CallNextHookEx\(NULL, code, wparam, lparam\);/, 'mouse remains passive');
const mouseWindow = source.slice(source.indexOf('static LRESULT CALLBACK mouse_window_proc('), source.indexOf('static DWORD WINAPI mouse_thread('));
assert.doesNotMatch(mouseWindow, /down_count|up_count|button->pressed/, 'Raw Input cannot double-count low-level hook transitions');
assert.match(source, /if \(!input->hook\) \{ error = GetLastError\(\); goto finished; \}/, 'hook failure cannot report a healthy mouse monitor');
console.log('PASS: native source guards repeated DOWN, single-source counters and passive hooks (runtime awaits rebuild)');
