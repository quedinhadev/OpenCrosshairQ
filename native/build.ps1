param([string]$NodeInclude)
$ErrorActionPreference = 'Stop'
$electron = Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'
if (!(Test-Path $electron)) { throw "Electron executable missing: $electron" }
if (!$NodeInclude) {
  # Only known local caches; never download headers or scan the filesystem.
  foreach ($cache in @("$env:LOCALAPPDATA\node-gyp\Cache", "$env:USERPROFILE\.node-gyp", "$env:USERPROFILE\.electron-gyp")) {
    if (Test-Path $cache) {
      $header = Get-ChildItem "$cache\*\include\node\node_api.h" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($header) { $NodeInclude = $header.DirectoryName; break }
    }
  }
}
if (!$NodeInclude -or !(Test-Path (Join-Path $NodeInclude 'node_api.h'))) {
  throw 'Local Node-API headers missing. Supply -NodeInclude with an existing include\node directory.'
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (!(Test-Path $vswhere)) { throw "vswhere missing: $vswhere" }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Existing Visual Studio C++ BuildTools not found.' }
$devcmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$environment = & cmd.exe /d /s /c "`"$devcmd`" -arch=x64 -host_arch=x64 >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'VsDevCmd failed.' }
foreach ($line in $environment) {
  if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$out = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $out | Out-Null
# Import only Node-API exports from the actual Electron runtime, not node.exe.
$exports = & dumpbin.exe /nologo /exports $electron
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Electron exports.' }
$symbols = @($exports | ForEach-Object {
  if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+((?:napi_|node_api_)\w+)\s*$') { $matches[1] }
})
if (!$symbols.Count) { throw 'Electron has no Node-API exports.' }
$definition = Join-Path $out 'electron.def'
@('LIBRARY electron.exe', 'EXPORTS') + $symbols | Set-Content -Encoding ascii $definition
$import = Join-Path $out 'electron.lib'
& lib.exe /nologo /machine:x64 "/def:$definition" "/out:$import"
if ($LASTEXITCODE -ne 0) { throw 'Electron import library generation failed.' }
$addon = Join-Path $out 'crosshairq.node'
& cl.exe /nologo /TC /std:c11 /W4 /WX /MD /O2 /LD /DBUILDING_NODE_EXTENSION "/I$NodeInclude" (Join-Path $PSScriptRoot 'crosshairq.c') "/Fo$out\crosshairq.obj" /link "/OUT:$addon" "/IMPLIB:$out\crosshairq.lib" /INCREMENTAL:NO $import user32.lib kernel32.lib
if ($LASTEXITCODE -ne 0) { throw 'Native addon compilation failed.' }
Write-Output "Built $addon (x64, Node-API 8; headers: $NodeInclude)"
