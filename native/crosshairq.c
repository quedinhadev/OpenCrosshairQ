// Cleanroom Win32 snapshots + passive Raw Input. No hooks, injection, or game-memory access.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#define NAPI_VERSION 8
#include <windows.h>
#include <Xinput.h>
#include <node_api.h>
#include <uchar.h>
#include <wchar.h>
#include <stddef.h>
#include <stdint.h>

#define NAPI(call) do { if ((call) != napi_ok) { \
  napi_throw_error(env, NULL, "Node-API operation failed"); return NULL; \
} } while (0)
#define NUMBER(object, name, number) do { \
  NAPI(napi_create_int64(env, (int64_t)(number), &value)); \
  NAPI(napi_set_named_property(env, object, name, value)); \
} while (0)
#define BOOLEAN(object, name, boolean) do { \
  NAPI(napi_get_boolean(env, boolean, &value)); \
  NAPI(napi_set_named_property(env, object, name, value)); \
} while (0)

static napi_value get_foreground_process(napi_env env, napi_callback_info info) {
  HWND window = GetForegroundWindow();
  DWORD pid = 0, error = ERROR_SUCCESS;
  HANDLE process;
  WCHAR path[32768];
  DWORD length = ARRAYSIZE(path);
  napi_value result, value;
  (void)info;
  if (!window || !GetWindowThreadProcessId(window, &pid) || !pid) {
    NAPI(napi_get_null(env, &result));
    return result;
  }
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) error = GetLastError();
  else {
    if (!QueryFullProcessImageNameW(process, 0, path, &length)) error = GetLastError();
    CloseHandle(process);
  }
  NAPI(napi_create_object(env, &result));
  NUMBER(result, "pid", pid);
  NUMBER(result, "errorCode", error);
  NAPI(napi_get_null(env, &value));
  if (error == ERROR_SUCCESS)
    NAPI(napi_create_string_utf16(env, (const char16_t *)path, length, &value));
  NAPI(napi_set_named_property(env, result, "executablePath", value));
  NAPI(napi_get_null(env, &value));
  if (error == ERROR_SUCCESS) {
    const WCHAR *name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    NAPI(napi_create_string_utf16(env, (const char16_t *)name, NAPI_AUTO_LENGTH, &value));
  }
  NAPI(napi_set_named_property(env, result, "executableName", value));
  return result;
}

typedef DWORD (WINAPI *get_state_fn)(DWORD, XINPUT_STATE *);

static HMODULE s_xinput_lib = NULL;
static get_state_fn s_xinput_get_state = NULL;
static const WCHAR *s_xinput_name = NULL;
static DWORD s_xinput_load_error = ERROR_MOD_NOT_FOUND;

static void xinput_cleanup(void *arg) {
  (void)arg;
  if (s_xinput_lib) {
    FreeLibrary(s_xinput_lib);
    s_xinput_lib = NULL;
    s_xinput_get_state = NULL;
    s_xinput_name = NULL;
    s_xinput_load_error = ERROR_MOD_NOT_FOUND;
  }
}

static void ensure_xinput_loaded(void) {
  if (s_xinput_get_state) return;
  static const WCHAR *names[] = { L"xinput1_4.dll", L"xinput9_1_0.dll", L"xinput1_3.dll" };
  WCHAR path[MAX_PATH];
  UINT directory_length = GetSystemDirectoryW(path, ARRAYSIZE(path));
  if (directory_length && directory_length < MAX_PATH - 32) {
    for (size_t i = 0; i < ARRAYSIZE(names); ++i) {
      path[directory_length] = L'\\';
      wcscpy_s(path + directory_length + 1, MAX_PATH - directory_length - 1, names[i]);
      HMODULE lib = LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
      if (!lib) { s_xinput_load_error = GetLastError(); continue; }
      get_state_fn fn = (get_state_fn)(void *)GetProcAddress(lib, "XInputGetState");
      if (fn) {
        s_xinput_lib = lib;
        s_xinput_get_state = fn;
        s_xinput_name = names[i];
        s_xinput_load_error = ERROR_SUCCESS;
        break;
      }
      s_xinput_load_error = ERROR_PROC_NOT_FOUND;
      FreeLibrary(lib);
    }
  } else {
    s_xinput_load_error = directory_length ? ERROR_INSUFFICIENT_BUFFER : GetLastError();
  }
}

static napi_value get_xinput_snapshot(napi_env env, napi_callback_info info) {
  napi_value result, controllers, controller, value;
  (void)info;

  ensure_xinput_loaded();

  XINPUT_STATE states[XUSER_MAX_COUNT] = {0};
  DWORD errors[XUSER_MAX_COUNT];
  for (DWORD i = 0; i < XUSER_MAX_COUNT; ++i) {
    errors[i] = s_xinput_get_state ? s_xinput_get_state(i, &states[i]) : s_xinput_load_error;
    if (errors[i] != ERROR_SUCCESS) ZeroMemory(&states[i], sizeof(states[i]));
  }

  NAPI(napi_create_object(env, &result));
  BOOLEAN(result, "available", s_xinput_get_state != NULL);
  NUMBER(result, "errorCode", s_xinput_get_state ? ERROR_SUCCESS : s_xinput_load_error);
  NAPI(napi_get_null(env, &value));
  if (s_xinput_name)
    NAPI(napi_create_string_utf16(env, (const char16_t *)s_xinput_name, NAPI_AUTO_LENGTH, &value));
  NAPI(napi_set_named_property(env, result, "dll", value));
  NAPI(napi_create_array_with_length(env, XUSER_MAX_COUNT, &controllers));
  for (DWORD i = 0; i < XUSER_MAX_COUNT; ++i) {
    const XINPUT_GAMEPAD *pad = &states[i].Gamepad;
    NAPI(napi_create_object(env, &controller));
    NUMBER(controller, "index", i);
    BOOLEAN(controller, "connected", errors[i] == ERROR_SUCCESS);
    NUMBER(controller, "errorCode", errors[i]);
    NUMBER(controller, "packetNumber", states[i].dwPacketNumber);
    NUMBER(controller, "buttons", pad->wButtons);
    NUMBER(controller, "leftTrigger", pad->bLeftTrigger);
    NUMBER(controller, "rightTrigger", pad->bRightTrigger);
    NUMBER(controller, "leftThumbX", pad->sThumbLX);
    NUMBER(controller, "leftThumbY", pad->sThumbLY);
    NUMBER(controller, "rightThumbX", pad->sThumbRX);
    NUMBER(controller, "rightThumbY", pad->sThumbRY);
    NAPI(napi_set_element(env, controllers, i, controller));
  }
  NAPI(napi_set_named_property(env, result, "controllers", controllers));
  return result;
}

typedef struct {
  BOOL pressed;
  uint64_t down_count, up_count;
} mouse_button;

typedef struct {
  BOOL running;
  DWORD error;
  mouse_button buttons[3];
} mouse_snapshot;

typedef struct {
  SRWLOCK lock;
  mouse_snapshot snapshot;
  HANDLE thread, ready, stop;
} mouse_input;

// ponytail: one merged mouse stream; held-before-start/hot-unplug state is unknown.
// Add per-device tracking + removal notifications only if multi-mouse semantics are needed.
// No provenance claim: Raw Input is not proof of physical hardware input.
// Counters saturate at JS MAX_SAFE_INTEGER; successful restart resets all state.
// Lifecycle is process-wide: Win32 permits only one mouse registration per process.
// The host must reserve this usage: unrelated registration calls cannot be locked here.
static SRWLOCK mouse_lifecycle = SRWLOCK_INIT;

static DWORD mouse_registration(HWND *target) {
  UINT count = 0;
  RAWINPUTDEVICE *devices;
  DWORD error = ERROR_SUCCESS;
  *target = NULL;
  if (GetRegisteredRawInputDevices(NULL, &count, sizeof(RAWINPUTDEVICE)) == (UINT)-1)
    return GetLastError();
  if (!count) return ERROR_SUCCESS;
  devices = HeapAlloc(GetProcessHeap(), 0, (SIZE_T)count * sizeof(*devices));
  if (!devices) return ERROR_NOT_ENOUGH_MEMORY;
  count = GetRegisteredRawInputDevices(devices, &count, sizeof(*devices));
  if (count == (UINT)-1) error = GetLastError();
  else for (UINT i = 0; i < count; ++i) {
    if (devices[i].usUsagePage == 1 && devices[i].usUsage == 2) {
      // A NULL target is also an existing registration (foreground delivery).
      *target = devices[i].hwndTarget;
      error = ERROR_BUSY;
      break;
    }
  }
  HeapFree(GetProcessHeap(), 0, devices);
  return error;
}

static LRESULT CALLBACK mouse_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  mouse_input *input = (mouse_input *)GetWindowLongPtrW(window, GWLP_USERDATA);
  if (message == WM_NCCREATE) {
    input = (mouse_input *)((CREATESTRUCTW *)lparam)->lpCreateParams;
    SetWindowLongPtrW(window, GWLP_USERDATA, (LONG_PTR)input);
  }
  if (message == WM_INPUT && input) {
    RAWINPUT raw;
    UINT size = sizeof(raw);
    UINT copied = GetRawInputData((HRAWINPUT)lparam, RID_INPUT, &raw, &size, sizeof(RAWINPUTHEADER));
    DWORD error = copied == (UINT)-1 ? GetLastError() : ERROR_SUCCESS;
    AcquireSRWLockExclusive(&input->lock);
    if (error) input->snapshot.error = error;
    else if (copied >= offsetof(RAWINPUT, data) + sizeof(RAWMOUSE) &&
             raw.header.dwType == RIM_TYPEMOUSE) {
      static const USHORT down[] = { RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_DOWN };
      static const USHORT up[] = { RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_RIGHT_BUTTON_UP, RI_MOUSE_MIDDLE_BUTTON_UP };
      for (size_t i = 0; i < ARRAYSIZE(down); ++i) {
        mouse_button *button = &input->snapshot.buttons[i];
        // Count reported transitions, including an UP whose DOWN predates registration.
        if (raw.data.mouse.usButtonFlags & down[i]) {
          button->pressed = TRUE;
          if (button->down_count < 9007199254740991ULL) ++button->down_count;
        }
        if (raw.data.mouse.usButtonFlags & up[i]) {
          button->pressed = FALSE;
          if (button->up_count < 9007199254740991ULL) ++button->up_count;
        }
      }
    }
    ReleaseSRWLockExclusive(&input->lock);
    // Required foreground WM_INPUT cleanup; never suppress legacy delivery.
    DefWindowProcW(window, message, wparam, lparam);
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

static DWORD WINAPI mouse_thread(void *data) {
  mouse_input *input = data;
  HINSTANCE instance = GetModuleHandleW(NULL);
  WCHAR class_name[80];
  WNDCLASSW window_class = {0};
  HWND window = NULL;
  ATOM atom = 0;
  DWORD error = ERROR_SUCCESS;
  BOOL registered = FALSE;
  RAWINPUTDEVICE device = { 1, 2, RIDEV_INPUTSINK, NULL };
  swprintf_s(class_name, ARRAYSIZE(class_name), L"CrosshairQ.Mouse.%p", (void *)input);
  window_class.lpfnWndProc = mouse_window_proc;
  window_class.hInstance = instance;
  window_class.lpszClassName = class_name;
  atom = RegisterClassW(&window_class);
  if (!atom) { error = GetLastError(); goto finished; }
  window = CreateWindowExW(0, class_name, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, instance, input);
  if (!window) { error = GetLastError(); goto finished; }
  device.hwndTarget = window;
  if (!RegisterRawInputDevices(&device, 1, sizeof(device))) {
    error = GetLastError(); goto finished;
  }
  registered = TRUE;
  AcquireSRWLockExclusive(&input->lock);
  input->snapshot.running = TRUE;
  ReleaseSRWLockExclusive(&input->lock);
  SetEvent(input->ready);
  for (;;) {
    DWORD wait = MsgWaitForMultipleObjectsEx(1, &input->stop, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    MSG message;
    if (wait == WAIT_OBJECT_0) break;
    if (wait == WAIT_FAILED) { error = GetLastError(); break; }
    while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) goto finished;
      TranslateMessage(&message);
      DispatchMessageW(&message);
      if (WaitForSingleObject(input->stop, 0) == WAIT_OBJECT_0) goto finished;
    }
  }
finished:
  if (registered) {
    HWND target;
    DWORD registration = mouse_registration(&target);
    // Do not remove a registration replaced by another consumer in this process.
    if (registration == ERROR_BUSY && target == window) {
      device.dwFlags = RIDEV_REMOVE;
      device.hwndTarget = NULL;
      if (!RegisterRawInputDevices(&device, 1, sizeof(device)) && !error) error = GetLastError();
    } else if (registration != ERROR_SUCCESS && registration != ERROR_BUSY && !error) error = registration;
  }
  if (window) DestroyWindow(window);
  if (atom) UnregisterClassW(class_name, instance);
  AcquireSRWLockExclusive(&input->lock);
  input->snapshot.running = FALSE;
  if (error) input->snapshot.error = error;
  for (size_t i = 0; i < ARRAYSIZE(input->snapshot.buttons); ++i) input->snapshot.buttons[i].pressed = FALSE;
  ReleaseSRWLockExclusive(&input->lock);
  SetEvent(input->ready);
  return error;
}

// Caller holds mouse_lifecycle; worker never takes it, so joining cannot deadlock.
static DWORD mouse_join(mouse_input *input) {
  DWORD error = ERROR_SUCCESS;
  if (input->thread) {
    SetEvent(input->stop);
    WaitForSingleObject(input->thread, INFINITE);
    if (!GetExitCodeThread(input->thread, &error)) error = GetLastError();
    CloseHandle(input->thread);
    input->thread = NULL;
  }
  if (input->ready) { CloseHandle(input->ready); input->ready = NULL; }
  if (input->stop) { CloseHandle(input->stop); input->stop = NULL; }
  return error;
}

static void mouse_cleanup(void *data) {
  mouse_input *input = data;
  AcquireSRWLockExclusive(&mouse_lifecycle);
  mouse_join(input);
  ReleaseSRWLockExclusive(&mouse_lifecycle);
  HeapFree(GetProcessHeap(), 0, input);
}

static napi_value mouse_error(napi_env env, const char *operation, DWORD error) {
  napi_value code, message, result, value;
  NAPI(napi_create_string_utf8(env, "ERR_MOUSE_INPUT", NAPI_AUTO_LENGTH, &code));
  NAPI(napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &message));
  NAPI(napi_create_error(env, code, message, &result));
  NUMBER(result, "win32Code", error);
  NAPI(napi_throw(env, result));
  return NULL;
}

static napi_value start_mouse_input(napi_env env, napi_callback_info info) {
  mouse_input *input;
  HWND target;
  DWORD error;
  napi_value result;
  NAPI(napi_get_cb_info(env, info, NULL, NULL, NULL, (void **)&input));
  AcquireSRWLockExclusive(&mouse_lifecycle);
  if (input->thread && WaitForSingleObject(input->thread, 0) == WAIT_TIMEOUT) {
    ReleaseSRWLockExclusive(&mouse_lifecycle);
    NAPI(napi_get_undefined(env, &result));
    return result;
  }
  mouse_join(input);
  error = mouse_registration(&target);
  if (!error) {
    AcquireSRWLockExclusive(&input->lock);
    ZeroMemory(&input->snapshot, sizeof(input->snapshot));
    ReleaseSRWLockExclusive(&input->lock);
    input->ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!input->ready) error = GetLastError();
    if (!error) {
      input->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
      if (!input->stop) error = GetLastError();
    }
    if (!error) {
      input->thread = CreateThread(NULL, 0, mouse_thread, input, 0, NULL);
      if (!input->thread) error = GetLastError();
    }
    if (!error) {
      if (WaitForSingleObject(input->ready, INFINITE) == WAIT_FAILED) error = GetLastError();
      else {
        AcquireSRWLockShared(&input->lock);
        error = input->snapshot.error;
        if (!input->snapshot.running && !error) error = ERROR_OPERATION_ABORTED;
        ReleaseSRWLockShared(&input->lock);
      }
    }
  }
  if (error) {
    mouse_join(input);
    AcquireSRWLockExclusive(&input->lock);
    input->snapshot.error = error;
    ReleaseSRWLockExclusive(&input->lock);
  }
  ReleaseSRWLockExclusive(&mouse_lifecycle);
  if (error) return mouse_error(env, "Cannot start Raw Input mouse", error);
  NAPI(napi_get_undefined(env, &result));
  return result;
}

static napi_value stop_mouse_input(napi_env env, napi_callback_info info) {
  mouse_input *input;
  DWORD error;
  napi_value result;
  NAPI(napi_get_cb_info(env, info, NULL, NULL, NULL, (void **)&input));
  AcquireSRWLockExclusive(&mouse_lifecycle);
  error = mouse_join(input);
  ReleaseSRWLockExclusive(&mouse_lifecycle);
  if (error) return mouse_error(env, "Raw Input mouse stopped with error", error);
  NAPI(napi_get_undefined(env, &result));
  return result;
}

static napi_value get_mouse_snapshot(napi_env env, napi_callback_info info) {
  static const char *names[] = { "left", "right", "middle" };
  mouse_input *input;
  mouse_snapshot snapshot;
  napi_value result, button, value;
  NAPI(napi_get_cb_info(env, info, NULL, NULL, NULL, (void **)&input));
  AcquireSRWLockShared(&input->lock);
  snapshot = input->snapshot;
  ReleaseSRWLockShared(&input->lock);
  NAPI(napi_create_object(env, &result));
  BOOLEAN(result, "running", snapshot.running);
  NUMBER(result, "errorCode", snapshot.error);
  for (size_t i = 0; i < ARRAYSIZE(names); ++i) {
    NAPI(napi_create_object(env, &button));
    BOOLEAN(button, "pressed", snapshot.buttons[i].pressed);
    NUMBER(button, "downCount", snapshot.buttons[i].down_count);
    NUMBER(button, "upCount", snapshot.buttons[i].up_count);
    NAPI(napi_set_named_property(env, result, names[i], button));
  }
  return result;
}

NAPI_MODULE_INIT() {
  mouse_input *input = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*input));
  if (!input) { napi_throw_error(env, NULL, "Cannot allocate mouse state"); return NULL; }
  InitializeSRWLock(&input->lock);
  if (napi_add_env_cleanup_hook(env, mouse_cleanup, input) != napi_ok) {
    HeapFree(GetProcessHeap(), 0, input);
    napi_throw_error(env, NULL, "Cannot install mouse cleanup");
    return NULL;
  }
  if (napi_add_env_cleanup_hook(env, xinput_cleanup, NULL) != napi_ok) {
    HeapFree(GetProcessHeap(), 0, input);
    napi_throw_error(env, NULL, "Cannot install xinput cleanup");
    return NULL;
  }
  napi_property_descriptor methods[] = {
    { "getForegroundProcess", NULL, get_foreground_process, NULL, NULL, NULL, napi_default, NULL },
    { "getXInputSnapshot", NULL, get_xinput_snapshot, NULL, NULL, NULL, napi_default, NULL },
    { "startMouseInput", NULL, start_mouse_input, NULL, NULL, NULL, napi_default, input },
    { "getMouseSnapshot", NULL, get_mouse_snapshot, NULL, NULL, NULL, napi_default, input },
    { "stopMouseInput", NULL, stop_mouse_input, NULL, NULL, NULL, napi_default, input }
  };
  NAPI(napi_define_properties(env, exports, ARRAYSIZE(methods), methods));
  return exports;
}
