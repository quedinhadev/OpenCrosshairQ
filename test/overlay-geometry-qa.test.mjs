import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { center, tolerance, raster, captureRelation } = require('./overlay-geometry-qa.cjs');
const runner = require.resolve('./overlay-geometry-runner.cjs');

test('ideal center has zero error, distinct from quantized acceptance', () => {
  assert.equal(tolerance.snappingPerAxis, .5); assert.equal(tolerance.numericalEpsilon, .02);
  assert.equal(tolerance.radialGate, false);
  assert.deepEqual(center(0, 0), { dx: 0, dy: 0, distance: 0, idealExact: true, quantizedAcceptable: false, pass: true });
});
for (const dx of [-.5, .5]) for (const dy of [-.5, .5]) test(`both-axis tie (${dx},${dy}) accepted without radial gate`, () => {
  const c = center(dx, dy);
  assert.equal(c.pass, true); assert.equal(c.idealExact, false); assert.equal(c.quantizedAcceptable, true);
  assert.equal(c.distance, Math.hypot(.5, .5)); assert.ok(c.distance > .52);
});
for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, -1], [.520001, 0], [0, -.520001], [NaN, 0], [0, Infinity]]) {
  test(`reject center error (${dx},${dy})`, () => assert.equal(center(dx, dy).pass, false));
}
test('numerical epsilon inclusive, not extra snapping budget', () => assert.equal(center(.52, -.52).pass, true));
const image = (width, height, bytes) => ({ getSize: () => ({ width, height }), toBitmap: () => bytes, getScaleFactors: () => [1, 1.25] });
test('bitmap centroid records size, bytes, weight and available representations', () => {
  const p = raster(image(2, 1, Buffer.from([0, 0, 0, 255, 0, 0, 0, 255])));
  assert.equal(p.cx, 1); assert.equal(p.cy, .5); assert.equal(p.weight, 510);
  assert.deepEqual(p.representation.getSize, { width: 2, height: 1 });
  assert.equal(p.representation.bitmapBytes, 8); assert.equal(p.representation.requestedScaleFactor, 1);
  assert.deepEqual(p.representation.availableScaleFactors, [1, 1.25]);
});
for (const [name, width, height, bytes, error] of [
  ['empty dimensions', 0, 0, Buffer.alloc(0), /positive integer/],
  ['zero height', 1, 0, Buffer.alloc(0), /positive integer/],
  ['negative width', -1, 1, Buffer.alloc(0), /positive integer/],
  ['empty buffer', 1, 1, Buffer.alloc(0), /byte length/],
  ['short buffer', 2, 2, Buffer.alloc(12), /byte length/],
  ['oversize buffer', 1, 1, Buffer.alloc(8), /byte length/],
  ['transparent buffer', 1, 1, Buffer.alloc(4), /alpha weight/],
  ['nonfinite alpha weight', 1, 1, [0, 0, 0, Infinity], /alpha weight/]
]) test(`bitmap rejects ${name} before centroid`, () => assert.throws(() => raster(image(width, height, bytes)), error));
test('invalid bitmap keeps representation evidence on error', () => {
  assert.throws(() => raster(image(1, 1, Buffer.alloc(0))), error => {
    assert.equal(error.representation.bitmapBytes, 0);
    assert.deepEqual(error.representation.getSize, { width: 1, height: 1 });
    return true;
  });
});
test('physical claim requires capture/content/display dimension relation', () => {
  assert.equal(captureRelation({ width: 1000, height: 750 }, { width: 800, height: 600 }, { scaleFactor: 1.25 }).physicalDimensionsSupported, true);
  assert.equal(captureRelation({ width: 800, height: 600 }, { width: 800, height: 600 }, { scaleFactor: 1.25 }).physicalDimensionsSupported, false);
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
async function scenario(t, mode) {
  // Leaf-only Node child, no Electron/Windows effects. Controller owns final cleanup.
  const script = `const {spawn}=require('node:child_process');
    const killer = ${mode.includes('nonzero') ? "() => spawn(process.execPath, ['-e', 'process.exit(7)'])" : mode === 'killer-hang' ? "() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])" : "() => spawn('CQ_GEOMETRY_MISSING_TASKKILL.exe', [])"};
    require(${JSON.stringify(runner)}).run({
      executable: process.execPath, childArgs: ['-e', ${JSON.stringify("console.log('TEST_CHILD_READY pid='+process.pid);process.stdout.destroy();process.stderr.destroy();setTimeout(()=>process.exit(0),5000)")}],
      args: ['--timeout-ms=200'], killGraceMs: 600, killer,
      spawnChild: (exe, args, options) => spawn(exe, args, {...options, detached: true}),
      ${mode.startsWith('survive') ? "fallback: () => false," : mode === 'fallback-throw' ? "fallback: () => {throw new Error('TEST_FALLBACK_DENIED');}," : ''}
    });`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', pid, killerPid, reportPath, watchdog;
  parent.stdout.on('data', b => {
    stdout += b;
    pid = Number(stdout.match(/CHILD pid=(\d+)/)?.[1]) || pid;
    const run = stdout.match(/CHILD pid=\d+ run=([^\r\n]+)/)?.[1];
    if (run) reportPath = `${run}/parent.json`;
  });
  parent.stderr.on('data', b => { stderr += b; });
  try {
    const exit = await Promise.race([
      new Promise((resolve, reject) => { parent.on('error', reject); parent.on('close', (code, signal) => resolve({ code, signal })); }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`test controller deadline: ${stdout} ${stderr}`)), 8000); })
    ]);
    assert.equal(exit.code, 1, stdout + stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    killerPid = report.killerPid;
    t.diagnostic(JSON.stringify({ mode, parentPid: parent.pid, pid, reportPath, exitCode: exit.code, closed: report.closed,
      killerPid, deadlineExpired: report.deadlineExpired, remainingPid: report.remainingPid, durationMs: report.durationMs }));
    assert.equal(report.verdict, 'FAIL'); assert.equal(report.timedOut, true);
    assert.equal(report.fallback.pid, pid); assert.ok(report.durationMs < 4000);
    assert.match(report.cleanup, /retained/); assert.equal(fs.existsSync(report.profile), true);
    if (mode.includes('nonzero')) assert.equal(report.killCode, 7);
    else if (mode !== 'killer-hang') assert.match(report.killError, /ENOENT/);
    if (mode.startsWith('survive') || mode === 'fallback-throw') {
      assert.equal(report.deadlineExpired, true); assert.equal(report.closed, false);
      assert.equal(report.childAlive, true); assert.equal(report.remainingPid, pid); assert.equal(alive(pid), true);
      assert.match(report.diagnostic, /finite kill deadline/);
      if (mode === 'fallback-throw') assert.equal(report.fallback.error, 'TEST_FALLBACK_DENIED');
    } else if (mode === 'killer-hang') {
      assert.equal(report.deadlineExpired, true); assert.equal(report.fallback.sent, true);
    } else {
      assert.equal(report.closed, true); assert.equal(report.childAlive, false); assert.equal(alive(pid), false);
      assert.equal(report.fallback.sent, true);
    }
  } finally {
    clearTimeout(watchdog);
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    for (const ownedPid of [pid, killerPid].filter(Boolean)) {
      if (alive(ownedPid)) process.kill(ownedPid, 'SIGKILL');
      const until = Date.now() + 2000;
      while (alive(ownedPid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(ownedPid), false, `owned test process ${ownedPid} must not remain orphaned`);
      t.diagnostic(`controller confirms owned PID ${ownedPid} exited; retained profile untouched`);
    }
  }
}
for (const mode of ['spawn-error', 'nonzero', 'survive-spawn-error', 'survive-nonzero', 'fallback-throw', 'killer-hang']) {
  test(`runner ${mode}: finite FAIL with PID/report, no live-profile cleanup`, { timeout: 12000 }, t => scenario(t, mode));
}
