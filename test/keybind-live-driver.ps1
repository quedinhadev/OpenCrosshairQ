param([Parameter(Mandatory=$true)][UInt64]$TargetWindow, [Parameter(Mandatory=$true)][UInt32]$TargetProcess, [switch]$AllowBackgroundKeys)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CQTestKeys {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  public static void Send(int vk, bool up) {
    var input = new INPUT { type = 1 };
    input.data.keyboard.vk = (ushort)vk;
    input.data.keyboard.scan = (ushort)MapVirtualKey((uint)vk, 0);
    input.data.keyboard.flags = (up ? 2u : 0u) | (vk == 0xa3 || vk == 0xa5 ? 1u : 0u);
    if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("SendInput rejected: " + Marshal.GetLastWin32Error());
  }
  public static void Mouse(int button, bool up) {
    uint down = button == 0 ? 0x02u : button == 1 ? 0x08u : 0x20u;
    var input = new INPUT { type = 0 };
    input.data.mouse.flags = up ? down << 1 : down;
    if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("SendInput mouse rejected: " + Marshal.GetLastWin32Error());
  }
  public static double MouseTap(int button) {
    var down = new INPUT { type = 0 };
    down.data.mouse.flags = button == 0 ? 0x02u : button == 1 ? 0x08u : 0x20u;
    var up = down;
    up.data.mouse.flags = down.data.mouse.flags << 1;
    var clock = System.Diagnostics.Stopwatch.StartNew();
    if (SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2)
      throw new InvalidOperationException("SendInput mouse batch rejected: " + Marshal.GetLastWin32Error());
    return clock.Elapsed.TotalMilliseconds;
  }
  public static double Tap(int[] keys) {
    var inputs = new INPUT[keys.Length * 2];
    for (int i = 0; i < keys.Length; i++) {
      inputs[i].type = 1;
      inputs[i].data.keyboard.vk = (ushort)keys[i];
      inputs[i].data.keyboard.scan = (ushort)MapVirtualKey((uint)keys[i], 0);
      inputs[i].data.keyboard.flags = keys[i] == 0xa3 || keys[i] == 0xa5 ? 1u : 0u;
      inputs[inputs.Length - i - 1] = inputs[i];
      inputs[inputs.Length - i - 1].data.keyboard.flags |= 2u;
    }
    var clock = System.Diagnostics.Stopwatch.StartNew();
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new InvalidOperationException("SendInput batch rejected: " + Marshal.GetLastWin32Error());
    return clock.Elapsed.TotalMilliseconds;
  }
}
'@
# Keyboard whitelist excludes letters, navigation and Windows key. Mouse input
# is opt-in per operation, restricted to a verified safe point in the test UI.
$allowed = @(0x84, 0x85, 0x86, 0x87, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5)
$held = [System.Collections.Generic.List[int]]::new()
$heldMouse = [System.Collections.Generic.List[int]]::new()
$cursorBeforeMouse = [CQTestKeys+POINT]::new()
$restoreCursor = $false
function Release-Owned {
  for ($i = $heldMouse.Count - 1; $i -ge 0; $i--) { [CQTestKeys]::Mouse($heldMouse[$i], $true); $heldMouse.RemoveAt($i) }
  if ($restoreCursor) { [void][CQTestKeys]::SetCursorPos($cursorBeforeMouse.x, $cursorBeforeMouse.y); $script:restoreCursor = $false }
  for ($i = $held.Count - 1; $i -ge 0; $i--) { [CQTestKeys]::Send($held[$i], $true); $held.RemoveAt($i) }
}
@{ ready = $true; pid = $PID; input = 'synthetic SendInput' } | ConvertTo-Json -Compress
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $command = $null
    try {
      $command = $line | ConvertFrom-Json
      $elapsed = $null
      $mouseOp = $command.op -in @('mouse-down', 'mouse-up', 'mouse-tap', 'mouse-tap-fast')
      if ($command.op -notin @('down', 'up', 'repeat', 'tap', 'tap-fast', 'release', 'mouse-down', 'mouse-up', 'mouse-tap', 'mouse-tap-fast')) { throw 'Unknown operation' }
      if ($mouseOp) {
        if (@($command.keys).Count -ne 1 -or [int]$command.keys[0] -notin @(0, 1, 2)) { throw 'Mouse operation requires one whitelisted button' }
      } else {
        foreach ($key in $command.keys) { if ([int]$key -notin $allowed) { throw 'Key outside test whitelist' } }
      }
      if ($command.op -eq 'release') { Release-Owned }
      else {
        $foreground = [CQTestKeys]::GetForegroundWindow()
        [UInt32]$foregroundProcess = 0
        [void][CQTestKeys]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
        if ((-not $AllowBackgroundKeys -or $mouseOp) -and $foregroundProcess -ne $TargetProcess) {
          $target = [IntPtr]::new([Int64]$TargetWindow)
          [void][CQTestKeys]::ShowWindowAsync($target, 9)
          [void][CQTestKeys]::BringWindowToTop($target)
          [void][CQTestKeys]::SetForegroundWindow($target)
          Start-Sleep -Milliseconds 150
          $foreground = [CQTestKeys]::GetForegroundWindow()
          [void][CQTestKeys]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
        }
        if ((-not $AllowBackgroundKeys -or $mouseOp) -and $foregroundProcess -ne $TargetProcess) { throw "SKIP: foreground PID $foregroundProcess (handle $foreground) differs from test PID $TargetProcess (UI handle $TargetWindow); no input sent" }
        if ($mouseOp) {
          $button = [int]$command.keys[0]
          $vk = @(1, 2, 4)[$button]
          if ([CQTestKeys]::GetAsyncKeyState($vk) -lt 0 -and -not $heldMouse.Contains($button)) { throw "SKIP: mouse button $button already held; no input sent" }
          if ($command.op -ne 'mouse-up') {
            if ($null -eq $command.point) { throw 'Mouse operation requires a safe test point' }
            $rect = [CQTestKeys+RECT]::new()
            if (-not [CQTestKeys]::GetWindowRect([IntPtr]::new([Int64]$TargetWindow), [ref]$rect)) { throw 'Cannot read test window bounds' }
            $x = [int]$command.point.x; $y = [int]$command.point.y
            if ($x -le $rect.left -or $x -ge $rect.right -or $y -le $rect.top -or $y -ge $rect.bottom) { throw 'Mouse point outside test window' }
            if (-not $restoreCursor) {
              if (-not [CQTestKeys]::GetCursorPos([ref]$cursorBeforeMouse)) { throw 'Cannot preserve cursor position' }
              $script:restoreCursor = $true
            }
            if (-not [CQTestKeys]::SetCursorPos($x, $y)) { throw 'Cannot position cursor inside test window' }
            Start-Sleep -Milliseconds 40
          }
          if ($command.op -eq 'mouse-down') {
            if (-not $heldMouse.Contains($button)) { [CQTestKeys]::Mouse($button, $false); $heldMouse.Add($button) }
          } elseif ($command.op -eq 'mouse-up') {
            if ($heldMouse.Contains($button)) { [CQTestKeys]::Mouse($button, $true); [void]$heldMouse.Remove($button) }
          } else {
            if ($command.op -eq 'mouse-tap') { [CQTestKeys]::Mouse($button, $false); Start-Sleep -Milliseconds 140; [CQTestKeys]::Mouse($button, $true) }
            else { $elapsed = [CQTestKeys]::MouseTap($button) }
          }
          if ($heldMouse.Count -eq 0 -and $restoreCursor) { [void][CQTestKeys]::SetCursorPos($cursorBeforeMouse.x, $cursorBeforeMouse.y); $script:restoreCursor = $false }
        }
        if ($command.op -eq 'repeat') {
          if (@($command.keys).Count -eq 0) { throw 'repeat requires test-held keys' }
          foreach ($key in $command.keys) { if (-not $held.Contains([int]$key)) { throw 'repeat requires test-held keys' } }
          foreach ($key in $command.keys) { [CQTestKeys]::Send($key, $false) }
        }
        if ($command.op -in @('down', 'tap', 'tap-fast')) {
          # Do not borrow/release keys already held by person or another process.
          foreach ($key in $allowed) {
            if ([CQTestKeys]::GetAsyncKeyState($key) -lt 0 -and -not $held.Contains($key)) { throw "SKIP: key $key already held; no input sent" }
          }
          if ($command.op -eq 'tap-fast') {
            if (@($command.keys).Count -eq 0 -or $held.Count -ne 0) { throw 'tap-fast requires keys and no test-held keys' }
            foreach ($key in $command.keys) { $held.Add([int]$key) }
            $elapsed = [CQTestKeys]::Tap([int[]]$command.keys)
            $held.Clear()
          } else {
            foreach ($key in $command.keys) {
              if (-not $held.Contains([int]$key)) { [CQTestKeys]::Send($key, $false); $held.Add([int]$key) }
            }
          }
        }
        if ($command.op -eq 'tap') { Start-Sleep -Milliseconds 140 }
        if ($command.op -in @('up', 'tap')) {
          $keys = @($command.keys)
          for ($i = $keys.Count - 1; $i -ge 0; $i--) {
            $key = [int]$keys[$i]
            if ($held.Contains($key)) { [CQTestKeys]::Send($key, $true); [void]$held.Remove($key) }
          }
        }
      }
      @{ id = $command.id; ok = $true; held = @($held); heldMouse = @($heldMouse); elapsedMs = $elapsed } | ConvertTo-Json -Compress
    } catch {
      $message = $_.Exception.Message
      Release-Owned
      @{ id = $command.id; ok = $false; skip = $message.StartsWith('SKIP:'); error = $message } | ConvertTo-Json -Compress
    }
  }
} finally { Release-Owned }
