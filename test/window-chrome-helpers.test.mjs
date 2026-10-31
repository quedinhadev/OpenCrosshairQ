import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  waitForDevToolsPort,
  removeUserData,
  cleanupCore,
  assertRegions,
  isChildExited,
} = require('./window-chrome.cjs');

const tempRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
  : path.join(os.tmpdir(), 'opencode');

function createTempDir(prefix = 'cq-test-helper-') {
  fs.mkdirSync(tempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tempRoot, prefix));
}

test('isChildExited identifies exited, signaled and running processes', () => {
  assert.equal(isChildExited(null), true);
  assert.equal(isChildExited({ exitCode: 0, signalCode: null }), true);
  assert.equal(isChildExited({ exitCode: 1, signalCode: null }), true);
  assert.equal(isChildExited({ exitCode: null, signalCode: 'SIGTERM' }), true);
  assert.equal(isChildExited({ exitCode: null, signalCode: null }), false);
});

test('cleanup sem exit confirmado preserva perfil e retorna exit 1', async () => {
  const profileDir = createTempDir('cq-test-noexit-');
  const dummyFile = path.join(profileDir, 'dummy.json');
  fs.writeFileSync(dummyFile, '{"test":1}');

  const unkillableChild = new EventEmitter();
  unkillableChild.pid = 99991;
  unkillableChild.exitCode = null;
  unkillableChild.signalCode = null;

  try {
    const code = await cleanupCore({
      code: 0,
      childProc: unkillableChild,
      profileDir,
      waitTimeoutMs: 50,
      killFn: () => {},
    });

    assert.equal(code, 1, 'must force exit 1 when child does not exit');
    assert.equal(fs.existsSync(profileDir), true, 'profile must be preserved if child did not exit');
    assert.equal(fs.existsSync(dummyFile), true, 'profile contents must be preserved');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('rmSync falha força status 1 mesmo se code inicial era 0', async () => {
  const profileDir = createTempDir('cq-test-rmfail-');
  const child = { exitCode: 0, signalCode: null };

  try {
    const code = await cleanupCore({
      code: 0,
      childProc: child,
      profileDir,
      removeFn: async () => false,
    });
    assert.equal(code, 1, 'must force exit 1 when profile removal fails');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('removeUserData esgota retries e retorna false se rmSync falhar', async () => {
  const profileDir = createTempDir('cq-test-rmretries-');
  try {
    const res = await removeUserData(profileDir, {
      maxRetries: 2,
      delayMs: 10,
      rmFn: () => { throw new Error('EBUSY locked'); },
    });
    assert.equal(res, false, 'must return false when retries exhausted');
    assert.equal(fs.existsSync(profileDir), true, 'dir exists after failed rmFn');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('cleanup com exit confirmado remove perfil e preserva code 0', async () => {
  const profileDir = createTempDir('cq-test-okexit-');
  fs.writeFileSync(path.join(profileDir, 'data.txt'), 'hello');

  const normalChild = new EventEmitter();
  normalChild.pid = 99992;
  normalChild.exitCode = null;
  normalChild.signalCode = null;

  const code = await cleanupCore({
    code: 0,
    childProc: normalChild,
    profileDir,
    killFn: (proc) => {
      proc.exitCode = 0;
      proc.emit('exit', 0);
    },
  });

  assert.equal(code, 0);
  assert.equal(fs.existsSync(profileDir), false, 'profile directory removed after clean exit');
});

test('DevToolsActivePort parser descobre porta valida', async () => {
  const dir = createTempDir('cq-test-port-');
  try {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '54321\n/devtools/browser/dummy-uuid\n');
    const port = await waitForDevToolsPort(dir, 1000);
    assert.equal(port, 54321);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForDevToolsPort rejeita imediatamente se filho encerrar antes da porta', async () => {
  const dir = createTempDir('cq-test-earlyexit-');
  const child = { exitCode: 2, signalCode: null };
  try {
    await assert.rejects(
      async () => await waitForDevToolsPort(dir, 1000, child),
      /Electron child exited early with code 2/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForDevToolsPort rejeita por timeout se DevToolsActivePort ausente', async () => {
  const dir = createTempDir('cq-test-timeout-');
  const child = { exitCode: null, signalCode: null };
  try {
    await assert.rejects(
      async () => await waitForDevToolsPort(dir, 50, child),
      /Timeout waiting for DevToolsActivePort/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertRegions valida drag e no-drag estritos', () => {
  const valid = {
    topbar: 'drag',
    btns: [
      { id: 'btnWinMin', region: 'no-drag' },
      { id: 'btnWinMax', region: 'no-drag' },
      { id: 'btnWinClose', region: 'no-drag' },
    ],
  };
  assert.doesNotThrow(() => assertRegions(valid));

  assert.throws(() => assertRegions({ ...valid, topbar: '' }), /topbar must be -webkit-app-region: drag/);
  assert.throws(() => assertRegions({ ...valid, topbar: 'no-drag' }), /topbar must be -webkit-app-region: drag/);
  assert.throws(() => assertRegions({
    ...valid,
    btns: [
      { id: 'btnWinMin', region: '' },
      { id: 'btnWinMax', region: 'no-drag' },
      { id: 'btnWinClose', region: 'no-drag' },
    ],
  }), /btnWinMin must be -webkit-app-region: no-drag/);
  assert.throws(() => assertRegions({
    ...valid,
    btns: [
      { id: 'btnWinMin', region: 'drag' },
      { id: 'btnWinMax', region: 'no-drag' },
      { id: 'btnWinClose', region: 'no-drag' },
    ],
  }), /btnWinMin must be -webkit-app-region: no-drag/);
  assert.throws(() => assertRegions({ ...valid, btns: [{ id: 'btnWinMin', region: 'no-drag' }] }), /all 3 window control buttons must be inspected/);
});
