import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const https = require('node:https');
const { createPortableUpdater, newer, allowedURL, validateManifest, transfer, FEED, MAX_BINARY } = require('../src/main/portable-updater');
const content = Buffer.from('innocuous fixture');
const sha256 = crypto.createHash('sha256').update(content).digest('hex');
const manifest = { schemaVersion: 1, version: '0.2.1', file: 'OpenCrosshairQ-Portable.exe', size: content.length, sha256 };
const base = 'https://github.com/quedinhadev/OpenCrosshairQ/releases/download/v0.2.1/';
const release = { tag_name: 'v0.2.1', assets: ['portable-update.json', manifest.file].map(name => ({ name, size: content.length, browser_download_url: base + name })) };
async function harness(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "cq portable ' test "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'Original Portable.exe');
  await writeFile(target, 'original');
  const calls = [];
  let quits = 0;
  const engine = createPortableUpdater({ currentVersion: '0.2.0', executable: target, cacheDir: path.join(dir, 'cache'),
    app: { quit() { quits++; } }, transport: async (url, opts) => {
      calls.push(url);
      if (url === FEED) return JSON.stringify(release);
      if (url.endsWith('.json')) return JSON.stringify(manifest);
      await writeFile(opts.destination, content); opts.progress({ percent: 100 });
    }, ...options });
  return { engine, dir, target, calls, quits: () => quits };
}
test('stable versions compare exactly and reject prerelease, malformed, leading zeros', () => {
  assert.equal(newer('0.2.1', '0.2.0'), true);
  assert.equal(newer('0.2.0', '0.2.0'), false);
  assert.equal(newer('0.1.9', '0.2.0'), false);
  assert.equal(newer('99999999999999999999.0.0', '1.0.0'), true);
  for (const v of ['v0.2.1', '0.2.1-beta', '01.2.1', '0.2', '0.2.1+meta', null]) assert.throws(() => newer(v, '0.2.0'));
});
test('only fixed repository assets and explicit HTTPS GitHub CDN redirects allowed', () => {
  allowedURL(base + manifest.file, true);
  allowedURL('https://release-assets.githubusercontent.com/file?sig=abc');
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://evil.test/a',
    'https://user:password@github.com/quedinhadev/OpenCrosshairQ/releases/download/v1/a',
    'https://github.com/other/repo/releases/download/v1/a', 'https://api.github.com/a', 'file:///C:/a',
    'https://objects.githubusercontent.com:444/a']) assert.throws(() => allowedURL(url));
  assert.throws(() => allowedURL('https://release-assets.githubusercontent.com/file', true));
});
test('manifest rejects quota, path traversal, invalid hash/schema/version and prerelease', () => {
  assert.equal(validateManifest(manifest, release, '0.2.0').sha256, sha256);
  for (const patch of [{ schemaVersion: 2 }, { file: '../evil.exe' }, { size: 0 }, { size: MAX_BINARY + 1 },
    { size: 1.5 }, { sha256: '0'.repeat(63) }, { version: '0.2.0' }, { version: '0.2.1-beta' }])
    assert.throws(() => validateManifest({ ...manifest, ...patch }, release, '0.2.0'));
  assert.throws(() => validateManifest(manifest, { ...release, prerelease: true }, '0.2.0'));
});
test('check verifies download, emits compatible events, never installs automatically', async t => {
  const h = await harness(t);
  const events = [];
  for (const event of ['checking-for-update', 'update-available', 'download-progress', 'update-downloaded']) h.engine.on(event, () => events.push(event));
  await (await h.engine.checkForUpdates()).downloadPromise;
  assert.deepEqual(events, ['checking-for-update', 'update-available', 'download-progress', 'update-downloaded']);
  assert.equal(h.calls[0], FEED); assert.equal(h.quits(), 0);
  assert.equal(await readFile(h.target, 'utf8'), 'original');
});
test('corrupt download fails closed, keeps original, disallows install', async t => {
  const h = await harness(t, { transport: async (url, opts) => {
    if (url === FEED) return JSON.stringify(release);
    if (url.endsWith('.json')) return JSON.stringify(manifest);
    await writeFile(opts.destination, 'corrupt');
  } });
  await assert.rejects((await h.engine.checkForUpdates()).downloadPromise, /verification/);
  await assert.rejects(h.engine.quitAndInstall(), /not ready/);
  assert.equal(await readFile(h.target, 'utf8'), 'original'); assert.equal(h.quits(), 0);
});
test('helper synchronous spawn failure rejects and allows explicit retry without quitting', async t => {
  let attempts = 0;
  const h = await harness(t, { spawnHelper() { attempts++; throw new Error('spawn unavailable'); } });
  await (await h.engine.checkForUpdates()).downloadPromise;
  await assert.rejects(h.engine.quitAndInstall(), /spawn unavailable/);
  await assert.rejects(h.engine.quitAndInstall(), /spawn unavailable/);
  assert.equal(attempts, 2); assert.equal(h.quits(), 0);
});
test('helper asynchronous spawn failure rejects without quitting', async t => {
  const h = await harness(t, { spawnHelper() {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child;
  } });
  await (await h.engine.checkForUpdates()).downloadPromise;
  await assert.rejects(h.engine.quitAndInstall(), /ENOENT/); assert.equal(h.quits(), 0);
});
test('ready handshake precedes commit and app.quit; helper receives JSON not interpolated code', async t => {
  let helperData;
  const h = await harness(t, { spawnHelper(exe, args, opts) {
    assert.equal(args.includes('-Command'), false); assert.ok(args.includes('-ExecutionPolicy'));
    assert.equal(opts.detached, true);
    const child = new EventEmitter(); child.unref = () => {};
    void (async () => {
      helperData = JSON.parse(await readFile(args.at(-1), 'utf8'));
      assert.equal(helperData.target, h.target);
      await writeFile(helperData.ready, 'ready');
    })();
    return child;
  } });
  await (await h.engine.checkForUpdates()).downloadPromise;
  await h.engine.quitAndInstall();
  assert.equal(await readFile(helperData.commit, 'utf8'), 'commit'); assert.equal(h.quits(), 1);
});
test('old and prerelease releases do not download', async t => {
  for (const info of [{ ...release, tag_name: 'v0.2.0' }, { ...release, prerelease: true }]) {
    const h = await harness(t, { transport: async url => { assert.equal(url, FEED); return JSON.stringify(info); } });
    let noUpdate = false; h.engine.on('update-not-available', () => { noUpdate = true; });
    assert.deepEqual(await h.engine.checkForUpdates(), {}); assert.equal(noUpdate, true);
  }
});
test('release duplicate assets and foreign URLs fail before download', async t => {
  for (const assets of [[...release.assets, release.assets[0]], release.assets.map(a => ({ ...a, browser_download_url: 'https://evil.test/' + a.name }))]) {
    const h = await harness(t, { transport: async url => { assert.equal(url, FEED); return JSON.stringify({ ...release, assets }); } });
    await assert.rejects(h.engine.checkForUpdates());
  }
});
test('stream transport enforces size, hash, HTTP failure and redirect allowlist', async t => {
  const original = https.get;
  t.after(() => { https.get = original; });
  let status = 200, headers = {}, bytes = content;
  https.get = (_url, _options, callback) => {
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = error => { if (error) req.emit('error', error); };
    queueMicrotask(() => { const res = Readable.from([bytes]); res.statusCode = status; res.headers = headers; callback(res); });
    return req;
  };
  assert.equal(await transfer(base + 'a', { limit: 100 }), content.toString());
  await assert.rejects(transfer(base + 'a', { limit: 2 }), /quota/);
  await assert.rejects(transfer(base + 'a', { limit: 100, expectedSize: 99 }), /Truncated/);
  await assert.rejects(transfer(base + 'a', { limit: 100, sha256: '0'.repeat(64) }), /SHA256/);
  headers = { 'content-length': '513' };
  await assert.rejects(transfer(base + 'a', { limit: 100 }), /length/);
  headers = {}; status = 404;
  await assert.rejects(transfer(base + 'a', { limit: 100 }), /HTTP 404/);
  status = 302; headers = { location: 'https://evil.test/payload' };
  await assert.rejects(transfer(base + 'a', { limit: 100 }), /Untrusted/);
  headers = { location: base + 'loop' };
  await assert.rejects(transfer(base + 'a', { limit: 100 }), /redirect/);
});
