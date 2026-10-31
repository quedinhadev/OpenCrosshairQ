// Node-only safety/oracle self-checks. Never require or spawn Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { contained, snapshot, sameSnapshot, parseSummary, runChild, main } = require('./refinement-acceptance-electron.cjs');
const { field, near, summarize, validateContract } = require('./refinement-acceptance-cases.cjs');
const root = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
const evidenceRoot = path.resolve('..', 'analysis/refinement-20261027/qa-evidence');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'node-selfcheck-'));
const passing = summarize([{ id: 'node-probe', verdict: 'PASS', observed: 'synthetic child, not application proof' }]);
const marker = 'REFINEMENT_SUMMARY=' + JSON.stringify(passing);
const immutable = { 'synthetic.txt': 'frozen' };

test('guard: no Electron launch without explicit release and freeze', async () => {
  await assert.rejects(main([]), /Electron blocked/);
  await assert.rejects(main(['--allow-electron']), /freeze=/);
});
test('containment rejects root, sibling, traversal; accepts exclusive descendants', () => {
  assert.equal(contained(root, path.join(root, 'qa-not-created')), path.join(root, 'qa-not-created'));
  for (const target of [root, path.dirname(root), root + '-other', path.join(root, '..', 'elsewhere')]) assert.throws(() => contained(root, target));
});
test('snapshot oracle detects content change, deletion and addition', () => {
  const a = snapshot(); assert.ok(Object.keys(a).includes('src/main/main.js'));
  assert.ok(sameSnapshot(a, structuredClone(a)));
  const b = { ...a, 'src/main/main.js': 'changed' }; assert.equal(sameSnapshot(a, b), false);
  delete b['src/main/main.js']; assert.equal(sameSnapshot(a, b), false);
  assert.equal(sameSnapshot(a, { ...a, extra: 'new' }), false);
});
test('summary rejects missing marker, duplicates, forged counts and undocumented non-PASS', () => {
  assert.deepEqual(parseSummary(marker), passing);
  for (const text of ['', 'PASS:', marker + '\n' + marker,
    'REFINEMENT_SUMMARY=' + JSON.stringify({ ...passing, pass: 99 }),
    'REFINEMENT_SUMMARY=' + JSON.stringify(summarize([{ id: 'x', verdict: 'SKIP' }])),
    'REFINEMENT_SUMMARY=' + JSON.stringify(summarize([{ id: 'x', verdict: 'PASS' }, { id: 'x', verdict: 'PASS' }]))]) assert.throws(() => parseSummary(text));
});
test('case oracles reject nonfinite numbers, excessive error and incomplete contracts', () => {
  near(.5, .51, .02);
  for (const args of [[NaN, 1, .02], [1, Infinity, .02], [1, 1, -1], [.5, .53, .02]]) assert.throws(() => near(...args));
  assert.equal(field({ a: { b: false } }, 'a.b'), false);
  for (const c of [{ unknown: true }, { aim: {} }, { controls: [] }, { controls: [{ action: 'a', selector: '#a' }, { action: 'a', selector: '#b' }] }, { clamp: { key: 'minimizeToTray' } }, { process: {} }, { motion: {} }, { lifecycle: {} }, { lifecycle: { key: 'minimizeToTray', initial: true, visible: false, minimized: false } }]) assert.throws(() => validateContract(c));
  assert.deepEqual(validateContract({}), {}); // Missing contracts become NOT_EXECUTED, not PASS.
  validateContract({ lifecycle: { key: 'startMinimized', initial: false, visible: true, minimized: false } });
  const s = summarize([{ id: 'a', verdict: 'PASS' }, { id: 'b', verdict: 'NOT_EXECUTED', reason: 'pending contract' }]);
  assert.equal(s.pass, 1); assert.equal(s.notExecuted, 1);
});
async function scenario(name, script, options = {}) {
  const ownedRoot = fs.mkdtempSync(path.join(root, 'cq-refinement-node-'));
  const output = path.join(evidence, name); fs.mkdirSync(output);
  const userData = path.join(ownedRoot, 'userData'), sessionData = path.join(ownedRoot, 'sessionData');
  for (const dir of [userData, sessionData]) fs.mkdirSync(dir);
  return runChild({ executable: process.execPath, args: ['-e', script], env: { ...process.env, CQ_UX_PROFILE: userData, CQ_REFINEMENT_SESSION: sessionData }, evidence: output, ownedRoot,
    snapshotFiles: () => immutable, expectedSnapshot: immutable, timeoutMs: 3000, ...options });
}
test('parent: Node child observes distinct paths; cleanup only after close', async () => {
  const result = await scenario('success', `const a=require('node:assert/strict');a.notEqual(process.env.CQ_UX_PROFILE,process.env.CQ_REFINEMENT_SESSION);console.log(${JSON.stringify(marker)})`);
  assert.equal(result.verdict, 'PASS'); assert.equal(result.closed, true);
  assert.equal(result.cleanup, 'removed after close'); assert.equal(fs.existsSync(result.ownedRoot), false);
  assert.equal(result.summary.pass, 1);
});
test('parent: zero exit plus generic PASS never bypasses granular summary', async () => {
  const result = await scenario('missing-summary', 'console.log("PASS:")');
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.cleanup, 'retained');
  assert.match(result.summaryError, /structured child summary/);
  assert.equal(result.closed, true); fs.rmSync(result.ownedRoot, { recursive: true });
});
test('parent: source changes invalidate otherwise passing child', async () => {
  let calls = 0;
  const result = await scenario('changed-snapshot', `console.log(${JSON.stringify(marker)})`, { snapshotFiles: () => ++calls === 1 ? immutable : { 'synthetic.txt': 'changed' } });
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.sourcesStable, false); assert.equal(result.cleanup, 'retained');
  assert.equal(result.closed, true); fs.rmSync(result.ownedRoot, { recursive: true });
});
test('parent: incomplete coverage stays explicit despite successful executed cases', async () => {
  const partial = summarize([{ id: 'probe', verdict: 'PASS' }, { id: 'Windows', verdict: 'NOT_EXECUTED', reason: 'no consent' }]);
  const result = await scenario('partial', `console.log(${JSON.stringify('REFINEMENT_SUMMARY=' + JSON.stringify(partial))})`);
  assert.equal(result.verdict, 'PASS'); assert.equal(result.coverageComplete, false); assert.equal(result.summary.notExecuted, 1);
});
test('parent: timeout kills only own Node child, FAIL plus retained evidence', { timeout: 10000 }, async () => {
  const result = await scenario('timeout', 'setInterval(()=>{},1000)', { timeoutMs: 250, graceMs: 1500 });
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.timedOut, true); assert.ok(result.pid);
  assert.equal(result.closed, true); assert.equal(result.cleanup, 'retained');
  assert.ok(fs.existsSync(path.join(result.evidence, 'parent.json')));
  fs.rmSync(result.ownedRoot, { recursive: true });
});
test('parent: spawn failure is finite FAIL without cleaning an unconfirmed child', async () => {
  const result = await scenario('spawn-error', '', { executable: path.join(root, 'CQ_NONEXISTENT_EXECUTABLE.exe') });
  assert.equal(result.verdict, 'FAIL'); assert.ok(result.spawnError); assert.equal(result.closed, true);
  fs.rmSync(result.ownedRoot, { recursive: true });
});
test('parent: pre-spawn freeze mismatch never spawns', async () => {
  const ownedRoot = fs.mkdtempSync(path.join(root, 'cq-refinement-node-'));
  let spawns = 0;
  try {
    await assert.rejects(runChild({ executable: process.execPath, args: [], env: {}, evidence, ownedRoot,
      snapshotFiles: () => immutable, expectedSnapshot: { wrong: 'hash' }, spawnChild: () => { spawns++; throw Error('must not spawn'); } }), /freeze changed/);
    assert.equal(spawns, 0);
  } finally { fs.rmSync(ownedRoot, { recursive: true }); }
});
test('parent: cleanup EBUSY is contained FAIL with profile retained after close', async () => {
  const result = await scenario('cleanup-ebusy', `console.log(${JSON.stringify(marker)})`, {
    removeOwned: () => { throw Object.assign(new Error('synthetic EBUSY'), { code: 'EBUSY' }); },
  });
  assert.equal(result.closed, true); assert.equal(result.verdict, 'FAIL');
  assert.equal(result.cleanupError.code, 'EBUSY'); assert.equal(result.cleanup, 'retained');
  assert.equal(fs.existsSync(result.ownedRoot), true);
  fs.rmSync(result.ownedRoot, { recursive: true });
});
console.log('NODE_SELF_CHECK_EVIDENCE=' + evidence);
