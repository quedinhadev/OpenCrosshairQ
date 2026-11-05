import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { generateReleaseMetadata } = require('../scripts/generate-release-metadata.cjs');

test('release metadata binds portable version, exact bytes, size and hashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-release-metadata-'));
  try {
    const portable = Buffer.from('MZ portable fixture');
    fs.writeFileSync(path.join(dir, 'OpenCrosshairQ-Portable.exe'), portable);
    fs.writeFileSync(path.join(dir, 'OpenCrosshairQ-Setup-0.2.0.exe'), 'MZ setup fixture');
    fs.writeFileSync(path.join(dir, 'OpenCrosshairQ-Setup-0.2.0.exe.blockmap'), 'blockmap fixture');
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.2.0\n');
    fs.writeFileSync(path.join(dir, 'OpenCrosshairQ-Setup-0.1.0.exe'), 'stale');
    const result = await generateReleaseMetadata({ distDir: dir, version: '0.2.0' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'portable-update.json'), 'utf8'));
    assert.deepEqual(manifest, { schemaVersion: 1, version: '0.2.0', file: 'OpenCrosshairQ-Portable.exe', size: portable.length, sha256: createHash('sha256').update(portable).digest('hex') });
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
    assert.ok(sums.includes('  portable-update.json'));
    assert.ok(sums.includes('  latest.yml'));
    assert.ok(!sums.includes('0.1.0'));
    assert.equal(result.files.length, 5);
    for (const file of result.files) assert.ok(sums.includes(`${createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex')}  ${file}`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing release artifacts fail before overwriting existing metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-release-metadata-missing-'));
  try {
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'portable-update.json'), 'keep');
    await assert.rejects(generateReleaseMetadata({ distDir: dir, version: '0.2.0' }));
    assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(dir, 'portable-update.json'), 'utf8'), 'keep');
    await assert.rejects(generateReleaseMetadata({ distDir: dir, version: '../bad' }), /version/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
