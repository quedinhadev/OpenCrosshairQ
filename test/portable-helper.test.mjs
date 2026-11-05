import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function run(file, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => reject(new Error('Fixture deadline exceeded: ' + output)), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output + ' exit ' + code)); });
  });
}
test('real Windows helper stages, waits launcher, replaces, relaunches and retains backup; hash failure preserves original', { skip: process.platform !== 'win32' || process.env.CI === 'true', timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "cq helper ' spaced "));
  // Fixtures only. No application profile, real install, registry or external process termination.
  t.after(() => rm(dir, { recursive: true, force: true }));
  const compiler = path.join(dir, 'compile.ps1');
  await writeFile(compiler, `param($Dir)
$ErrorActionPreference='Stop'
$launcher=@'
using System; using System.Diagnostics; using System.IO;
public class Launcher { public static void Main(string[] args) {
if(args.Length == 0) return;
var ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
if(!File.Exists(ps)) ps = Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
var p = new ProcessStartInfo(); p.FileName = ps;
p.Arguments = "-NoProfile -NonInteractive -File \\\"" + args[0] + "\\\" -Dir \\\"" + args[1] + "\\\"";
p.UseShellExecute=false;
var child=Process.Start(p); child.WaitForExit(); Environment.ExitCode=child.ExitCode;
} }
'@
Add-Type -TypeDefinition $launcher -OutputAssembly (Join-Path $Dir 'Portable.exe') -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class Payload { public static void Main() { } }' -OutputAssembly (Join-Path $Dir 'payload.exe') -OutputType ConsoleApplication
`);
  // C# command quoting uses literal double quotes, never shell interpolation.
  let source = await readFile(compiler, 'utf8');
  source = source.replaceAll('\\\\\\"', '\\"');
  await writeFile(compiler, source);
  await run(ps, ['-NoProfile', '-NonInteractive', '-File', compiler, '-Dir', dir]);
  await copyFile(new URL('../src/main/portable-update-helper.ps1', import.meta.url), path.join(dir, 'helper.ps1'));
  const fixture = path.join(dir, 'app.ps1');
  await writeFile(fixture, `param($Dir)
$ErrorActionPreference='Stop'
$data=Get-Content -LiteralPath (Join-Path $Dir 'data.json') -Raw | ConvertFrom-Json
$data.appPid=$PID
$data | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Dir 'data.json') -Encoding UTF8
$helper=Join-Path $Dir 'helper.ps1'
$json=Join-Path $Dir 'data.json'
$psi=New-Object Diagnostics.ProcessStartInfo
$psi.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$psi.Arguments='-NoProfile -NonInteractive -File "'+$helper+'" -DataFile "'+$json+'"'
$psi.UseShellExecute=$false
$p=[Diagnostics.Process]::Start($psi)
$deadline=[DateTime]::UtcNow.AddSeconds(20)
while (!(Test-Path -LiteralPath $data.ready) -and !(Test-Path -LiteralPath $data.failed)) {
 if ([DateTime]::UtcNow -gt $deadline) { throw 'Fixture ready timeout' }
 Start-Sleep -Milliseconds 100
}
if (Test-Path -LiteralPath $data.ready) { [IO.File]::WriteAllText($data.commit,'commit') }
`);
  const target = path.join(dir, 'Portable.exe'), payload = path.join(dir, 'payload.exe');
  const original = await readFile(target), bytes = await readFile(payload);
  const data = { target, source: payload, appPid: 0, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    ready: path.join(dir, 'ready'), commit: path.join(dir, 'commit'), failed: path.join(dir, 'failed'), log: path.join(dir, 'recovery.log'), backup: path.join(dir, 'backup.exe') };
  async function waitResult() {
    for (let i = 0; i < 150; i++) {
      const files = await readdir(dir);
      if (files.includes('failed')) throw new Error(await readFile(data.failed, 'utf8'));
      const log = await readFile(data.log, 'utf8').catch(() => '');
      if (log.includes('Replacement launched')) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Fixture completion timeout');
  }
  await writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
  await run(target, [fixture, dir]); await waitResult();
  assert.deepEqual(await readFile(target), bytes); assert.deepEqual(await readFile(data.backup), original);
  // A second isolated fixture exercises real helper failure before readiness.
  await writeFile(target, original); await rm(data.ready); await rm(data.commit);
  data.sha256 = '0'.repeat(64);
  await writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
  await run(target, [fixture, dir]);
  assert.match(await readFile(data.failed, 'utf8'), /SHA256/);
  assert.deepEqual(await readFile(target), original);
});
