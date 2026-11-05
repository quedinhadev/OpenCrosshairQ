param([Parameter(Mandatory=$true)][string]$DataFile)
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath $DataFile -Raw | ConvertFrom-Json
$stage = $null
$backedUp = $false
$installed = $false
function Write-Recovery([string]$message) {
  Add-Content -LiteralPath $data.log -Value ("{0:o} {1}" -f (Get-Date), $message)
}
try {
  $target = [IO.Path]::GetFullPath($data.target)
  if ($target -ne $data.target -or [IO.Path]::GetExtension($target) -ne '.exe') { throw 'Invalid target' }
  if ((Get-Item -LiteralPath $target).IsReadOnly) { throw 'Target is read-only' }
  $appInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$data.appPid)
  if (!$appInfo) { throw 'App process not found' }
  $launcherInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$appInfo.ParentProcessId)
  if (!$launcherInfo -or ![string]::Equals($launcherInfo.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Portable launcher identity could not be verified'
  }
  $appProcess = Get-Process -Id ([int]$data.appPid)
  $launcher = Get-Process -Id ([int]$launcherInfo.ProcessId)
  # Capture process handles now; PID reuse must not change which process is awaited.
  $null = $appProcess.Handle
  $null = $launcher.Handle
  $stage = Join-Path ([IO.Path]::GetDirectoryName($target)) ([IO.Path]::GetRandomFileName() + '.exe')
  Copy-Item -LiteralPath $data.source -Destination $stage
  if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $data.sha256) { throw 'Staged SHA256 mismatch' }
  if ((Get-Item -LiteralPath $stage).Length -ne $data.size) { throw 'Staged size mismatch' }
  Write-Recovery 'Staged and verified; waiting for application and portable launcher.'
  [IO.File]::WriteAllText($data.ready, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (!(Test-Path -LiteralPath $data.commit) -or !$appProcess.HasExited -or !$launcher.HasExited) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Process exit deadline exceeded' }
    Start-Sleep -Milliseconds 200
  }
  # ExecWait launcher may still have a file handle briefly after process exit.
  while ($true) {
    try {
      $handle = [IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
      $handle.Dispose()
      break
    } catch {
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Executable lock deadline exceeded' }
      Start-Sleep -Milliseconds 200
    }
  }
  if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $data.sha256) { throw 'Final SHA256 mismatch' }
  # File.Replace is atomic on Windows; failure leaves original intact. Backup is retained.
  [IO.File]::Replace($stage, $target, $data.backup)
  $stage = $null
  $backedUp = $true
  $installed = $true
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $target
  $psi.WorkingDirectory = [IO.Path]::GetDirectoryName($target)
  $psi.UseShellExecute = $false
  # Do not pass stale portable launcher variables into the new launcher.
  $psi.EnvironmentVariables.Remove('PORTABLE_EXECUTABLE_FILE')
  $psi.EnvironmentVariables.Remove('PORTABLE_EXECUTABLE_DIR')
  $psi.EnvironmentVariables.Remove('PORTABLE_EXECUTABLE_APP_FILENAME')
  $child = [Diagnostics.Process]::Start($psi)
  if (!$child) { throw 'Relaunch failed' }
  Write-Recovery 'Replacement launched; backup retained.'
  exit 0
} catch {
  $failure = $_.Exception.Message
  try {
    if ($installed -and $backedUp) {
      [IO.File]::Replace($data.backup, $data.target, $null)
      Write-Recovery 'Original restored after relaunch failure.'
    }
    Write-Recovery ("FAILED: " + $failure)
    [IO.File]::WriteAllText($data.failed, $failure)
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
  exit 1
} finally {
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage }
}
