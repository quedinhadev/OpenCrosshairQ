import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('smoke setup mkdir isolation regression', () => {
  let sandbox;
  const originalLocalAppData = process.env.LOCALAPPDATA;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-sandbox-reg-'));
    process.env.LOCALAPPDATA = sandbox;
  });

  afterEach(() => {
    process.env.LOCALAPPDATA = originalLocalAppData;
    if (sandbox && fs.existsSync(sandbox)) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('mkdtempSync throws ENOENT when parent Temp/opencode does not exist', () => {
    const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
    assert.equal(fs.existsSync(tempRoot), false, 'parent directory does not exist in clean sandbox');

    assert.throws(() => {
      fs.mkdtempSync(path.join(tempRoot, 'cq-test-'));
    }, { code: 'ENOENT' });
  });

  test('mkdirSync recursive creates parent and enables mkdtempSync in clean environment', () => {
    const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
    fs.mkdirSync(tempRoot, { recursive: true });
    assert.equal(fs.existsSync(tempRoot), true, 'parent directory created recursively');

    const created = fs.mkdtempSync(path.join(tempRoot, 'cq-test-'));
    assert.equal(fs.existsSync(created), true, 'isolated directory created successfully');
    assert.ok(created.startsWith(tempRoot), 'directory resides inside sandboxed Temp/opencode');
  });

  const targets = [
    { file: 'electron-smoke.cjs', prefix: 'cq-electron-test-' },
    { file: 'foreground-electron.cjs', prefix: 'cq-foreground-test-' },
    { file: 'shortcut-physical.cjs', prefix: 'cq-shortcut-test-' },
  ];

  for (const { file, prefix } of targets) {
    test(`${file} includes recursive mkdirSync guard before mkdtempSync`, () => {
      const filePath = path.join(__dirname, file);
      const content = fs.readFileSync(filePath, 'utf8');

      const pattern = /const tempRoot = path\.join\(process\.env\.LOCALAPPDATA, 'Temp', 'opencode'\);\s+fs\.mkdirSync\(tempRoot, \{ recursive: true \}\);\s+const data = fs\.mkdtempSync\(path\.join\(tempRoot, '[^']+'\)\);/;
      assert.match(content, pattern, `${file} must ensure parent exists with recursive: true before mkdtempSync`);
    });

    test(`${file} setup pattern creates isolated directory in clean sandbox`, () => {
      const tempRoot = path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode');
      fs.mkdirSync(tempRoot, { recursive: true });
      const data = fs.mkdtempSync(path.join(tempRoot, prefix));

      assert.equal(fs.existsSync(data), true);
      assert.equal(path.dirname(data), tempRoot);
    });
  }
});
