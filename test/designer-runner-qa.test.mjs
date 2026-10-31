import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const smokeRunner = require.resolve('./designer-interaction-smoke.cjs');
const { alive, poll } = require(smokeRunner);

test('poll utility handles resolution and rejection on timeout', async () => {
  let calls = 0;
  assert.equal(await poll(async () => ++calls >= 3, 'poll three calls', 100), true);
  assert.equal(calls, 3);
  await assert.rejects(poll(async () => false, 'poll timeout', 50), /timeout: poll timeout/);
});

test('alive identifies running and terminated pids without false ESRCH throws', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(null), false);
  assert.equal(alive(undefined), false);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(alive(9999999), false);
});

async function scenario(t, mode) {
  const script = `const { spawn } = require('node:child_process');
    const killer = ${mode.includes('nonzero') ? "() => spawn(process.execPath, ['-e', 'process.exit(7)'])" : mode === 'killer-hang' ? "() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])" : "() => spawn('CQ_SMOKE_MISSING_TASKKILL.exe', [])"};
    require(${JSON.stringify(smokeRunner)}).run({
      executable: process.execPath,
      childArgs: ['-e', ${JSON.stringify("console.log('TEST_CHILD_READY pid=' + process.pid); process.stdout.destroy(); process.stderr.destroy(); setTimeout(() => process.exit(0), 5000)")}],
      args: ['--timeout-ms=200'],
      killGraceMs: 600,
      killer,
      spawnChild: (exe, args, options) => spawn(exe, args, { ...options, detached: true }),
      ${mode.startsWith('survive') ? "fallback: () => false," : mode === 'fallback-throw' ? "fallback: () => { throw new Error('TEST_FALLBACK_DENIED'); }," : ''}
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
    assert.equal(report.verdict, 'FAIL');
    assert.equal(report.timedOut, true);
    assert.equal(report.fallback.pid, pid);
    assert.ok(report.durationMs < 4000);
    assert.match(report.cleanup, /retained/);
    assert.equal(fs.existsSync(report.profile), true);
    if (mode.includes('nonzero')) assert.equal(report.killCode, 7);
    else if (mode !== 'killer-hang') assert.match(report.killError, /ENOENT/);
    if (mode.startsWith('survive') || mode === 'fallback-throw') {
      assert.equal(report.deadlineExpired, true);
      assert.equal(report.closed, false);
      assert.equal(report.childAlive, true);
      assert.equal(report.remainingPid, pid);
      assert.equal(alive(pid), true);
      assert.match(report.diagnostic, /finite kill deadline/);
      if (mode === 'fallback-throw') assert.equal(report.fallback.error, 'TEST_FALLBACK_DENIED');
    } else if (mode === 'killer-hang') {
      assert.equal(report.deadlineExpired, true);
      assert.equal(report.fallback.sent, true);
    } else {
      assert.equal(report.closed, true);
      assert.equal(report.childAlive, false);
      assert.equal(alive(pid), false);
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

test('runner cleanup EBUSY retains profile and exits 1', async () => {
  const script = `require(${JSON.stringify(smokeRunner)}).run({
    executable: process.execPath,
    childArgs: ['-e', 'process.exit(0)'],
    args: ['--inject-cleanup-ebusy'],
  });`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', reportPath;
  parent.stdout.on('data', b => {
    stdout += b;
    const run = stdout.match(/CHILD pid=\d+ run=([^\r\n]+)/)?.[1];
    if (run) reportPath = `${run}/parent.json`;
  });
  const exit = await new Promise((resolve, reject) => {
    parent.on('error', reject);
    parent.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 1);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.cleanup, 'retained');
  assert.equal(report.cleanupError?.code, 'EBUSY');
  assert.equal(fs.existsSync(report.profile), true);
  fs.rmSync(report.run, { recursive: true, force: true });
});

test('runner spawn-throw fails immediately and reports error', async () => {
  const script = `const runner = require(${JSON.stringify(smokeRunner)});
    runner.run({
      executable: 'NON_EXISTENT_EXECUTABLE_PATH',
      childArgs: [],
      spawnChild: () => { throw new Error('SYNCHRONOUS_SPAWN_FAILURE'); },
    });`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', reportPath;
  parent.stdout.on('data', b => {
    stdout += b;
    const match = stdout.match(/log=([^\r\n]+)/)?.[1];
    if (match) reportPath = match;
  });
  const exit = await new Promise((resolve, reject) => {
    parent.on('error', reject);
    parent.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 1);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.spawnError, 'SYNCHRONOUS_SPAWN_FAILURE');
  assert.match(report.cleanup, /retained/);
  fs.rmSync(report.run, { recursive: true, force: true });
});
