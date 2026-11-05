'use strict';
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FEED = 'https://api.github.com/repos/quedinhadev/OpenCrosshairQ/releases/latest';
const PREFIX = 'https://github.com/quedinhadev/OpenCrosshairQ/releases/download/';
const FILE = 'OpenCrosshairQ-Portable.exe';
const MAX_BINARY = 512 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;
// Stable SemVer only. BigInt comparisons avoid rounding large legal version components.
function versionParts(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid stable version');
  return value.split('.').map(BigInt);
}
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function allowedURL(value, initial = false) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) throw new Error('Unsafe update URL');
  const github = u.hostname === 'github.com' && u.href.startsWith(PREFIX);
  const cdn = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname);
  if (!(github || (!initial && cdn))) throw new Error('Untrusted update host');
  return u;
}
function validateManifest(data, release, current) {
  if (!data || data.schemaVersion !== 1 || data.file !== FILE || !Number.isSafeInteger(data.size)
    || data.size <= 0 || data.size > MAX_BINARY || typeof data.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.sha256)) throw new Error('Invalid portable manifest');
  if (release.draft || release.prerelease || !newer(data.version, current)
    || ![data.version, `v${data.version}`].includes(release.tag_name)) throw new Error('Release version mismatch');
  return { ...data, sha256: data.sha256.toLowerCase() };
}
// Bounded streaming transport, including redirect bodies, inactivity and total deadline.
async function transfer(url, { limit, destination, expectedSize, sha256, progress = () => {}, api = false }) {
  let request;
  const deadline = setTimeout(() => request?.destroy(new Error('Update deadline exceeded')), 180000);
  const started = Date.now();
  async function visit(value, redirects) {
    if (Date.now() - started > 180000) throw new Error('Update deadline exceeded');
    const u = api && value === FEED ? new URL(value) : allowedURL(value, redirects === 0);
    return new Promise((resolve, reject) => {
      request = https.get(u, { headers: { 'User-Agent': 'OpenCrosshairQ-Portable-Updater', Accept: api ? 'application/vnd.github+json' : 'application/octet-stream' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          if (redirects >= 5 || !response.headers.location) return reject(new Error('Invalid update redirect'));
          let next;
          try { next = new URL(response.headers.location, u).href; allowedURL(next); } catch (e) { return reject(e); }
          visit(next, redirects + 1).then(resolve, reject); return;
        }
        if (response.statusCode !== 200) { response.destroy(); reject(new Error(`Update HTTP ${response.statusCode}`)); return; }
        const length = response.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > limit || (expectedSize !== undefined && Number(length) !== expectedSize))) {
          response.destroy(); reject(new Error('Invalid update length')); return;
        }
        (async () => {
          const chunks = [], hash = crypto.createHash('sha256');
          let count = 0, handle;
          try {
            if (destination) handle = await fsp.open(destination, 'wx', 0o600);
            for await (const chunk of response) {
              count += chunk.length;
              if (count > limit || (expectedSize !== undefined && count > expectedSize)) throw new Error('Update quota exceeded');
              hash.update(chunk);
              if (handle) await handle.writeFile(chunk); else chunks.push(chunk);
              if (expectedSize) progress({ percent: count / expectedSize * 100 });
            }
            if (expectedSize !== undefined && count !== expectedSize) throw new Error('Truncated update');
            if (sha256 && hash.digest('hex') !== sha256) throw new Error('Update SHA256 mismatch');
            if (handle) await handle.sync();
            return destination || Buffer.concat(chunks).toString('utf8');
          } finally { response.destroy(); await handle?.close(); }
        })().then(resolve, reject);
      });
      request.setTimeout(20000, () => request.destroy(new Error('Update request timeout')));
      request.on('error', reject);
    });
  }
  try { return await visit(url, 0); } finally { clearTimeout(deadline); }
}
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function createPortableUpdater({ currentVersion, executable, cacheDir, app, appPid = process.pid,
  transport = transfer, spawnHelper = spawn, readinessTimeout = 60000 }) {
  versionParts(currentVersion);
  if (!path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== '.exe' || path.normalize(executable) !== executable) throw new Error('Invalid portable executable path');
  const engine = new EventEmitter();
  let downloaded = null, installing = false;
  engine.checkForUpdates = async () => {
    engine.emit('checking-for-update');
    const release = JSON.parse(await transport(FEED, { limit: MAX_METADATA, api: true }));
    if (release.draft || release.prerelease) { engine.emit('update-not-available'); return {}; }
    const tag = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (!newer(tag, currentVersion)) { engine.emit('update-not-available'); return {}; }
    if (!Array.isArray(release.assets) || release.assets.length > 100) throw new Error('Invalid release assets');
    function asset(name) {
      const matches = release.assets.filter(item => item.name === name);
      if (matches.length !== 1) throw new Error(`Missing or duplicate ${name}`);
      const item = matches[0];
      allowedURL(item.browser_download_url, true);
      const u = new URL(item.browser_download_url);
      if (u.search || decodeURIComponent(u.pathname.split('/').pop()) !== name
        || decodeURIComponent(u.pathname.split('/').at(-2)) !== release.tag_name) throw new Error('Asset URL mismatch');
      return item;
    }
    const metadata = asset('portable-update.json'), binary = asset(FILE);
    const manifest = validateManifest(JSON.parse(await transport(metadata.browser_download_url, { limit: MAX_METADATA })), release, currentVersion);
    if (binary.size !== manifest.size) throw new Error('Asset size mismatch');
    engine.emit('update-available', { version: manifest.version });
    const downloadPromise = (async () => {
      await fsp.mkdir(cacheDir, { recursive: true });
      const job = await fsp.mkdtemp(path.join(cacheDir, 'download-'));
      const file = path.join(job, FILE);
      try {
        await transport(binary.browser_download_url, { limit: MAX_BINARY, expectedSize: manifest.size,
          sha256: manifest.sha256, destination: file, progress: info => engine.emit('download-progress', info) });
        // Verify even injected/cached transports; never trust completion alone.
        if ((await fsp.stat(file)).size !== manifest.size || await fileHash(file) !== manifest.sha256) throw new Error('Downloaded update verification failed');
        downloaded = { file, manifest, job };
        engine.emit('update-downloaded', { version: manifest.version });
      } catch (error) { await fsp.rm(job, { recursive: true, force: true }); throw error; }
    })();
    return { downloadPromise };
  };
  engine.quitAndInstall = async () => {
    if (!downloaded || installing) throw new Error('Portable update not ready');
    installing = true;
    try {
      const { file, manifest, job } = downloaded;
      if (await fileHash(file) !== manifest.sha256) throw new Error('Cached update SHA256 mismatch');
      const attempt = await fsp.mkdtemp(path.join(job, 'install-'));
      const helper = path.join(attempt, 'helper.ps1');
      await fsp.copyFile(path.join(__dirname, 'portable-update-helper.ps1'), helper);
      const data = { source: file, target: executable, appPid, sha256: manifest.sha256, size: manifest.size,
        ready: path.join(attempt, 'ready'), commit: path.join(attempt, 'commit'), failed: path.join(attempt, 'failed'),
        log: path.join(attempt, 'recovery.log'), backup: `${executable}.${crypto.randomUUID()}.backup` };
      const dataFile = path.join(attempt, 'data.json');
      await fsp.writeFile(dataFile, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await new Promise((resolve, reject) => {
        let child, timer, finished = false;
        const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        try { child = spawnHelper(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-DataFile', dataFile],
          { detached: true, stdio: 'ignore', windowsHide: true }); } catch (error) { finish(error); return; }
        child.once('error', finish);
        child.once('exit', code => { if (!finished) finish(new Error(`Portable helper exited (${code})`)); });
        child.unref();
        const start = Date.now();
        async function poll() {
          try {
            if (fs.existsSync(data.failed)) throw new Error(await fsp.readFile(data.failed, 'utf8'));
            if (fs.existsSync(data.ready)) { finish(); return; }
            if (Date.now() - start > readinessTimeout) throw new Error('Portable helper readiness timeout');
            if (!finished) timer = setTimeout(poll, 100);
          } catch (error) { finish(error); }
        }
        void poll();
      });
      await fsp.writeFile(data.commit, 'commit', { flag: 'wx' });
      app.quit();
    } catch (error) { installing = false; throw error; }
  };
  return engine;
}
module.exports = { createPortableUpdater, validateManifest, newer, allowedURL, transfer, FEED, MAX_BINARY, MAX_METADATA };
