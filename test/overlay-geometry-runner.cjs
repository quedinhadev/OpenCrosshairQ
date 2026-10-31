// Parent owns timeout, logs and profile cleanup. Never boots production main.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { center, tolerance, captureRelation } = require('./overlay-geometry-qa.cjs');

function existing() {
  const groups = { block: [], inline: [] };
  for (const name of ['test-backend-geometry-runtime.json', 'test-backend-geometry-runtime-hidpi.json']) {
    const file = path.resolve(__dirname, '../../analysis', name);
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [index, c] of report.cases.entries()) {
      const dx = c.pixels.cx - c.pixels.width / 2, dy = c.pixels.cy - c.pixels.height / 2;
      groups[c.inline ? 'inline' : 'block'].push({ file: name, index, ratio: c.ratio, zoom: c.zoom, scale: c.scale,
        dpr: c.metrics.dpr, width: c.pixels.width, height: c.pixels.height, ...center(dx, dy),
        units: 'historical capture bitmap pixels; representation metadata unavailable',
        captureRelation: captureRelation(c.pixels, c.contentBounds, report.display),
        cssPerAxisTolerance: (tolerance.snappingPerAxis + tolerance.numericalEpsilon) / c.metrics.dpr });
    }
  }
  for (const [group, cases] of Object.entries(groups)) console.log(JSON.stringify({ group, historicalReclassificationOnly: true, tolerance, cases,
    idealExact: cases.filter(c => c.idealExact).length, quantizedAcceptable: cases.filter(c => c.quantizedAcceptable).length,
    pass: cases.filter(c => c.pass).length, fail: cases.filter(c => !c.pass).length }));
  process.exitCode = groups.block.some(c => !c.pass) ? 1 : 0;
}

function run({ args = [], executable = require('electron'), childArgs, spawnChild = spawn, killer = pid => spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }),
  fallback = child => child.kill('SIGKILL'), killGraceMs = 1500 } = {}) {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA required');
  const timeoutMs = Number(args.find(a => a.startsWith('--timeout-ms='))?.split('=')[1] ?? 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('timeout-ms must be 100..120000');
  if (!Number.isInteger(killGraceMs) || killGraceMs < 100 || killGraceMs > 10000) throw new Error('killGraceMs must be 100..10000');
  const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const run = fs.mkdtempSync(path.join(root, 'cq-geometry-run-'));
  const profile = path.join(run, 'profile');
  fs.mkdirSync(profile);
  childArgs ??= [path.join(__dirname, 'overlay-geometry.cjs'), ...args.filter(a => !a.startsWith('--timeout-ms=') && a !== '--inject-cleanup-ebusy')];
  const suffix = args.includes('--after-anchor') ? '-after-anchor' : '';
  const env = { ...process.env, CQ_GEOMETRY_USER_DATA: profile, CQ_GEOMETRY_REPORT: path.join(run, `child${suffix}.json`) };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = { executable, args: childArgs, parentPid: process.pid, run, profile, timeoutMs, killGraceMs, stdout: '', stderr: '', timedOut: false, closed: false };
  const started = Date.now();
  const child = spawnChild(executable, childArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  result.pid = child.pid;
  console.log(`CHILD pid=${child.pid} run=${run}`);
  child.stdout.on('data', b => { result.stdout += b; process.stdout.write(b); });
  child.stderr.on('data', b => { result.stderr += b; process.stderr.write(b); });
  let finished = false, deadline, killProcess, fallbackUsed = false;
  function alive() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
    try { process.kill(child.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
  }
  function finish(code, signal, deadlineExpired = false) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout); clearTimeout(deadline);
    Object.assign(result, { code, signal, deadlineExpired, durationMs: Date.now() - started, childAlive: alive() });
    if (result.childAlive) result.remainingPid = child.pid;
    // No cleanup without close, even if a PID probe says exited. Timeout evidence stays.
    if (!result.closed || result.childAlive || result.timedOut) result.cleanup = 'retained; timeout or close not confirmed';
    else try {
      if (args.includes('--inject-cleanup-ebusy')) throw Object.assign(new Error('CQ_GEOMETRY_TEST_ONLY_EBUSY'), { code: 'EBUSY' });
      fs.rmSync(profile, { recursive: true, force: true });
      result.cleanup = 'removed after close';
    } catch (error) { result.cleanup = 'retained'; result.cleanupError = { code: error.code, message: error.message }; }
    result.verdict = code === 0 && result.closed && !result.timedOut && !result.spawnError && !result.cleanupError ? 'PASS' : 'FAIL';
    try { fs.writeFileSync(path.join(run, `parent${suffix}.json`), JSON.stringify(result, null, 2) + '\n'); }
    catch (error) { result.verdict = 'FAIL'; console.error('Parent report write failed:', error); }
    console.log(`RESULT ${result.verdict} pid=${child.pid} code=${code} timeout=${result.timedOut} remainingPid=${result.remainingPid ?? 'none'} cleanup=${result.cleanup} log=${path.join(run, `parent${suffix}.json`)}`);
    process.exitCode = result.verdict === 'PASS' ? 0 : 1;
    if (deadlineExpired) {
      // Release only handles owned here; live child keeps its profile and PID evidence.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
    if (killProcess) {
      if (killProcess.exitCode === null && killProcess.signalCode === null) {
        try { killProcess.kill(); } catch (e) { console.error('Killer teardown:', e.message); }
      }
      killProcess.stdout?.destroy(); killProcess.stderr?.destroy(); killProcess.unref();
    }
  }
  function fallbackKill(reason) {
    if (finished || fallbackUsed || !alive()) return;
    fallbackUsed = true;
    result.fallback = { pid: child.pid, reason, method: 'child.kill(SIGKILL); known child only, no process-name scan; descendants not guaranteed' };
    try { result.fallback.sent = fallback(child); }
    catch (e) { result.fallback.error = e.message; }
  }
  child.on('error', error => { result.spawnError = error.message; });
  const timeout = setTimeout(() => {
    result.timedOut = true;
    deadline = setTimeout(() => {
      fallbackKill('kill deadline reached');
      result.diagnostic = 'finite kill deadline reached; close not confirmed; profile retained';
      finish(child.exitCode, child.signalCode, true);
    }, killGraceMs);
    if (alive()) {
      result.killOutput = '';
      try {
        killProcess = killer(child.pid);
        result.killerPid = killProcess.pid;
        killProcess.stdout?.on('data', b => { result.killOutput += b; });
        killProcess.stderr?.on('data', b => { result.killOutput += b; });
        killProcess.on('error', e => { result.killError = e.message; fallbackKill('taskkill spawn error'); });
        killProcess.on('close', code => { result.killCode = code; if (code !== 0) fallbackKill('taskkill nonzero'); });
      } catch (e) { result.killError = e.message; fallbackKill('taskkill spawn throw'); }
    }
  }, timeoutMs);
  child.on('close', (code, signal) => { result.closed = true; finish(code, signal); });
  return result;
}
module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--existing')) existing(); else run({ args });
}
