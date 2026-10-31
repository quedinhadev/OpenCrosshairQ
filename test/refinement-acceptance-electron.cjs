// QA-owned parent. Does not launch anything when imported by node:test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const appRoot = path.resolve(__dirname, '..');
const evidenceRoot = path.resolve(appRoot, '../analysis/refinement-20261027/qa-evidence');

function contained(root, target) {
  const rel = path.relative(root, target);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'path must be a strict descendant');
  // Reject existing links/junctions, including intermediate path components.
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    if (fs.existsSync(p)) assert.equal(fs.lstatSync(p).isSymbolicLink(), false, 'links/junctions forbidden');
    if (p === path.resolve(root)) break;
    assert.notEqual(p, path.dirname(p));
  }
  return target;
}
function snapshot(root = appRoot) {
  const files = ['package.json', 'package-lock.json', 'assets/icon.png', 'assets/icon.ico', 'build/icon.ico', 'native/build/crosshairq.node'];
  for (const dir of ['src', 'test']) for (const item of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (item.isFile()) files.push(path.relative(root, path.join(item.parentPath, item.name)).replaceAll('\\', '/'));
  }
  for (const item of fs.readdirSync(path.join(root, 'native'), { withFileTypes: true })) {
    if (item.isFile()) files.push('native/' + item.name);
  }
  return Object.fromEntries(files.sort().map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
function sameSnapshot(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function parseSummary(stdout) {
  const lines = stdout.split(/\r?\n/).filter(s => s.startsWith('REFINEMENT_SUMMARY='));
  assert.equal(lines.length, 1, 'exactly one structured child summary required');
  const summary = JSON.parse(lines[0].slice('REFINEMENT_SUMMARY='.length));
  assert.ok(Array.isArray(summary.results) && summary.results.length > 0);
  const ids = new Set();
  for (const r of summary.results) {
    assert.ok(r.id && !ids.has(r.id), 'unique case IDs'); ids.add(r.id);
    assert.ok(['PASS', 'FAIL', 'SKIP', 'NOT_EXECUTED'].includes(r.verdict));
    if (r.verdict !== 'PASS') assert.ok(r.reason || r.error, 'non-PASS needs explanation');
  }
  for (const [key, verdict] of Object.entries({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP', notExecuted: 'NOT_EXECUTED' })) {
    assert.equal(summary[key], summary.results.filter(r => r.verdict === verdict).length, 'honest case counts: ' + key);
  }
  return summary;
}
async function runChild({ executable, args, env, evidence, ownedRoot, expectedSnapshot, snapshotFiles = snapshot,
  removeOwned = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), timeoutMs = 90000, graceMs = 3000,
  spawnChild = spawn, killTree = pid => spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }) {
  contained(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode'), ownedRoot);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000);
  const result = { executable, args, parentPid: process.pid, ownedRoot, evidence, started: new Date().toISOString(), closed: false, timedOut: false, stdout: '', stderr: '' };
  const before = snapshotFiles(); result.sourcesBefore = before;
  if (expectedSnapshot) assert.deepEqual(before, expectedSnapshot, 'freeze changed immediately before spawn');
  const finish = await new Promise(resolve => {
    let child, timer, deadline, killer, finished = false;
    const done = (code, signal, expired = false) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(deadline);
      Object.assign(result, { code, signal, deadlineExpired: expired });
      if (expired) { result.remainingPid = child?.pid; child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
      if (killer) {
        try { if (killer.exitCode === null && killer.signalCode === null) killer.kill(); killer.unref(); }
        catch (e) { result.killCleanupError = e.message; }
      }
      resolve(result);
    };
    try { child = spawnChild(executable, args, { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { result.spawnError = error.stack; done(null, null); return; }
    result.pid = child.pid;
    console.log(`CHILD pid=${child.pid} profile=${env.CQ_UX_PROFILE} evidence=${evidence}`);
    child.stdout.on('data', b => { result.stdout += b; }); child.stderr.on('data', b => { result.stderr += b; });
    child.on('error', error => { result.spawnError = error.stack; });
    child.once('close', (code, signal) => { result.closed = true; done(code, signal); });
    timer = setTimeout(() => {
      result.timedOut = true;
      // No process-name/port scan: terminate only the PID returned by this spawn.
      if (child.pid) try {
        killer = killTree(child.pid); result.killerPid = killer.pid;
        killer.on('error', e => { result.killError = e.message; try { child.kill(); } catch (e) { result.fallbackError = e.message; } });
        killer.on('close', code => { result.killCode = code; if (code !== 0) try { child.kill(); } catch (e) { result.fallbackError = e.message; } });
      } catch (e) { result.killError = e.message; try { child.kill(); } catch (e) { result.fallbackError = e.message; } }
      deadline = setTimeout(() => { try { child.kill(); } catch (e) { result.fallbackError = e.message; } done(child.exitCode, child.signalCode, true); }, graceMs);
    }, timeoutMs);
  });
  try { finish.sourcesAfter = snapshotFiles(); finish.sourcesStable = sameSnapshot(before, finish.sourcesAfter); }
  catch (error) { finish.snapshotError = error.stack; finish.sourcesStable = false; }
  try { finish.summary = parseSummary(finish.stdout); } catch (error) { finish.summaryError = error.message; }
  const functional = finish.closed && finish.code === 0 && !finish.timedOut && !finish.spawnError && finish.sourcesStable && finish.summary?.fail === 0;
  // Preserve timeout/failure profiles. Only parent after close may delete its own allocation.
  finish.cleanup = 'retained';
  if (functional) try { contained(path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode'), ownedRoot); removeOwned(ownedRoot); finish.cleanup = 'removed after close'; }
  catch (error) { finish.cleanupError = { code: error.code, message: error.message }; }
  finish.verdict = functional && !finish.cleanupError ? 'PASS' : 'FAIL';
  finish.coverageComplete = finish.summary ? finish.summary.skip === 0 && finish.summary.notExecuted === 0 : false;
  fs.writeFileSync(path.join(evidence, 'stdout.log'), finish.stdout);
  fs.writeFileSync(path.join(evidence, 'stderr.log'), finish.stderr);
  fs.writeFileSync(path.join(evidence, 'parent.json'), JSON.stringify(finish, null, 2));
  return finish;
}
async function main(args) {
  assert.ok(args.includes('--allow-electron'), 'Electron blocked: explicit --allow-electron required after coordinator freeze');
  const freezeFile = args.find(s => s.startsWith('--freeze='))?.slice(9);
  assert.ok(freezeFile, '--freeze=<final SHA-256 manifest> required');
  const frozen = JSON.parse(fs.readFileSync(freezeFile, 'utf8'));
  assert.deepEqual(snapshot(), frozen, 'final freeze must match sources/tests/assets exactly before spawn');
  const contractFile = args.find(s => s.startsWith('--contract='))?.slice(11);
  const contract = contractFile ? JSON.parse(fs.readFileSync(contractFile, 'utf8')) : {};
  if (contractFile) require('./refinement-acceptance-cases.cjs').validateContract(contract);
  assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA required');
  const temp = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const ownedRoot = fs.mkdtempSync(path.join(temp, 'cq-refinement-'));
  const profile = path.join(ownedRoot, 'userData'), session = path.join(ownedRoot, 'sessionData');
  for (const dir of [profile, session]) fs.mkdirSync(dir);
  if (contract.lifecycle) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ [contract.lifecycle.key]: contract.lifecycle.initial }));
  fs.writeFileSync(path.join(evidence, 'contract.json'), JSON.stringify(contract, null, 2));
  fs.writeFileSync(path.join(evidence, 'freeze.json'), JSON.stringify(frozen, null, 2));
  const env = { ...process.env, CQ_UX_PROFILE: profile, CQ_UX_MODE: '1', CQ_REFINEMENT_SESSION: session, CQ_REFINEMENT_OUTPUT: evidence };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = require('electron');
  const result = await runChild({ executable, args: [path.join(__dirname, 'ux-acceptance-electron.cjs'), `--user-data-dir=${profile}`], env, evidence, ownedRoot, expectedSnapshot: frozen });
  console.log(`RESULT ${result.verdict} complete=${result.coverageComplete} evidence=${evidence}`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}
module.exports = { contained, snapshot, sameSnapshot, parseSummary, runChild, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
