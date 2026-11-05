'use strict';
/**
 * Safe source/dependency acceptance, NOT installed NSIS acceptance.
 * Run: node --test test/nsis-update-acceptance.cjs
 * Plan only: node test/nsis-update-acceptance.cjs --plan
 * Never executes installers, Electron, builders, registry tools or network requests.
 * Real upgrade requires disposable Windows VM + distinct OS user + snapshot:
 * same appId/productName, baseline 0.1.99, target 0.2.0; inspect registry and profile
 * before/after, quit/relaunch and verify actual packaged version. TEMP /D alone
 * does NOT isolate registry. Do not run these installers on developer host.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const approvedTemp = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode');
const plan = {
  baseline: '0.1.99', target: '0.2.0', appId: pkg.build.appId,
  productName: pkg.build.productName,
  buildStatus: 'NOT EXECUTED: coordinate source snapshot before building; existing dist is stale',
  buildCommands: ['0.1.99', '0.2.0'].map(version =>
    `node node_modules/electron-builder/cli.js --win nsis --x64 --publish never -c.extraMetadata.version=${version} "-c.directories.output=${path.join(approvedTemp, 'nsis-build-REPLACE-WITH-UNIQUE-ID', version)}"`),
  identity: 'Do not override appId/productName/nsis.guid. Baseline uses same approved source snapshot with version override; not a historical 0.1.x compatibility claim.',
  hostInstall: 'BLOCKED: registryAddInstallInfo writes SHELL_CONTEXT even with TEMP /D; same identity may discover/replace existing installation.',
  vmAcceptance: [
    'Use disposable Windows VM snapshot and dedicated OS user; no shared real profile, credentials or installed OpenCrosshairQ.',
    'Build both artifacts from coordinated source snapshot; record source digest, builder/updater versions, artifact SHA512 and embedded package versions.',
    'Install baseline per-user in exclusive LOCALAPPDATA\\Temp\\opencode destination inside VM; preserve same appId/productName. Record child PID and registry snapshot.',
    'Create valid app state/profile fixtures using baseline UI; record exact bytes/hash plus semantic values including false, zero, empty and Unicode. Close app before snapshot.',
    'Serve target only inside VM via dedicated HTTPS generic feed with VM-trusted certificate; bind loopback free port. Never disable TLS verification or publish fake baseline to GitHub.',
    'Use test-only launcher/provider injection without changing production updater; record that provider differs from GitHub. Check/download target; verify SHA512 then explicitly install without UAC.',
    'Record installer exit, relaunched executable path and packaged app.getVersion()=0.2.0; verify profile values and startup state. Reopen to verify persistence; inspect no extra duplicate install.',
    'Exercise offline, wrong SHA512, invalid version, persistence failure and denied installer in separate restored snapshots. Failure must keep baseline runnable and profile intact.',
    'Report per-case PASS/FAIL/SKIP, logs and exact artifacts. Restore/discard VM; do not uninstall host software or clean host registry.'
  ],
  limitations: ['No packaged binary executed', 'No installer executed', 'No feed/TLS/download/signature tested', 'No actual data migration or installed rollback tested']
};
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const { test, after } = require('node:test');
  const { NsisUpdater } = require('electron-updater');
  const { createUpdater } = require('../src/main/updater');
  assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA required for approved evidence directory');
  fs.mkdirSync(approvedTemp, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(approvedTemp, 'nsis-update-acceptance-'));
  const results = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function caseTest(name, fn) {
    test(name, async () => {
      try { await fn(); results.push({ name, status: 'PASS' }); }
      catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); throw error; }
    });
  }
  function engine(version = '0.1.99') {
    const app = { version, name: pkg.name, isPackaged: true, userDataPath: sandbox,
      baseCachePath: sandbox, whenReady: () => Promise.resolve(), onQuit() {},
      quit() { throw new Error('Forbidden real quit'); } };
    const updater = new NsisUpdater(undefined, app);
    updater.logger = logger;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    const calls = [];
    // Always intercept the only execution boundary used by NsisUpdater.doInstall.
    // Never call real quitAndInstall: it requires Electron and schedules app.quit.
    updater.spawnLog = async (file, args) => { calls.push({ file, args }); return true; };
    updater.installDirectory = path.join(sandbox, 'installed');
    updater.downloadedUpdateHelper = {
      file: path.join(sandbox, 'NOT-AN-EXECUTABLE-Setup-0.2.0.exe'),
      packageFile: null, downloadedFileInfo: { isAdminRightsRequired: false }
    };
    return { updater, calls };
  }
  function lifecycle(options = {}) {
    const h = engine();
    // Public lifecycle integration with real BaseUpdater.install and NsisUpdater.doInstall;
    // check/download and Electron quit remain explicit mocks, not network acceptance.
    h.updater.quitAndInstall = (silent, forceRun) => h.updater.install(silent, forceRun);
    h.controller = createUpdater({ currentVersion: '0.1.99', supported: true,
      autoUpdater: h.updater, logger, ...options });
    return h;
  }
  caseTest('NSIS TEMP destination is not registry isolation (source audit)', () => {
    const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');
    const install = fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8');
    const registry = fs.readFileSync(path.join(templates, 'include', 'installer.nsh'), 'utf8');
    assert.match(install, /!insertmacro registryAddInstallInfo/);
    assert.match(registry, /WriteRegStr SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
    assert.match(registry, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" "DisplayVersion"/);
    assert.equal(pkg.build.appId, 'com.opencrosshairq.app');
  });
  caseTest('real electron-updater accepts 0.1.99 to 0.2.0', async () => {
    assert.equal(await engine().updater.isUpdateAvailable({ version: '0.2.0' }), true);
  });
  caseTest('same version is not an update', async () => {
    assert.equal(await engine('0.2.0').updater.isUpdateAvailable({ version: '0.2.0' }), false);
  });
  caseTest('downgrade is blocked', async () => {
    assert.equal(await engine('0.2.0').updater.isUpdateAvailable({ version: '0.1.99' }), false);
  });
  caseTest('invalid, empty, zero and false versions reject', async () => {
    for (const version of ['invalid', '', 0, false]) {
      await assert.rejects(() => engine().updater.isUpdateAvailable({ version }));
    }
  });
  caseTest('real NSIS dispatch uses explicit update flags and exclusive destination, no elevation', async () => {
    const h = engine();
    assert.equal(h.updater.install(false, true), true);
    await tick();
    assert.deepEqual(h.calls, [{ file: h.updater.installerPath,
      args: ['--updated', '--force-run', `/D=${h.updater.installDirectory}`] }]);
    assert.equal(h.updater.install(false, true), false);
    assert.equal(h.calls.length, 1);
  });
  caseTest('missing downloaded installer blocks dispatch', () => {
    const h = engine(); h.updater.downloadedUpdateHelper = null;
    const errors = []; h.updater.on('error', e => errors.push(e));
    assert.equal(h.updater.install(false, true), false);
    assert.equal(h.calls.length, 0); assert.equal(errors.length, 1);
    assert.match(errors[0].message, /No update filepath/);
  });
  caseTest('flush precedes mocked install and fixture bytes remain unchanged (not migration)', async () => {
    const profile = path.join(sandbox, 'profile-fixture.json');
    const bytes = Buffer.from(JSON.stringify({ enabled: false, x: 0, name: '', label: 'Mira ç 漢', profiles: [] }));
    fs.writeFileSync(profile, bytes);
    const digest = () => crypto.createHash('sha512').update(fs.readFileSync(profile)).digest('hex');
    const before = digest(); let flushed = false;
    const h = lifecycle({ prepareInstall() { assert.equal(h.calls.length, 0); flushed = true; } });
    try {
      await h.controller.install(); assert.equal(h.calls.length, 0);
      h.updater.emit('update-downloaded', { version: '0.2.0' });
      await h.controller.install(); await tick();
      assert.equal(flushed, true); assert.equal(h.calls.length, 1);
      assert.equal(digest(), before); assert.deepEqual(fs.readFileSync(profile), bytes);
    } finally { h.controller.dispose(); }
  });
  caseTest('failed persistence blocks dispatch; retry succeeds', async () => {
    let fail = true;
    const h = lifecycle({ prepareInstall() { if (fail) throw new Error('fixture disk full'); } });
    try {
      h.updater.emit('update-downloaded', { version: '0.2.0' });
      await h.controller.install(); assert.equal(h.calls.length, 0);
      assert.equal(h.controller.getState().phase, 'downloaded');
      fail = false; await h.controller.install(); await tick(); assert.equal(h.calls.length, 1);
    } finally { h.controller.dispose(); }
  });
  caseTest('denied dispatch restores lifecycle; no real installer rollback claimed', async () => {
    let restored = 0;
    const h = lifecycle({ cancelInstall() { restored++; } });
    // Non-EACCES code prevents the dependency elevation fallback. All spawn calls mocked anyway.
    h.updater.spawnLog = async () => { throw Object.assign(new Error('mock denial'), { code: 'EPERM' }); };
    try {
      h.updater.emit('update-downloaded', { version: '0.2.0' });
      await h.controller.install(); await tick();
      assert.equal(restored, 1); assert.equal(h.controller.getState().phase, 'downloaded');
      assert.equal(h.calls.length, 0);
    } finally { h.controller.dispose(); }
  });
  caseTest('repeated dispose prevents subsequent lifecycle dispatch', async () => {
    const h = lifecycle(); h.controller.dispose(); h.controller.dispose();
    h.updater.emit('update-downloaded', { version: '0.2.0' });
    await h.controller.install(); assert.equal(h.calls.length, 0);
    assert.equal(h.updater.listenerCount('update-downloaded'), 0);
  });
  after(() => {
    const report = { suite: 'NSIS source/dependency integration only', time: new Date().toISOString(),
      command: 'node --test test/nsis-update-acceptance.cjs', platform: process.platform,
      node: process.version, appVersion: pkg.version,
      electronUpdater: require('electron-updater/package.json').version,
      electronBuilder: require('electron-builder/package.json').version,
      productionSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/main/updater.js'))).digest('hex'),
      sandbox, results, plan, realNSISAcceptance: 'SKIP: host registry cannot be isolated by TEMP destination' };
    const output = path.join(sandbox, 'report.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`Evidence: ${output}`);
    // Preserve this small fixture/report directory as evidence. No child process created.
  });
}
