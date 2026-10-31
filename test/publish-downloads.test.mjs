import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/publish-downloads.mjs', import.meta.url));
test('publisher rejects missing/empty dist without changing existing checksums', () => {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'cq-publish-'));
  try {
    const cwd = path.join(root, 'app');
    const download = path.join(root, 'download');
    fs.mkdirSync(cwd);
    fs.mkdirSync(download);
    const manifest = path.join(download, 'SHA256SUMS.txt');
    fs.writeFileSync(manifest, 'existing checksums\n');
    for (const empty of [false, true]) {
      if (empty) fs.mkdirSync(path.join(cwd, 'dist'));
      const run = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.equal(fs.readFileSync(manifest, 'utf8'), 'existing checksums\n');
      assert.deepEqual(fs.readdirSync(download), ['SHA256SUMS.txt']);
    }
    const name = 'OpenCrosshairQ.exe';
    const content = Buffer.from('isolated test artifact');
    fs.writeFileSync(path.join(cwd, 'dist', name), content);
    const run = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(fs.readFileSync(path.join(download, name)), content);
    const hash = createHash('sha256').update(content).digest('hex');
    assert.equal(fs.readFileSync(manifest, 'utf8'), `${hash}  ${name}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
