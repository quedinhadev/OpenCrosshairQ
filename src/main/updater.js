// Windows NSIS/Portable lifecycle. No credentials or renderer-controlled download URLs.
// Dependency injection keeps lifecycle/concurrency testable without network/Electron.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15000;

function createUpdater({ currentVersion, supported = false, reason = null, autoUpdater,
  onState = () => {}, prepareInstall = () => {}, cancelInstall = () => {}, logger = console,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  let disposed = false;
  let pending = null;
  let installing = false;
  let initialTimer = null;
  let interval = null;
  let started = false;
  let state = {
    supported, currentVersion, phase: supported ? 'idle' : 'unsupported',
    version: null, progress: null, error: null, reason,
  };
  const listeners = [];
  const getState = () => ({ ...state });
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    onState(getState());
  }
  function report(error) {
    logger.error('[updater]', error?.message || String(error));
    const ready = state.phase === 'downloaded' || state.phase === 'installing';
    if (installing) { installing = false; cancelInstall(); }
    // Never discard a downloaded update on installation failure; allow explicit retry.
    publish({ phase: ready ? 'downloaded' : 'error',
      error: 'Não foi possível atualizar. Verifique sua conexão e tente novamente.' });
  }
  if (supported) {
    if (!autoUpdater) throw new TypeError('autoUpdater obrigatório para atualizações.');
    autoUpdater.autoDownload = true;
    // electron-updater 6.x. Installation must always be an explicit user action.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = logger;
    function listen(event, fn) { autoUpdater.on(event, fn); listeners.push([event, fn]); }
    listen('checking-for-update', () => publish({ phase: 'checking', error: null }));
    listen('update-available', info => publish({ phase: 'available', version: info.version, progress: 0, error: null }));
    listen('update-not-available', () => publish({ phase: 'not-available', version: null, progress: null, error: null }));
    listen('download-progress', info => {
      const percent = Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : 0;
      publish({ phase: 'downloading', progress: Math.round(percent), error: null });
    });
    listen('update-downloaded', info => publish({ phase: 'downloaded', version: info.version, progress: 100, error: null }));
    listen('error', report);
  }
  function check() {
    if (disposed || !supported || installing || state.phase === 'downloaded') return Promise.resolve(getState());
    if (pending) return pending;
    publish({ phase: 'checking', error: null, progress: null });
    pending = Promise.resolve().then(async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        // autoDownload starts a separate promise. Always consume rejection.
        if (result?.downloadPromise) await result.downloadPromise;
      } catch (error) { report(error); }
      return getState();
    }).finally(() => { pending = null; });
    return pending;
  }
  async function install() {
    if (disposed || !supported || installing || state.phase !== 'downloaded') return getState();
    installing = true;
    try {
      // Flush application data before closing windows (quitAndInstall closes them first).
      await prepareInstall();
      publish({ phase: 'installing', error: null });
      await autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      publish({ phase: 'downloaded' });
      report(error);
      installing = false;
    }
    return getState();
  }
  function start() {
    if (disposed || !supported || started) return;
    started = true;
    initialTimer = timers.setTimeout(() => { initialTimer = null; void check(); }, INITIAL_DELAY_MS);
    initialTimer?.unref?.();
    interval = timers.setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    interval?.unref?.();
  }
  function dispose() {
    disposed = true;
    timers.clearTimeout(initialTimer);
    timers.clearInterval(interval);
    for (const [event, fn] of listeners) autoUpdater.removeListener(event, fn);
    // Keep an error sink while an in-flight download settles after shutdown.
    if (pending && autoUpdater) {
      const sink = () => {};
      autoUpdater.on('error', sink);
      void pending.finally(() => autoUpdater.removeListener('error', sink));
    }
  }
  return { getState, check, install, start, dispose };
}

module.exports = { createUpdater, CHECK_INTERVAL_MS, INITIAL_DELAY_MS };
